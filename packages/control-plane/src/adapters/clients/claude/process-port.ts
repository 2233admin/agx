import { type Fact, known, unknown } from '../../../domain/facts';
import type { ClaudeProcessPort, ClaudeSpawnParams, ClaudeSpawnResult } from '../../../application/ports';

/**
 * `claude --version` prints e.g. `2.1.241 (Claude Code)` -- captured and
 * verified against a real install on this machine (see this Story's Design
 * Notes). Mirrors `adapters/omp/process-port.ts`'s `OMP_VERSION_PATTERN`:
 * fail closed to `unknown` on any output that does not match, rather than
 * guessing at a substring.
 */
const CLAUDE_VERSION_PATTERN = /^(\S+)\s*\(Claude Code\)$/;

/** `Bun.spawn` never resolves on a hung/interactive child; bound the wait. */
const DEFAULT_TIMEOUT_MS = 10_000;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The narrow slice of `Bun.Subprocess` this adapter actually uses --
 * `stdout`/`stderr` accept either a `ReadableStream` (the real `Bun.spawn`
 * shape) or a plain `string` (so tests can inject a fake process backed by
 * a fixture string), with no cast needed at either the real or fake call
 * site; `new Response(...)` accepts both.
 */
export interface ClaudeSpawnedProcess {
  readonly stdout: string | ReadableStream<Uint8Array>;
  readonly stderr: string | ReadableStream<Uint8Array>;
  readonly exited: Promise<number>;
  kill(): void;
}

/** Injectable in place of the real `Bun.spawn` call, for deterministic tests. */
export type ClaudeSpawnFn = (argv: readonly string[]) => ClaudeSpawnedProcess;

/** Injectable in place of the real `Bun.which` call, for deterministic tests. */
export type ClaudeWhichFn = (binary: string) => string | null;

function defaultSpawn(argv: readonly string[]): ClaudeSpawnedProcess {
  const proc = Bun.spawn([...argv], { stdout: 'pipe', stderr: 'pipe' });
  return proc as unknown as ClaudeSpawnedProcess;
}

/**
 * `[Story 4.3]` The narrow slice of `Bun.Subprocess` `spawn()` actually
 * uses -- deliberately a *different*, narrower shape than
 * `ClaudeSpawnedProcess` (no `stdout`/`stderr`/`kill()`): a fresh-target
 * launch hands full interactive stdio control to the child (`stdio:
 * ['inherit','inherit','inherit']`), so there is no pipe to read here, and
 * it is never killed early by a timeout (Design Notes on `ClaudeProcessPort`
 * in `application/ports.ts`). `signalCode` mirrors Bun's own live property:
 * safe to read any time, meaningful once `exited` has resolved.
 */
export interface ClaudeInteractiveProcess {
  readonly exited: Promise<number>;
  readonly signalCode: string | null;
}

/** Injectable in place of the real interactive `Bun.spawn` call, for deterministic tests. */
export type ClaudeInteractiveSpawnFn = (
  argv: readonly string[],
  options: { readonly cwd: string; readonly env: Readonly<Record<string, string>> },
) => ClaudeInteractiveProcess;

function defaultInteractiveSpawn(
  argv: readonly string[],
  options: { readonly cwd: string; readonly env: Readonly<Record<string, string>> },
): ClaudeInteractiveProcess {
  const proc = Bun.spawn([...argv], {
    cwd: options.cwd,
    // Only ever *adds* the caller's requested keys on top of the current
    // process's own environment -- never strips or rewrites anything else
    // (same non-destructive convention as `BunOmpProcessPort.spawn`).
    env: { ...process.env, ...options.env },
    stdio: ['inherit', 'inherit', 'inherit'],
  });
  return proc as unknown as ClaudeInteractiveProcess;
}

type RunResult = { readonly ok: true; readonly stdout: string } | { readonly ok: false; readonly reason: string };

