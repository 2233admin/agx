import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SELF_UPDATE_WORKER_ARG, runSelfUpdateWorker, scheduleSelfUpdateCheck } from '../../src/cli/index';
import { SELF_UPDATE_CHECK_COOLDOWN_MS, readSelfUpdateState } from '../../src/adapters/self-update/check-state';
import { defaultSelfUpdateStatePath } from '../../src/cli/self-update-state-path';
import type { SelfUpdatePort } from '../../src/application/ports';

/**
 * Issue #153: the foreground command must never pay for the GitHub round
 * trip. `scheduleSelfUpdateCheck` is the whole foreground half -- it only
 * touches one small local file and hands the network work to a detached
 * child process -- and `runSelfUpdateWorker` is that child's whole job.
 */

class FakeSelfUpdatePort implements SelfUpdatePort {
  calls: string[] = [];

  constructor(private readonly result: string | null) {}

  async checkAndApply(currentVersion: string): Promise<string | null> {
    this.calls.push(currentVersion);
    return this.result;
  }
}

let tempDir: string;
let statePath: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'configs-self-update-schedule-'));
  statePath = join(tempDir, 'self-update.json');
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe('scheduleSelfUpdateCheck', () => {
  test('never checked before: starts the worker and stamps the check time before doing so', () => {
    let spawned = 0;

    const started = scheduleSelfUpdateCheck({
      statePath,
      nowMs: 5_000,
      spawnWorker: () => {
        // The stamp must already be on disk when the child starts, so a
        // second invocation racing this one cannot also spawn a checker.
        expect(readSelfUpdateState(statePath).lastCheckedAtMs).toBe(5_000);
        spawned += 1;
      },
    });

    expect(started).toBe(true);
    expect(spawned).toBe(1);
    expect(readSelfUpdateState(statePath)).toEqual({ lastCheckedAtMs: 5_000, pendingNoticeVersion: null });
  });

  test('inside the cooldown window: starts nothing and leaves the state file untouched', () => {
    writeFileSync(statePath, JSON.stringify({ lastCheckedAtMs: 1_000, pendingNoticeVersion: null }), 'utf8');
    const before = readFileSync(statePath, 'utf8');
    let spawned = 0;

    const started = scheduleSelfUpdateCheck({
      statePath,
      nowMs: 1_000 + SELF_UPDATE_CHECK_COOLDOWN_MS - 1,
      spawnWorker: () => {
        spawned += 1;
      },
    });

    expect(started).toBe(false);
    expect(spawned).toBe(0);
    expect(readFileSync(statePath, 'utf8')).toBe(before);
  });

  test('exactly at the cooldown boundary: checks again', () => {
    writeFileSync(statePath, JSON.stringify({ lastCheckedAtMs: 1_000, pendingNoticeVersion: null }), 'utf8');

    const started = scheduleSelfUpdateCheck({
      statePath,
      nowMs: 1_000 + SELF_UPDATE_CHECK_COOLDOWN_MS,
      spawnWorker: () => {},
    });

    expect(started).toBe(true);
  });

  test('a pending notice survives the scheduling write -- stamping the check time must not swallow it', () => {
    writeFileSync(statePath, JSON.stringify({ lastCheckedAtMs: null, pendingNoticeVersion: '1.1.0' }), 'utf8');

    scheduleSelfUpdateCheck({ statePath, nowMs: 9_000, spawnWorker: () => {} });

    expect(readSelfUpdateState(statePath)).toEqual({ lastCheckedAtMs: 9_000, pendingNoticeVersion: '1.1.0' });
  });

  test('a spawn that throws is swallowed -- self-update scheduling never affects the invoked command', () => {
    let started: boolean | undefined;

    expect(() => {
      started = scheduleSelfUpdateCheck({
        statePath,
        nowMs: 5_000,
        spawnWorker: () => {
          throw new Error('spawn failed');
        },
      });
    }).not.toThrow();
    expect(started).toBe(false);
  });

  test('an unwritable state path starts nothing: an unthrottleable check is worse than a skipped one', () => {
    let spawned = 0;
    // A path whose parent is an existing *file*, so `mkdir`/`writeFile`
    // both fail on every platform.
    const blockedPath = join(statePath, 'nested', 'self-update.json');
    writeFileSync(statePath, '{}', 'utf8');

    const started = scheduleSelfUpdateCheck({
      statePath: blockedPath,
      nowMs: 5_000,
      spawnWorker: () => {
        spawned += 1;
      },
    });

    expect(started).toBe(false);
    expect(spawned).toBe(0);
  });
});

describe('runSelfUpdateWorker', () => {
  test('an applied update is recorded as a pending notice for the next foreground invocation', async () => {
    const updater = new FakeSelfUpdatePort('1.1.0');

    await runSelfUpdateWorker({ statePath, currentVersion: '1.0.0', nowMs: 7_000, updater });

    expect(updater.calls).toEqual(['1.0.0']);
    expect(readSelfUpdateState(statePath)).toEqual({ lastCheckedAtMs: 7_000, pendingNoticeVersion: '1.1.0' });
  });

  test('no update available: refreshes the check time and leaves any earlier pending notice alone', async () => {
    writeFileSync(statePath, JSON.stringify({ lastCheckedAtMs: 1_000, pendingNoticeVersion: '1.1.0' }), 'utf8');

    await runSelfUpdateWorker({ statePath, currentVersion: '1.0.0', nowMs: 7_000, updater: new FakeSelfUpdatePort(null) });

    expect(readSelfUpdateState(statePath)).toEqual({ lastCheckedAtMs: 7_000, pendingNoticeVersion: '1.1.0' });
  });

  test('a throwing updater is swallowed -- the worker never crashes', async () => {
    const throwing: SelfUpdatePort = {
      checkAndApply: async () => {
        throw new Error('network exploded');
      },
    };

    await runSelfUpdateWorker({ statePath, currentVersion: '1.0.0', nowMs: 7_000, updater: throwing });

    // Nothing was written, so the next invocation simply checks again.
    expect(readSelfUpdateState(statePath)).toEqual({ lastCheckedAtMs: null, pendingNoticeVersion: null });
  });
});

describe('self-update wiring constants', () => {
  test('the worker marker is a flag-shaped argv token, so it can never collide with a config id argument', () => {
    expect(SELF_UPDATE_WORKER_ARG.startsWith('--')).toBe(true);
  });

  test('the state file defaults under the same $HOME/.agent-system-state root as the database, and is env-overridable', () => {
    const original = process.env.CONFIGS_SELF_UPDATE_STATE_PATH;
    try {
      delete process.env.CONFIGS_SELF_UPDATE_STATE_PATH;
      expect(defaultSelfUpdateStatePath().replaceAll('\\', '/')).toEndWith('/.agent-system-state/control-plane/self-update.json');

      process.env.CONFIGS_SELF_UPDATE_STATE_PATH = statePath;
      expect(defaultSelfUpdateStatePath()).toBe(statePath);
    } finally {
      if (original === undefined) {
        delete process.env.CONFIGS_SELF_UPDATE_STATE_PATH;
      } else {
        process.env.CONFIGS_SELF_UPDATE_STATE_PATH = original;
      }
    }
  });
});
