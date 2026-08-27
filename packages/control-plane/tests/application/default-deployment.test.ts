import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDefaultDeploymentDependencies, createDefaultDeploymentPreflightDependencies } from '../../src/adapters/deployment/default-dependencies';
import { FsGithubRepositorySourcePort } from '../../src/adapters/github/repository';

test('default deployment assembly wires typed preflight/apply/status ports without invoking remotes', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'configs-default-deps-'));
  const calls: string[] = [];
  try {
    const deps = createDefaultDeploymentDependencies({ dbPath: path.join(root, 'state.sqlite3'), cwd: root, sourceRoot: root, commands: {
      repository: { run: async () => { calls.push('repository'); return { stdout: '', exitCode: 0 }; } },
      git: { run: async () => { calls.push('git'); return { stdout: '', exitCode: 0 }; } },
      project: { run: async () => { calls.push('project'); return { stdout: '', exitCode: 0 }; } },
      codex: { available: async () => false, run: async () => ({ stdout: '', exitCode: null }) },
      claude: { available: async () => false, run: async () => ({ stdout: '', exitCode: null }) },
      multica: { available: async () => false, run: async (_args: readonly string[], _signal?: AbortSignal) => ({ stdout: '', exitCode: null }) },
    } });
    expect(deps.preflight).toBeDefined(); expect(deps.apply).toBeDefined(); expect(deps.readonlyStatus).toBeDefined(); expect(calls).toEqual([]);
    expect(await deps.preflight.providers.inspect()).toEqual({ kind: 'inconclusive', reason: 'provider-selection-required' });
    deps.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('default assembly enforces the configured source root through the source port', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'configs-source-root-'));
  const outside = mkdtempSync(path.join(os.tmpdir(), 'configs-source-outside-'));
  try {
    const source = new FsGithubRepositorySourcePort({ run: async () => { throw new Error('git must not run'); } }, root);
    expect(await source.validate(outside)).toEqual({ kind: 'invalid', reason: 'source-path-outside-source-root' });
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});
test('readonly preflight dependencies do not create a missing database', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'configs-readonly-preflight-'));
  const dbPath = path.join(root, 'missing', 'state.sqlite3');
  try {
    expect(() => createDefaultDeploymentPreflightDependencies({ dbPath, cwd: root, sourceRoot: root })).toThrow();
    expect(existsSync(dbPath)).toBe(false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('default assembly requires explicit absolute cwd and source root', () => {
  expect(() => createDefaultDeploymentDependencies({ dbPath: 'state.sqlite3', cwd: 'relative', sourceRoot: 'relative' })).toThrow('absolute');
});