/**
 * Spawns the real `claude` binary directly via an argv array (`Bun.spawn`)
 * -- never through a shell or string-concatenated command line. This is the
 * only place the Claude Code adapter starts or inspects the binary; see
 * `capability-probe.ts` for how the raw `--help` text this returns gets
 * interpreted into capability findings.
 *
 * `spawnFn`/`whichFn`/`timeoutMs` are constructor-injectable (defaulting to
 * the real `Bun.spawn`/`Bun.which` and a 10s bound) so tests can exercise
 * the non-zero-exit, unparsable-output, thrown-spawn-error and timeout
 * branches deterministically -- without depending on a real `claude`
 * install being present (which CI does not guarantee).
 */
export class BunClaudeProcessPort implements ClaudeProcessPort {
  constructor(
    private readonly spawnFn: ClaudeSpawnFn = defaultSpawn,
    private readonly whichFn: ClaudeWhichFn = (binary) => Bun.which(binary),
    private readonly timeoutMs: number = DEFAULT_TIMEOUT_MS,
    private readonly interactiveSpawnFn: ClaudeInteractiveSpawnFn = defaultInteractiveSpawn,
  ) {}

  /**
   * Runs `claude <argv>`, draining both stdout and stderr concurrently
   * (an unread `stderr: 'pipe'` can backpressure-stall a child that writes
   * to it) and bounding the wait with `timeoutMs` (a hung/interactive
   * child, e.g. an unexpected trust prompt, must fail closed to `unknown`
   * rather than hang the caller forever).
   */
  private async runClaudeCommand(argv: readonly string[]): Promise<RunResult> {
    const binaryPath = this.whichFn('claude');
    if (binaryPath === null) {
      return { ok: false, reason: 'claude-binary-not-found' };
    }

    let proc: ClaudeSpawnedProcess;
    try {
      proc = this.spawnFn([binaryPath, ...argv]);
    } catch (error) {
      return { ok: false, reason: `failed to spawn claude ${argv.join(' ')}: ${errorMessage(error)}` };
    }

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        proc.kill();
      } catch {
        // Best-effort: the process may already have exited.
      }
    }, this.timeoutMs);

    try {
      const [stdout, , exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);

      if (timedOut) {
        return { ok: false, reason: `claude ${argv.join(' ')} timed out after ${this.timeoutMs}ms` };
      }
      if (exitCode !== 0) {
        return { ok: false, reason: `claude ${argv.join(' ')} exited with code ${exitCode}` };
      }
      if (stdout.trim().length === 0) {
        return { ok: false, reason: `empty claude ${argv.join(' ')} output` };
      }
      return { ok: true, stdout };
    } catch (error) {
      return { ok: false, reason: `failed to run claude ${argv.join(' ')}: ${errorMessage(error)}` };
    } finally {
      clearTimeout(timer);
    }
  }

  async detectVersion(): Promise<Fact<string>> {
    const result = await this.runClaudeCommand(['--version']);
    if (!result.ok) {
      return unknown(result.reason, new Date().toISOString());
    }
    const trimmed = result.stdout.trim();
    const match = CLAUDE_VERSION_PATTERN.exec(trimmed);
    if (match === null || match[1] === undefined) {
      return unknown(`unrecognized claude --version output: ${trimmed}`, new Date().toISOString());
    }
    return known(match[1]);
  }

  async captureHelpText(args: readonly string[]): Promise<Fact<string>> {
    const result = await this.runClaudeCommand([...args, '--help']);
    if (!result.ok) {
      return unknown(result.reason, new Date().toISOString());
    }
    return known(result.stdout);
  }

  /**
   * `[Story 4.3]` Spawns the real `claude` binary directly via an argv
   * array (never a shell), hands it full interactive stdio control, and
   * resolves once it exits -- mirrors `BunOmpProcessPort.spawn`. Unlike
   * `runClaudeCommand`, this is never subject to `timeoutMs`: a real
   * interactive Claude Code session is expected to keep running until the
   * user ends it.
   */
  async spawn(params: ClaudeSpawnParams): Promise<ClaudeSpawnResult> {
    const binaryPath = this.whichFn('claude');
    if (binaryPath === null) {
      throw new Error('claude-binary-not-found');
    }

    const proc = this.interactiveSpawnFn([binaryPath, ...params.argv], { cwd: params.cwd, env: params.env });
    const exitCode = await proc.exited;
    return { exitCode, signal: proc.signalCode ?? null };
  }
}
