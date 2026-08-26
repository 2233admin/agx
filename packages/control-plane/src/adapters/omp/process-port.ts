import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
// Embedded as text at bundle/compile time (Bun's `with { type: 'text' }`
// import attribute) rather than resolved at runtime via `import.meta.url` +
// `fileURLToPath` -- a runtime filesystem path is meaningless once this
// module is compiled into a standalone `bun build --compile` executable,
// where `import.meta.url` resolves into Bun's embedded virtual filesystem
// and no `extensions/agent-status-extension.ts` file exists on disk next to
// the binary at all (same class of bug as `adapters/sqlite/repository.ts`'s
// migration `.sql` imports). `omp` loads this file as an external process
// via `-e <path>`, so it needs a real on-disk path regardless -- see
// `defaultExtensionPath` below.
import AGENT_STATUS_EXTENSION_MODULE from './extensions/agent-status-extension.ts' with { type: 'text' };
// TypeScript resolves the specifier above to the real module and types it
// as its actual default export (the registration function), ignoring the
// `type: 'text'` attribute -- this cast corrects the compile-time type to
// match the runtime string value without needing a second copy of the source.
const AGENT_STATUS_EXTENSION_SOURCE = AGENT_STATUS_EXTENSION_MODULE as unknown as string;

import { type Fact, known, unknown } from '../../domain/facts';
import type { StableConfigRevision } from '../../domain/config';
import type { OmpProcessPort, OmpSpawnParams, OmpSpawnResult } from '../../application/ports';
import { defaultDbPath } from '../../cli/db-path';

/**
 * Pure argv builder -- exported so tests can assert exact argv contents
 * without spawning a real process. `launchContextPath` is accepted for a
 * consistent call surface but intentionally never embedded in the
 * returned argv: it is delivered to OMP via the `AGENT_SYSTEM_LAUNCH_
 * CONTEXT` env var instead (Design Notes), so it needs no shell-unsafe
 * escaping here regardless of spaces/non-ASCII characters.
 *
 * The configs-launched OMP process deliberately uses OMP's default profile,
 * matching a direct `omp` invocation so the user's existing authentication,
 * sessions, settings, and caches remain available. Configuration selection
 * is represented by the explicit skills/extension arguments, not an OMP
 * profile switch.
 */
export function buildOmpArgv(
  revision: StableConfigRevision,
  launchContextPath: string,
  extensionPath: string | null,
  forwardedArgs: readonly string[],
): string[] {
  void launchContextPath;

  const argv: string[] = [];

  if (extensionPath !== null) {
    // `--no-extensions` disables auto-discovery of the user's own
    // extensions so only the extension file we explicitly pass via `-e`
    // loads -- this is what keeps "current config/status" to a single
    // fact source (Design Notes).
    argv.push('--no-extensions', '-e', extensionPath);
  }

  const skillNames = revision.skills.map((skill) => skill.name);
  if (skillNames.length > 0) {
    argv.push('--skills', skillNames.join(','));
  } else {
    argv.push('--no-skills');
  }

  argv.push(...forwardedArgs);
  return argv;
}

/**
 * Forwarded-arg (`-- <args>`) tokens that would defeat this Story's own
 * safety guarantees if let through to the real `omp` binary -- verified
 * against this machine's real `omp --help` output (18.0.3), matching the
 * Design Notes' "OMP 真实调用面" section:
 *  - extension loading: `-e, --extension=<value>` is documented and
 *    verified repeatable ("Load an extension file (can be used multiple
 *    times"), so a forwarded `-e <path>` would add an *extra* extension
 *    on top of the `--no-extensions -e <thin-extension>` this module
 *    already emits -- breaking the "single fact source" guarantee
 *    (`buildOmpArgv`'s own docstring above).
 *  - profile selection: a forwarded `--profile` would move this launch
 *    away from OMP's default profile, causing it to use a different auth,
 *    session, settings, and cache state than a direct `omp` invocation.
 *  - resume/continue/session-dir: `-c, --continue`, `-r, --resume=<value>`
 *    and `--session-dir=<value>` all let OMP auto-resume a prior session
 *    or redirect where sessions are discovered, breaking "resume 完全不
 *    拦截" (Boundaries & Constraints) that this Story/AD-7/AD-13/AD-19
 *    rely on -- Agent System must never intercept or bias OMP's own
 *    resume UI.
 *
 * This is a narrow, exact-token denylist -- it never inspects, parses or
 * classifies the *content* of a forwarded arg (still forbidden by
 * Boundaries & Constraints), it only rejects a small fixed set of flag
 * spellings that specifically undermine the three guarantees above.
 */
