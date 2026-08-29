import type { MulticaCommandPort, MulticaRuntimePort } from '../../application/ports';
import type { MulticaReadbackResult, MulticaRuntime, MulticaSubject } from '../../domain/multica';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const OFFLINE_STATUSES = new Set(['offline', 'stopped', 'terminated']);

type RuntimeRow = { readonly id: string; readonly name: string; readonly status: string };

function duplicateKeysOrMalformed(value: string): boolean {
  let index = 0;
  const whitespace = () => { while (/\s/.test(value[index] ?? '')) index += 1; };
  const stringValue = (): string | null => {
    if (value[index] !== '"') return null;
    const start = index++;
    while (index < value.length) {
      if (value[index] === '\\') index += 2;
      else if (value[index++] === '"') {
        try { return JSON.parse(value.slice(start, index)) as string; } catch { return null; }
      }
    }
    return null;
  };
  const parseValue = (): boolean => {
    whitespace();
    if (value[index] === '{') {
      index += 1; whitespace(); const keys = new Set<string>();
      if (value[index] === '}') { index += 1; return true; }
      while (index < value.length) {
        const key = stringValue();
        if (key === null || keys.has(key)) return false;
        keys.add(key); whitespace(); if (value[index++] !== ':' || !parseValue()) return false;
        whitespace(); if (value[index] === '}') { index += 1; return true; }
        if (value[index++] !== ',') return false; whitespace();
      }
      return false;
    }
    if (value[index] === '[') {
      index += 1; whitespace(); if (value[index] === ']') { index += 1; return true; }
      while (index < value.length) {
        if (!parseValue()) return false;
        whitespace(); if (value[index] === ']') { index += 1; return true; }
        if (value[index++] !== ',') return false; whitespace();
      }
      return false;
    }
    if (value[index] === '"') return stringValue() !== null;
    const literal = /^(?:-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?|true|false|null)/.exec(value.slice(index));
    if (literal === null) return false;
    index += literal[0].length; return true;
  };
  if (!parseValue()) return true;
  whitespace(); return index !== value.length;
}

function parseJson(value: string): unknown | null {
  if (duplicateKeysOrMalformed(value)) return null;
  try { return JSON.parse(value); } catch { return null; }
}

function onlyKeys(record: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(record).every((key) => allowed.has(key));
}

function parseRows(value: unknown): readonly RuntimeRow[] | null {
  let rows: unknown;
  if (Array.isArray(value)) rows = value;
  else if (value !== null && typeof value === 'object' && onlyKeys(value as Record<string, unknown>, ['runtimes'])) rows = (value as Record<string, unknown>).runtimes;
  else return null;
  if (!Array.isArray(rows)) return null;
  const parsed: RuntimeRow[] = [];
  for (const row of rows) {
    if (row === null || typeof row !== 'object') return null;
    const record = row as Record<string, unknown>;
    if (!onlyKeys(record, ['id', 'name', 'status']) || typeof record.id !== 'string' || record.id.trim() === '' ||
        typeof record.name !== 'string' || record.name.trim() === '' || typeof record.status !== 'string' || record.status.trim() === '') return null;
    parsed.push({ id: record.id, name: record.name, status: record.status });
  }
  return parsed;
}

function validateSubject(subject: MulticaSubject): boolean {
  return subject !== null && typeof subject === 'object' && UUID.test(subject.id) &&
    (subject.kind === 'workspace' || subject.kind === 'runtime' || subject.kind === 'agent');
}

function toRuntime(row: RuntimeRow): MulticaRuntime | null {
  if (row.status !== 'online' && !OFFLINE_STATUSES.has(row.status)) return null;
  return { id: row.id, name: row.name, status: row.status === 'online' ? 'online' : 'offline' };
}

type BoundedCommandResult =
  | { readonly kind: 'response'; readonly response: { readonly stdout: string; readonly exitCode: number | null } }
  | { readonly kind: 'timeout' }
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'error' };

