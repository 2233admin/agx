import path from 'node:path';
import type { GithubProjectCommandPort, GithubRepositoryCommandPort, GithubRepositoryGitPort } from '../../application/ports';

type SpawnedProcess = { readonly stdout: ReadableStream<Uint8Array> | string; readonly stderr: ReadableStream<Uint8Array> | string; readonly exited: Promise<number>; kill(): void };
export type GithubSpawn = (argv: readonly string[], options: { readonly cwd: string; readonly env: Readonly<Record<string, string>> }) => SpawnedProcess;
export interface GithubCommandPortOptions { readonly binary?: string; readonly cwd?: string; readonly timeoutMs?: number; readonly command?: readonly string[]; readonly spawn?: GithubSpawn; }
export type GithubCommandPortFactoryOptions = Pick<GithubCommandPortOptions, 'cwd' | 'timeoutMs' | 'spawn'>;

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_BYTES = 64 * 1024;
const ENV_KEYS = ['PATH', 'GH_HOST'] as const;
function environment(): Record<string, string> { const env: Record<string, string> = {}; for (const key of ENV_KEYS) if (process.env[key] !== undefined) env[key] = process.env[key]!; return env; }
function defaultSpawn(argv: readonly string[], options: { readonly cwd: string; readonly env: Readonly<Record<string, string>> }): SpawnedProcess { return Bun.spawn([...argv], { cwd: options.cwd, env: options.env, stdout: 'pipe', stderr: 'pipe' }) as unknown as SpawnedProcess; }
type ReadResult = { readonly text: string; readonly truncated: boolean };
async function readBounded(value: ReadableStream<Uint8Array> | string): Promise<ReadResult> {
  const text = typeof value === 'string' ? value : await new Response(value).text();
  return { text: text.slice(0, MAX_OUTPUT_BYTES), truncated: text.length > MAX_OUTPUT_BYTES };
}
function fixedFactory(binary: 'gh' | 'git', options: GithubCommandPortFactoryOptions = {}): GithubCommandPortOptions {
  if (options.cwd === undefined || !path.isAbsolute(options.cwd)) throw new Error('GitHub command cwd must be an absolute path');
  return { cwd: options.cwd, timeoutMs: options.timeoutMs, spawn: options.spawn, command: [binary] };
}

export class BunGithubCommandPort implements GithubRepositoryCommandPort, GithubRepositoryGitPort, GithubProjectCommandPort {
  private readonly command: readonly string[];
  private readonly cwd: string;
  private readonly timeoutMs: number;
  private readonly spawn: GithubSpawn;
  constructor(options: GithubCommandPortOptions = {}) { this.command = options.command ?? [options.binary ?? 'gh']; this.cwd = options.cwd ?? process.cwd(); this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS; this.spawn = options.spawn ?? defaultSpawn; }
  async run(args: readonly string[], signal?: AbortSignal): Promise<{ readonly stdout: string; readonly stderr: string; readonly exitCode: number | null }> {
    if (signal?.aborted) return { stdout: '', stderr: 'command-cancelled', exitCode: null };
    if (args.some((arg) => arg.includes('\0')) || this.command.some((arg) => arg.includes('\0'))) return { stdout: '', stderr: 'invalid-argv', exitCode: null };
    let proc: SpawnedProcess;
    try { proc = this.spawn([...this.command, ...args], { cwd: this.cwd, env: environment() }); } catch { return { stdout: '', stderr: 'command-spawn-failed', exitCode: null }; }
    let timedOut = false; let cancelled = false; let resolveTermination!: (code: number | null) => void;
    const termination = new Promise<number | null>((resolve) => { resolveTermination = resolve; });
    const timer = setTimeout(() => { timedOut = true; proc.kill(); resolveTermination(null); }, this.timeoutMs);
    const abort = () => { cancelled = true; proc.kill(); resolveTermination(null); };
    signal?.addEventListener('abort', abort, { once: true });
    try {
      const [stdoutResult, stderrResult, exitCode] = await Promise.all([Promise.race([readBounded(proc.stdout), termination.then(() => ({ text: '', truncated: true }))]), Promise.race([readBounded(proc.stderr), termination.then(() => ({ text: '', truncated: true }))]), Promise.race([proc.exited, termination])]);
      const diagnostic = timedOut ? 'command-timeout' : cancelled ? 'command-cancelled' : stderrResult.truncated ? 'command-output-truncated' : stderrResult.text.length > 0 ? 'command-stderr' : '';
      return { stdout: stdoutResult.text, stderr: diagnostic, exitCode: timedOut || cancelled ? null : exitCode };
    } catch { return { stdout: '', stderr: 'command-failed', exitCode: null }; } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
  }
}

export function createGithubRepositoryCommandPort(options: GithubCommandPortFactoryOptions = {}): GithubRepositoryCommandPort { return new BunGithubCommandPort(fixedFactory('gh', options)); }
export function createGithubRepositoryGitPort(options: GithubCommandPortFactoryOptions = {}): GithubRepositoryGitPort { return new BunGithubCommandPort(fixedFactory('git', options)); }
export function createGithubProjectCommandPort(options: GithubCommandPortFactoryOptions = {}): GithubProjectCommandPort { return new BunGithubCommandPort(fixedFactory('gh', options)); }
