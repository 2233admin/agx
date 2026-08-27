import path from 'node:path';
import { buildChildEnvironment } from '../system/process-environment';
import type { ClaudeProviderCommandPort, CodexProviderCommandPort, ProviderCommandResult } from '../../application/ports';

type SpawnedProcess = { readonly stdout: ReadableStream<Uint8Array> | string; readonly stderr: ReadableStream<Uint8Array> | string; readonly exited: Promise<number>; kill(): void };
export type ProviderSpawn = (argv: readonly string[], options: { readonly cwd: string; readonly env: Readonly<Record<string, string>> }) => SpawnedProcess;
export interface ProviderCommandPortOptions { readonly binary?: string; readonly cwd?: string; readonly timeoutMs?: number; readonly spawn?: ProviderSpawn; readonly which?: (binary: string) => string | null; }
export type ProviderCommandFactoryOptions = Pick<ProviderCommandPortOptions, 'cwd' | 'timeoutMs' | 'spawn' | 'which'>;

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_BYTES = 64 * 1024;
function defaultSpawn(argv: readonly string[], options: { readonly cwd: string; readonly env: Readonly<Record<string, string>> }): SpawnedProcess { return Bun.spawn([...argv], { cwd: options.cwd, env: options.env, stdout: 'pipe', stderr: 'pipe' }) as unknown as SpawnedProcess; }
async function boundedText(value: ReadableStream<Uint8Array> | string): Promise<string> { const output = typeof value === 'string' ? value : await new Response(value).text(); return output.slice(0, MAX_OUTPUT_BYTES); }
function fixedFactory(binary: 'codex' | 'claude', options: ProviderCommandFactoryOptions = {}): ProviderCommandPortOptions { if (options.cwd === undefined || !path.isAbsolute(options.cwd)) throw new Error('provider command cwd must be an absolute path'); return { binary, cwd: options.cwd, timeoutMs: options.timeoutMs, spawn: options.spawn, which: options.which }; }

export class BunProviderCommandPort implements CodexProviderCommandPort, ClaudeProviderCommandPort {
  private readonly binary: string;
  private readonly cwd: string;
  private readonly timeoutMs: number;
  private readonly spawn: ProviderSpawn;
  private readonly which: (binary: string) => string | null;
  constructor(options: ProviderCommandPortOptions = {}) { this.binary = options.binary ?? 'codex'; this.cwd = options.cwd ?? process.cwd(); this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS; this.spawn = options.spawn ?? defaultSpawn; this.which = options.which ?? ((binary) => Bun.which(binary)); }
  async available(signal?: AbortSignal): Promise<boolean> { return !signal?.aborted && this.which(this.binary) !== null; }
  async run(args: readonly string[], signal?: AbortSignal): Promise<ProviderCommandResult & { readonly stderr: string }> {
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
      const [stdout, stderr, exitCode] = await Promise.all([Promise.race([boundedText(proc.stdout), termination.promise.then(() => '')]), Promise.race([boundedText(proc.stderr), termination.promise.then(() => '')]), Promise.race([proc.exited, termination.promise])]);
      const diagnostic = timedOut ? 'command-timeout' : cancelled ? 'command-cancelled' : stderr.length > 0 ? 'command-stderr' : '';
      return { stdout, stderr: diagnostic, exitCode: timedOut || cancelled ? null : exitCode };
    } catch { return { stdout: '', stderr: 'command-failed', exitCode: null }; } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
  }
}
export function createCodexProviderCommandPort(options: ProviderCommandFactoryOptions = {}): CodexProviderCommandPort { return new BunProviderCommandPort(fixedFactory('codex', options)); }
export function createClaudeProviderCommandPort(options: ProviderCommandFactoryOptions = {}): ClaudeProviderCommandPort { return new BunProviderCommandPort(fixedFactory('claude', options)); }
