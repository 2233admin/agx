import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { FsClaudeLaunchContextWriter, claudeLaunchContextDir } from '../../src/adapters/launch-context/fs-claude-launch-context-writer';
import { launchContextDir } from '../../src/adapters/launch-context/fs-launch-context-writer';
import type { ClaudeLaunchContext } from '../../src/application/ports';

let tmpDir: string;
let dbPath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), 'control-plane-claude-launch-context-'));
  dbPath = path.join(tmpDir, 'db.sqlite3');
  process.env.CONTROL_PLANE_DB_PATH = dbPath;
});

afterEach(() => {
  delete process.env.CONTROL_PLANE_DB_PATH;
  rmSync(tmpDir, { recursive: true, force: true });
});

function context(overrides: Partial<ClaudeLaunchContext> = {}): ClaudeLaunchContext {
  return {
    version: 1,
    planId: 'plan-1',
    operationId: 'op-1',
    revisionId: 'rev-1',
    configName: 'general',
    client: 'claude-code',
    launchTarget: 'fresh',
    launchedAt: '2026-01-01T00:00:00Z',
    applyResult: 'applied',
    knownDifferences: [],
    adapterPlanHash: 'cadp_test',
    ...overrides,
  };
}

describe('FsClaudeLaunchContextWriter', () => {
  test('writes a JSON file named after planId under claudeLaunchContextDir()', async () => {
    const writer = new FsClaudeLaunchContextWriter();
    const filePath = await writer.write(context({ planId: 'plan-xyz' }));

    expect(filePath).toBe(path.join(claudeLaunchContextDir(), 'plan-xyz.json'));
    expect(existsSync(filePath)).toBe(true);
    const parsed = JSON.parse(readFileSync(filePath, 'utf8'));
    expect(parsed.planId).toBe('plan-xyz');
    expect(parsed.client).toBe('claude-code');
    expect(parsed.launchTarget).toBe('fresh');
  });

  test('claudeLaunchContextDir() is a distinct sibling of OMP\'s launchContextDir() -- no shared/colliding directory', () => {
    expect(claudeLaunchContextDir()).not.toBe(launchContextDir());
    expect(path.dirname(claudeLaunchContextDir())).toBe(path.dirname(launchContextDir()));
  });

  test('overwrites an existing file for the same planId rather than erroring', async () => {
    const writer = new FsClaudeLaunchContextWriter();
    await writer.write(context({ planId: 'plan-repeat', knownDifferences: ['a'] }));
    const filePath = await writer.write(context({ planId: 'plan-repeat', knownDifferences: ['a', 'b'] }));

    const parsed = JSON.parse(readFileSync(filePath, 'utf8'));
    expect(parsed.knownDifferences).toEqual(['a', 'b']);
  });
});
