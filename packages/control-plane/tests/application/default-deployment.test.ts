import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDefaultDeploymentDependencies } from '../../src/adapters/deployment/default-dependencies';

test('default deployment assembly wires typed preflight/apply/status ports without invoking remotes', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'configs-default-deps-'));
  const calls: string[] = [];
  try {
    const deps = createDefaultDeploymentDependencies({ dbPath: path.join(root, 'state.sqlite3'), cwd: root, sourceRoot: root, commands: {
      repository: { run: async () => { calls.push('repository'); return { stdout: '', exitCode: 0 }; } },
      git: { run: async () => { calls.push('git'); return { stdout: '', exitCode: 0 }; } },
      project: { run: async () => { calls.push('project'); return { stdout: '', exitCode: 0 }; } },
      codex: { available: async () => false, run: async () => ({ stdout: '', exitCode: null }) },
      claude: { available: async () => false, run: async () => ({ stdout: '', exitCode: null }) },
      multica: { available: async () => false, run: async (_args, _signal) => ({ stdout: '', exitCode: null }) },
    } });
    expect(deps.preflight).toBeDefined(); expect(deps.apply).toBeDefined(); expect(deps.status).toBeDefined(); expect(calls).toEqual([]);
    deps.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('default assembly requires explicit absolute cwd and source root', () => {
  expect(() => createDefaultDeploymentDependencies({ dbPath: 'state.sqlite3', cwd: 'relative', sourceRoot: 'relative' })).toThrow('absolute');
});
