import path from 'node:path';
import { buildChildEnvironment } from '../system/process-environment';
import type { MulticaCommandPort } from '../../application/ports';

type SpawnedProcess = { readonly stdout: ReadableStream<Uint8Array> | string; readonly stderr: ReadableStream<Uint8Array> | string; readonly exited: Promise<number>; kill(): void };
export type MulticaSpawn = (argv: readonly string[], options: { readonly cwd: string; readonly env: Readonly<Record<string, string>> }) => SpawnedProcess;
export interface MulticaCommandPortOptions { readonly binary?: string; readonly cwd?: string; readonly timeoutMs?: number; readonly spawn?: MulticaSpawn; readonly which?: (binary: string) => string | null; }
export type MulticaCommandPortFactoryOptions = Pick<MulticaCommandPortOptions, 'cwd' | 'timeoutMs' | 'spawn' | 'which'>;

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_BYTES = 64 * 1024;
function defaultSpawn(argv: readonly string[], options: { readonly cwd: string; readonly env: Readonly<Record<string, string>> }): SpawnedProcess { return Bun.spawn([...argv], { cwd: options.cwd, env: options.env, stdout: 'pipe', stderr: 'pipe' }) as unknown as SpawnedProcess; }
async function boundedText(value: ReadableStream<Uint8Array> | string): Promise<{ readonly text: string; readonly truncated: boolean }> { const output = typeof value === 'string' ? value : await new Response(value).text(); return { text: output.slice(0, MAX_OUTPUT_BYTES), truncated: output.length > MAX_OUTPUT_BYTES }; }
function factoryOptions(options: MulticaCommandPortFactoryOptions): MulticaCommandPortOptions { if (options.cwd === undefined || !path.isAbsolute(options.cwd)) throw new Error('Multica command cwd must be an absolute path'); return { binary: 'multica', cwd: options.cwd, timeoutMs: options.timeoutMs, spawn: options.spawn, which: options.which }; }

export class BunMulticaCommandPort implements MulticaCommandPort {
  private readonly binary: string; private readonly cwd: string; private readonly timeoutMs: number; private readonly spawn: MulticaSpawn; private readonly which: (binary: string) => string | null;
  constructor(options: MulticaCommandPortOptions = {}) { this.binary = options.binary ?? 'multica'; this.cwd = options.cwd ?? process.cwd(); this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS; this.spawn = options.spawn ?? defaultSpawn; this.which = options.which ?? ((binary) => Bun.which(binary)); }
  async available(signal?: AbortSignal): Promise<boolean> { return !signal?.aborted && this.which(this.binary) !== null; }
  async run(args: readonly string[], signal?: AbortSignal): Promise<{ readonly stdout: string; readonly stderr?: string; readonly exitCode: number | null }> {
    if (signal?.aborted) return { stdout: '', stderr: 'command-cancelled', exitCode: null };
    if (this.which(this.binary) === null) return { stdout: '', stderr: 'binary-not-found', exitCode: null };
    if (args.some((arg) => arg.includes('\0'))) return { stdout: '', stderr: 'invalid-argv', exitCode: null };
    let proc: SpawnedProcess;
    try { proc = this.spawn([this.binary, ...args], { cwd: this.cwd, env: buildChildEnvironment({}) }); } catch { return { stdout: '', stderr: 'command-spawn-failed', exitCode: null }; }
    let timedOut = false; let cancelled = false;
    const termination = Promise.withResolvers<number | null>();
    const timer = setTimeout(() => { timedOut = true; proc.kill(); termination.resolve(null); }, this.timeoutMs);
    const abort = () => { cancelled = true; proc.kill(); termination.resolve(null); };
    signal?.addEventListener('abort', abort, { once: true });
    try {
      const [stdout, stderr, exitCode] = await Promise.all([Promise.race([boundedText(proc.stdout), termination.promise.then(() => ({ text: '', truncated: true }))]), Promise.race([boundedText(proc.stderr), termination.promise.then(() => ({ text: '', truncated: true }))]), Promise.race([proc.exited, termination.promise])]);
      const diagnostic = timedOut ? 'command-timeout' : cancelled ? 'command-cancelled' : stderr.truncated ? 'command-output-truncated' : stderr.text.length > 0 ? 'command-stderr' : '';
      return { stdout: stdout.text, stderr: diagnostic, exitCode: timedOut || cancelled ? null : exitCode };
    } catch { return { stdout: '', stderr: 'command-failed', exitCode: null }; } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
  }
}
export function createMulticaCommandPort(options: MulticaCommandPortFactoryOptions = {}): MulticaCommandPort { return new BunMulticaCommandPort(factoryOptions(options)); }
