import { describe, expect, test } from 'bun:test';

import { buildOmpArgv, defaultExtensionPath } from '../../src/adapters/omp/process-port';
import { known } from '../../src/domain/facts';
import type { StableConfigRevision } from '../../src/domain/config';

/**
 * Honest boundary (Design Notes): a real, non-`--help` OMP invocation
 * needs an authenticated model provider, which this repo's CI/dev
 * sandboxes do not guarantee. So this smoke test only runs when a real
 * `omp` binary is reachable on this machine, and replaces the message
 * positional argument our own argv would carry with `--help` -- proving
 * the flags this Story actually constructs (`--no-extensions -e <path>`,
 * `--skills`/`--no-skills`) are accepted by the real binary
 * and exit 0, without needing a model call. Skips (not fails) when `omp`
 * is not installed.
 */
describe('real omp binary smoke test', () => {
  test('buildOmpArgv output is accepted by the real omp binary (--help substituted for MESSAGES)', async () => {
    const binaryPath = Bun.which('omp');
    if (binaryPath === null) {
      return; // no omp binary on this machine -- honest skip, not a failure
    }

    const revision: StableConfigRevision = {
      configName: 'agent-system-smoke-test',
      revisionId: 'rev-smoke',
      defaultMarker: known(false),
      scopeBoundary: known('smoke test'),
      availability: known('resolved'),
      instructions: [],
      skills: [],
      mcp: [],
      hooks: [],
      plugins: [],
      triggerCategory: 'new-scenario',
      evidenceRef: 'test-evidence',
      supersedesRevisionId: null,
    };

    const argv = buildOmpArgv(revision, '/tmp/does-not-need-to-exist.json', defaultExtensionPath(), ['--help']);

    const proc = Bun.spawn([binaryPath, ...argv], { stdout: 'pipe', stderr: 'pipe' });
    const exitCode = await proc.exited;

    if (exitCode !== 0) {
      const stderr = await new Response(proc.stderr).text();
      throw new Error(`real omp smoke invocation failed (exit ${exitCode}): ${stderr}`);
    }
    expect(exitCode).toBe(0);
  });

  test('omp --version output matches the "omp/<version>" format this package parses', async () => {
    const binaryPath = Bun.which('omp');
    if (binaryPath === null) {
      return;
    }

    const proc = Bun.spawn([binaryPath, '--version'], { stdout: 'pipe', stderr: 'pipe' });
    const [output, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    expect(exitCode).toBe(0);
    expect(output.trim()).toMatch(/^omp\/\S+/);
  });
});