export const DENYLISTED_FORWARDED_ARG_TOKENS: readonly string[] = [
  '-e',
  '--extension',
  '--profile',
  '-c',
  '--continue',
  '-r',
  '--resume',
  '--session-dir',
];

/**
 * Returns the first forwarded arg whose flag token (the part before `=`,
 * for `--flag=value` forms) matches `DENYLISTED_FORWARDED_ARG_TOKENS`, or
 * `null` if none match. Only compares the exact token -- never inspects
 * the value that follows it.
 */
export function findDenylistedForwardedArg(forwardedArgs: readonly string[]): string | null {
  for (const arg of forwardedArgs) {
    const eqIndex = arg.indexOf('=');
    const token = eqIndex === -1 ? arg : arg.slice(0, eqIndex);
    if (DENYLISTED_FORWARDED_ARG_TOKENS.includes(token)) {
      return arg;
    }
  }
  return null;
}


/**
 * Materializes the thin status/switch extension's embedded source onto a
 * real on-disk path and returns that path, so `omp` (a separate process,
 * loading it via `-e <path>`) can always find it -- whether this module is
 * running from source or from inside a `bun build --compile` standalone
 * binary. Writes under the same state root the SQLite database lives under
 * (`cli/db-path.ts`'s convention), overwriting on every call so an upgraded
 * binary's newer extension source always replaces a stale on-disk copy.
 */
export function defaultExtensionPath(): string {
  const dir = path.join(path.dirname(defaultDbPath()), 'extensions');
  mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, 'agent-status-extension.ts');
  writeFileSync(filePath, AGENT_STATUS_EXTENSION_SOURCE, 'utf8');
  return filePath;
}

const OMP_VERSION_PATTERN = /^omp\/(\S+)/;

/**
 * Spawns the real `omp` binary directly via an argv array (`Bun.spawn`) --
 * never through a shell or string-concatenated command line.
 */
export class BunOmpProcessPort implements OmpProcessPort {
  async detectVersion(): Promise<Fact<string>> {
    const binaryPath = Bun.which('omp');
    if (binaryPath === null) {
      return unknown('omp-binary-not-found', new Date().toISOString());
    }

    try {
      const proc = Bun.spawn([binaryPath, '--version'], { stdout: 'pipe', stderr: 'pipe' });
      const [output, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
      if (exitCode !== 0) {
        return unknown(`omp --version exited with code ${exitCode}`, new Date().toISOString());
      }
      const match = OMP_VERSION_PATTERN.exec(output.trim());
      if (match === null || match[1] === undefined) {
        return unknown(`unrecognized omp --version output: ${output.trim()}`, new Date().toISOString());
      }
      return known(match[1]);
    } catch (error) {
      return unknown(`failed to run omp --version: ${(error as Error).message}`, new Date().toISOString());
    }
  }

  async spawn(params: OmpSpawnParams): Promise<OmpSpawnResult> {
    const binaryPath = Bun.which('omp');
    if (binaryPath === null) {
      throw new Error('omp-binary-not-found');
    }

    const argv = [binaryPath, ...buildOmpArgv(params.revision, params.launchContextPath, params.extensionPath, params.forwardedArgs)];
    const proc = Bun.spawn(argv, {
      cwd: params.cwd,
      // Only ever *adds* AGENT_SYSTEM_LAUNCH_CONTEXT on top of the
      // caller's existing environment -- never strips or rewrites
      // anything else (Boundaries & Constraints).
      env: { ...process.env, AGENT_SYSTEM_LAUNCH_CONTEXT: params.launchContextPath },
      stdio: ['inherit', 'inherit', 'inherit'],
    });

    const exitCode = await proc.exited;
    return { exitCode, signal: proc.signalCode ?? null };
  }
}
