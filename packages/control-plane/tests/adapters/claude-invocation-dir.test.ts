import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { FsClaudeInvocationDirPort, claudeInvocationRootDir } from '../../src/adapters/system/claude-invocation-dir';

let tmpDir: string;
let dbPath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), 'control-plane-claude-invocation-dir-'));
  dbPath = path.join(tmpDir, 'db.sqlite3');
  process.env.CONTROL_PLANE_DB_PATH = dbPath;
});

afterEach(() => {
  delete process.env.CONTROL_PLANE_DB_PATH;
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('FsClaudeInvocationDirPort', () => {
  test('creates and returns an isolated directory keyed by operationId, nested under claudeInvocationRootDir()', async () => {
    const port = new FsClaudeInvocationDirPort();
    const dir = await port.prepare('op-abc');

    expect(dir).toBe(path.join(claudeInvocationRootDir(), 'op-abc'));
    expect(existsSync(dir)).toBe(true);
    expect(statSync(dir).isDirectory()).toBe(true);
  });

  test('two different operationIds get two distinct directories', async () => {
    const port = new FsClaudeInvocationDirPort();
    const dirA = await port.prepare('op-a');
    const dirB = await port.prepare('op-b');
    expect(dirA).not.toBe(dirB);
    expect(existsSync(dirA)).toBe(true);
    expect(existsSync(dirB)).toBe(true);
  });

  test('calling prepare twice for the same operationId is idempotent (no error, same path)', async () => {
    const port = new FsClaudeInvocationDirPort();
    const first = await port.prepare('op-repeat');
    const second = await port.prepare('op-repeat');
    expect(first).toBe(second);
    expect(existsSync(first)).toBe(true);
  });

  test('claudeInvocationRootDir() never resolves to this repo\'s own root or CWD', () => {
    expect(claudeInvocationRootDir()).not.toBe(process.cwd());
    expect(path.isAbsolute(claudeInvocationRootDir())).toBe(true);
  });
});