async function runBounded(
  command: MulticaCommandPort,
  args: readonly string[],
  timeoutMs: number,
  outerSignal?: AbortSignal,
): Promise<BoundedCommandResult> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const timeout = new Promise<BoundedCommandResult>((resolve) => {
    timer = setTimeout(() => resolve({ kind: 'timeout' }), timeoutMs);
  });
  const cancelled = new Promise<BoundedCommandResult>((resolve) => {
    onAbort = () => resolve({ kind: 'cancelled' });
    if (outerSignal?.aborted) onAbort();
    else outerSignal?.addEventListener('abort', onAbort, { once: true });
  });
  const running = command.run(args, controller.signal)
    .then((response) => ({ kind: 'response', response }) as const)
    .catch(() => ({ kind: 'error' }) as const);
  const result = await Promise.race([running, timeout, cancelled]);
  if (result.kind !== 'response') controller.abort();
  clearTimeout(timer);
  if (outerSignal !== undefined && onAbort !== undefined) outerSignal.removeEventListener('abort', onAbort);
  return result;
}

type AvailabilityResult = 'available' | 'unavailable' | 'timeout' | 'cancelled' | 'error';

async function probeAvailability(command: MulticaCommandPort, timeoutMs: number, outerSignal?: AbortSignal): Promise<AvailabilityResult> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const timeout = new Promise<AvailabilityResult>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), timeoutMs);
  });
  const cancelled = new Promise<AvailabilityResult>((resolve) => {
    onAbort = () => resolve('cancelled');
    if (outerSignal?.aborted) onAbort();
    else outerSignal?.addEventListener('abort', onAbort, { once: true });
  });
  const running: Promise<AvailabilityResult> = command.available(controller.signal)
    .then((available): AvailabilityResult => available ? 'available' : 'unavailable')
    .catch((): AvailabilityResult => 'error');
  const result = await Promise.race([running, timeout, cancelled]);
  if (result !== 'available' && result !== 'unavailable') controller.abort();
  clearTimeout(timer);
  if (outerSignal !== undefined && onAbort !== undefined) outerSignal.removeEventListener('abort', onAbort);
  return result;
}

export class MulticaCliAdapter implements MulticaRuntimePort {
  constructor(
    private readonly command: MulticaCommandPort,
    private readonly timeoutMs: number = 5_000,
  ) {}

  async readback(subject: MulticaSubject, signal?: AbortSignal): Promise<MulticaReadbackResult> {
    if (!validateSubject(subject)) return { kind: 'inconclusive', subject, reason: 'invalid-subject' };
    if (subject.kind !== 'runtime') return { kind: 'inconclusive', subject, reason: 'subject-kind-not-observed' };
    try {
      const availability = await probeAvailability(this.command, this.timeoutMs, signal);
      if (availability === 'timeout') return { kind: 'inconclusive', subject, reason: 'multica-timeout' };
      if (availability === 'cancelled') return { kind: 'inconclusive', subject, reason: 'multica-cancelled' };
      if (availability === 'error') return { kind: 'inconclusive', subject, reason: 'multica-command-inconclusive' };
      if (availability === 'unavailable') return { kind: 'inconclusive', subject, reason: 'multica-cli-unavailable' };
      const bounded = await runBounded(this.command, ['runtime', 'list', '--output', 'json'], this.timeoutMs, signal);
      if (bounded.kind === 'timeout') return { kind: 'inconclusive', subject, reason: 'multica-timeout' };
      if (bounded.kind === 'cancelled') return { kind: 'inconclusive', subject, reason: 'multica-cancelled' };
      if (bounded.kind === 'error') return { kind: 'inconclusive', subject, reason: 'multica-command-inconclusive' };
      if (bounded.response.exitCode !== 0) return { kind: 'inconclusive', subject, reason: 'multica-command-inconclusive' };
      const rows = parseRows(parseJson(bounded.response.stdout));
      if (rows === null) return { kind: 'inconclusive', subject, reason: 'multica-output-inconclusive' };
      const matches = rows.filter((row) => row.id === subject.id);
      if (matches.length === 0) return { kind: 'absent', subject };
      if (matches.length > 1) return { kind: 'ambiguous', subject, matchCount: matches.length };
      const match = matches[0];
      if (match === undefined) return { kind: 'inconclusive', subject, reason: 'multica-output-inconclusive' };
      const runtime = toRuntime(match);
      if (runtime === null) return { kind: 'inconclusive', subject, reason: 'unknown-runtime-status' };
      if (runtime.status !== 'online') return { kind: 'offline', subject, status: match.status };
      return { kind: 'observed', subject, runtime };
    } catch {
      return { kind: 'inconclusive', subject, reason: 'multica-command-inconclusive' };
    }
  }
}
