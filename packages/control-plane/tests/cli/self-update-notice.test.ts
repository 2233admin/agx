import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { reportPendingSelfUpdateNotice } from '../../src/cli/index';
import { readSelfUpdateState, type SelfUpdateState } from '../../src/adapters/self-update/check-state';

/**
 * `reportPendingSelfUpdateNotice` is the print-decision pulled out of the
 * `import.meta.main` block in `src/cli/index.ts` -- that block never runs
 * under `bun test` (see `tests/cli/version.test.ts`'s comment on `main()`
 * being called directly instead), so this is the only place these
 * scenarios get direct coverage.
 *
 * Since Issue #153 the notice no longer comes from an inline
 * `checkAndApply` result: the background checker records the version it
 * installed into the state file, and this function announces it on the
 * first foreground invocation that is actually running that version.
 */
describe('reportPendingSelfUpdateNotice', () => {
  let originalLang: string | undefined;
  let originalLog: typeof console.log;
  let logged: string[];
  let tempDir: string;
  let statePath: string;

  const writeState = (state: SelfUpdateState): void => {
    writeFileSync(statePath, JSON.stringify(state), 'utf8');
  };

  beforeEach(() => {
    originalLang = process.env.CONFIGS_LANG;
    process.env.CONFIGS_LANG = 'en';
    originalLog = console.log;
    logged = [];
    console.log = (...args: unknown[]) => {
      logged.push(args.join(' '));
    };
    tempDir = mkdtempSync(join(tmpdir(), 'configs-self-update-notice-'));
    statePath = join(tempDir, 'self-update.json');
  });

  afterEach(() => {
    console.log = originalLog;
    if (originalLang === undefined) {
      delete process.env.CONFIGS_LANG;
    } else {
      process.env.CONFIGS_LANG = originalLang;
    }
    rmSync(tempDir, { recursive: true, force: true });
  });

  test('pending version equals the running version: prints exactly one line and clears the pending notice', () => {
    writeState({ lastCheckedAtMs: 1_000, pendingNoticeVersion: '1.1.0' });

    reportPendingSelfUpdateNotice({ statePath, currentVersion: '1.1.0', argv: ['list'] });

    expect(logged).toEqual(['configs: updated to v1.1.0 (now in effect)']);
    // Cleared, so the notice is announced once and not on every later
    // invocation -- and `lastCheckedAtMs` is preserved, so clearing the
    // notice does not also reset the check cooldown.
    expect(readSelfUpdateState(statePath)).toEqual({ lastCheckedAtMs: 1_000, pendingNoticeVersion: null });
  });

  test('no pending notice: never prints and never rewrites the state file', () => {
    writeState({ lastCheckedAtMs: 1_000, pendingNoticeVersion: null });
    const before = readFileSync(statePath, 'utf8');

    reportPendingSelfUpdateNotice({ statePath, currentVersion: '1.1.0', argv: ['list'] });
    reportPendingSelfUpdateNotice({ statePath, currentVersion: '1.1.0', argv: [] });

    expect(logged).toEqual([]);
    expect(readFileSync(statePath, 'utf8')).toBe(before);
  });

  test('a missing state file (nothing ever checked yet) is not an error and prints nothing', () => {
    reportPendingSelfUpdateNotice({ statePath, currentVersion: '1.1.0', argv: ['list'] });

    expect(logged).toEqual([]);
  });

  test('pending version differs from the running version: stays pending for a later launch, prints nothing', () => {
    // The replacement landed while this older process was already running,
    // so announcing it now would be a lie -- this process is still 1.0.0.
    writeState({ lastCheckedAtMs: 1_000, pendingNoticeVersion: '1.1.0' });

    reportPendingSelfUpdateNotice({ statePath, currentVersion: '1.0.0', argv: ['list'] });

    expect(logged).toEqual([]);
    expect(readSelfUpdateState(statePath).pendingNoticeVersion).toBe('1.1.0');
  });

  test('argv[0] is "--version": suppresses the line so the single-bare-version-line contract stays intact, and keeps it pending', () => {
    writeState({ lastCheckedAtMs: 1_000, pendingNoticeVersion: '1.1.0' });

    reportPendingSelfUpdateNotice({ statePath, currentVersion: '1.1.0', argv: ['--version'] });

    expect(logged).toEqual([]);
    // Not dropped: the next ordinary subcommand still announces it.
    expect(readSelfUpdateState(statePath).pendingNoticeVersion).toBe('1.1.0');
  });

  test('a throwing console.log (e.g. EPIPE) is swallowed silently -- never propagates', () => {
    writeState({ lastCheckedAtMs: 1_000, pendingNoticeVersion: '1.1.0' });
    console.log = () => {
      throw new Error('EPIPE');
    };

    expect(() => reportPendingSelfUpdateNotice({ statePath, currentVersion: '1.1.0', argv: ['list'] })).not.toThrow();
  });
});
