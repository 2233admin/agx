import type { GithubProjectCommandPort, GithubRepositoryCommandPort, GithubRepositoryGitPort } from '../../application/ports';

type SpawnedProcess = { readonly stdout: ReadableStream<Uint8Array> | string; readonly stderr: ReadableStream<Uint8Array> | string; readonly exited: Promise<number>; kill(): void };
export type GithubSpawn = (argv: readonly string[], options: { readonly cwd: string; readonly env: Readonly<Record<string, string>> }) => SpawnedProcess;
export interface GithubCommandPortOptions { readonly binary?: string; readonly cwd?: string; readonly timeoutMs?: number; readonly command?: readonly string[]; readonly spawn?: GithubSpawn; }

const DEFAULT_TIMEOUT_MS = 30_000;
const ENV_KEYS = ['PATH', 'GH_HOST'] as const;
function environment(): Record<string, string> { const env: Record<string, string> = {}; for (const key of ENV_KEYS) if (process.env[key] !== undefined) env[key] = process.env[key]!; return env; }
function defaultSpawn(argv: readonly string[], options: { readonly cwd: string; readonly env: Readonly<Record<string, string>> }): SpawnedProcess { return Bun.spawn([...argv], { cwd: options.cwd, env: options.env, stdout: 'pipe', stderr: 'pipe' }) as unknown as SpawnedProcess; }
function text(value: ReadableStream<Uint8Array> | string): Promise<string> { return typeof value === 'string' ? Promise.resolve(value) : new Response(value).text(); }

export class BunGithubCommandPort implements GithubRepositoryCommandPort, GithubRepositoryGitPort, GithubProjectCommandPort {
  private readonly command: readonly string[];
  private readonly cwd: string;
  private readonly timeoutMs: number;
  private readonly spawn: GithubSpawn;
  constructor(options: GithubCommandPortOptions = {}) { this.command = options.command ?? [options.binary ?? 'gh']; this.cwd = options.cwd ?? process.cwd(); this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS; this.spawn = options.spawn ?? defaultSpawn; }
  async run(args: readonly string[], signal?: AbortSignal): Promise<{ readonly stdout: string; readonly stderr: string; readonly exitCode: number | null }> {
    if (args.some((arg) => arg.includes('\0')) || this.command.some((arg) => arg.includes('\0'))) return { stdout: '', stderr: 'invalid argv', exitCode: null };
    const proc = this.spawn([...this.command, ...args], { cwd: this.cwd, env: environment() });
    let timedOut = false; let cancelled = signal?.aborted ?? false; let resolveTermination!: (code: number | null) => void;
    const termination = new Promise<number | null>((resolve) => { resolveTermination = resolve; });
    const timer = setTimeout(() => { timedOut = true; proc.kill(); resolveTermination(null); }, this.timeoutMs);
    const abort = () => { cancelled = true; proc.kill(); resolveTermination(null); };
    signal?.addEventListener('abort', abort, { once: true });
    try {
      const [stdout, stderr, exitCode] = await Promise.all([text(proc.stdout), text(proc.stderr), Promise.race([proc.exited, termination])]);
      const marker = timedOut ? 'timeout' : cancelled ? 'cancelled' : '';
      return { stdout, stderr: marker === '' ? stderr : `${stderr}${marker}`, exitCode: timedOut || cancelled ? null : exitCode };
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
  }
}

export function createGithubRepositoryCommandPort(options: GithubCommandPortOptions = {}): GithubRepositoryCommandPort { return new BunGithubCommandPort({ ...options, command: options.command ?? [options.binary ?? 'gh'] }); }
export function createGithubRepositoryGitPort(options: GithubCommandPortOptions = {}): GithubRepositoryGitPort { return new BunGithubCommandPort({ ...options, command: options.command ?? [options.binary ?? 'git'] }); }
export function createGithubProjectCommandPort(options: GithubCommandPortOptions = {}): GithubProjectCommandPort { return new BunGithubCommandPort({ ...options, command: options.command ?? [options.binary ?? 'gh'] }); }
