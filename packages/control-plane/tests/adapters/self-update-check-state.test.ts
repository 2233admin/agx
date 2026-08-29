import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  EMPTY_SELF_UPDATE_STATE,
  SELF_UPDATE_CHECK_COOLDOWN_MS,
  isCheckDue,
  parseSelfUpdateState,
  readSelfUpdateState,
  writeSelfUpdateState,
} from '../../src/adapters/self-update/check-state';

/**
 * The scheduling state introduced by Issue #153. It is disposable
 * cache-like state, never a source of truth -- every unreadable or
 * malformed shape must degrade to "no state yet" (i.e. check again now)
 * rather than to a state that silently freezes self-update forever.
 */

let tempDir: string;
let statePath: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'configs-self-update-state-'));
  statePath = join(tempDir, 'self-update.json');
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe('parseSelfUpdateState', () => {
  test('reads both fields from a well-formed object', () => {
    expect(parseSelfUpdateState('{"lastCheckedAtMs":1234,"pendingNoticeVersion":"1.2.3"}')).toEqual({
      lastCheckedAtMs: 1234,
      pendingNoticeVersion: '1.2.3',
    });
  });

  test('malformed JSON, non-objects and JSON null all degrade to the empty state', () => {
    expect(parseSelfUpdateState('')).toEqual(EMPTY_SELF_UPDATE_STATE);
    expect(parseSelfUpdateState('not json at all')).toEqual(EMPTY_SELF_UPDATE_STATE);
    expect(parseSelfUpdateState('null')).toEqual(EMPTY_SELF_UPDATE_STATE);
    expect(parseSelfUpdateState('[1,2,3]')).toEqual(EMPTY_SELF_UPDATE_STATE);
    expect(parseSelfUpdateState('"a string"')).toEqual(EMPTY_SELF_UPDATE_STATE);
  });

  test('wrong-typed or non-finite fields are dropped individually, not fatally', () => {
    expect(parseSelfUpdateState('{"lastCheckedAtMs":"soon","pendingNoticeVersion":"1.2.3"}')).toEqual({
      lastCheckedAtMs: null,
      pendingNoticeVersion: '1.2.3',
    });
    expect(parseSelfUpdateState('{"lastCheckedAtMs":1234,"pendingNoticeVersion":42}')).toEqual({
      lastCheckedAtMs: 1234,
      pendingNoticeVersion: null,
    });
    // `JSON.stringify(Infinity)` produces `null`, but a hand-edited file can
    // still carry anything -- an unusable number must not be treated as a
    // real timestamp.
    expect(parseSelfUpdateState('{"lastCheckedAtMs":1e999}')).toEqual(EMPTY_SELF_UPDATE_STATE);
    expect(parseSelfUpdateState('{"pendingNoticeVersion":""}')).toEqual(EMPTY_SELF_UPDATE_STATE);
  });
});

describe('readSelfUpdateState / writeSelfUpdateState', () => {
  test('round-trips through the file, creating parent directories on the way', () => {
    const nestedPath = join(tempDir, 'created', 'by', 'write', 'self-update.json');

    expect(writeSelfUpdateState(nestedPath, { lastCheckedAtMs: 42, pendingNoticeVersion: '2.0.0' })).toBe(true);
    expect(readSelfUpdateState(nestedPath)).toEqual({ lastCheckedAtMs: 42, pendingNoticeVersion: '2.0.0' });
  });

  test('a missing file reads as the empty state instead of throwing', () => {
    expect(readSelfUpdateState(join(tempDir, 'never-written.json'))).toEqual(EMPTY_SELF_UPDATE_STATE);
  });

  test('a corrupt file reads as the empty state instead of throwing', () => {
    writeFileSync(statePath, '{ this is not json', 'utf8');

    expect(readSelfUpdateState(statePath)).toEqual(EMPTY_SELF_UPDATE_STATE);
  });

  test('an unwritable path reports false rather than throwing', () => {
    writeFileSync(statePath, '{}', 'utf8');
    // Parent is an existing file, so the directory creation cannot succeed.
    expect(writeSelfUpdateState(join(statePath, 'nested.json'), EMPTY_SELF_UPDATE_STATE)).toBe(false);
  });

  test('writes exactly one JSON line (a hand-inspectable file, not an append log)', () => {
    writeSelfUpdateState(statePath, { lastCheckedAtMs: 42, pendingNoticeVersion: null });
    writeSelfUpdateState(statePath, { lastCheckedAtMs: 43, pendingNoticeVersion: null });

    expect(readFileSync(statePath, 'utf8')).toBe('{"lastCheckedAtMs":43,"pendingNoticeVersion":null}\n');
  });
});

describe('isCheckDue', () => {
  test('nothing recorded yet: due', () => {
    expect(isCheckDue(EMPTY_SELF_UPDATE_STATE, 1_000)).toBe(true);
  });

  test('one check per cooldown window (default: 24h)', () => {
    const state = { lastCheckedAtMs: 1_000, pendingNoticeVersion: null };

    expect(SELF_UPDATE_CHECK_COOLDOWN_MS).toBe(24 * 60 * 60 * 1000);
    expect(isCheckDue(state, 1_000)).toBe(false);
    expect(isCheckDue(state, 1_000 + SELF_UPDATE_CHECK_COOLDOWN_MS - 1)).toBe(false);
    expect(isCheckDue(state, 1_000 + SELF_UPDATE_CHECK_COOLDOWN_MS)).toBe(true);
  });

  test('an explicit cooldown overrides the default', () => {
    const state = { lastCheckedAtMs: 1_000, pendingNoticeVersion: null };

    expect(isCheckDue(state, 1_500, 1_000)).toBe(false);
    expect(isCheckDue(state, 2_000, 1_000)).toBe(true);
  });

  test('a timestamp in the future is due: a wrong clock (or a copied state file) must not freeze self-update', () => {
    expect(isCheckDue({ lastCheckedAtMs: 9_999_999, pendingNoticeVersion: null }, 1_000)).toBe(true);
  });
});
