import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * The only thing the self-update path persists (Issue #153): *when* the
 * last background check ran, and whether a completed background update is
 * still waiting to be announced to the user. Deliberately not update
 * history and not a product decision -- it exists purely to keep the
 * check off the foreground command's critical path (see
 * `scheduleSelfUpdateCheck` in `cli/index.ts`) while preserving the one
 * visible outcome Story "自更新成功路径打印提示" promised.
 *
 * `lastCheckedAtMs` is stamped by whichever process *starts* a check, not
 * by the one that finishes it -- two `configs` invocations racing at the
 * cooldown boundary must not both spawn a checker.
 *
 * `pendingNoticeVersion` is written only after `replaceBinary` actually
 * succeeded, and is cleared by the first foreground invocation that is
 * itself running that version (i.e. the update is genuinely in effect).
 */
export interface SelfUpdateState {
  readonly lastCheckedAtMs: number | null;
  readonly pendingNoticeVersion: string | null;
}

export const EMPTY_SELF_UPDATE_STATE: SelfUpdateState = {
  lastCheckedAtMs: null,
  pendingNoticeVersion: null,
};

/**
 * One check per day per machine. Unauthenticated GitHub API allows 60
 * requests/hour/IP; the previous "every single invocation" cadence could
 * exhaust that from one busy terminal alone, and an update that lands a
 * few hours later is indistinguishable to the user from one that lands
 * immediately (it only ever takes effect on a later launch either way).
 */
export const SELF_UPDATE_CHECK_COOLDOWN_MS = 24 * 60 * 60 * 1000;

/**
 * Tolerant by design: this file is disposable cache-like state, never a
 * source of truth. Anything unreadable/unparsable/wrong-shaped degrades to
 * `EMPTY_SELF_UPDATE_STATE`, which just means "check again now" -- the
 * safe direction (self-update keeps working) rather than silently freezing
 * updates forever on one bad byte.
 */
export function parseSelfUpdateState(text: string): SelfUpdateState {
  try {
    const data: unknown = JSON.parse(text);
    if (typeof data !== 'object' || data === null) {
      return EMPTY_SELF_UPDATE_STATE;
    }
    const record = data as Record<string, unknown>;
    const lastCheckedAtMs = record.lastCheckedAtMs;
    const pendingNoticeVersion = record.pendingNoticeVersion;
    return {
      lastCheckedAtMs: typeof lastCheckedAtMs === 'number' && Number.isFinite(lastCheckedAtMs) ? lastCheckedAtMs : null,
      pendingNoticeVersion:
        typeof pendingNoticeVersion === 'string' && pendingNoticeVersion.length > 0 ? pendingNoticeVersion : null,
    };
  } catch {
    return EMPTY_SELF_UPDATE_STATE;
  }
}

/** Never throws; a missing or unreadable file is just "no state yet". */
export function readSelfUpdateState(statePath: string): SelfUpdateState {
  try {
    return parseSelfUpdateState(readFileSync(statePath, 'utf8'));
  } catch {
    return EMPTY_SELF_UPDATE_STATE;
  }
}

/**
 * Never throws; returns whether the write actually landed. A failed write
 * only costs one redundant check next launch, so callers do not need to
 * handle it -- but `scheduleSelfUpdateCheck` still reads the result to
 * avoid spawning a checker it could not throttle.
 */
export function writeSelfUpdateState(statePath: string, state: SelfUpdateState): boolean {
  try {
    mkdirSync(dirname(statePath), { recursive: true });
    writeFileSync(statePath, `${JSON.stringify(state)}\n`, 'utf8');
    return true;
  } catch {
    return false;
  }
}

/**
 * `lastCheckedAtMs > nowMs` (clock moved backwards, e.g. a corrected
 * system clock or a state file copied from another machine) counts as due:
 * a future timestamp must not be able to freeze self-update until that
 * time arrives.
 */
export function isCheckDue(state: SelfUpdateState, nowMs: number, cooldownMs: number = SELF_UPDATE_CHECK_COOLDOWN_MS): boolean {
  if (state.lastCheckedAtMs === null) {
    return true;
  }
  if (state.lastCheckedAtMs > nowMs) {
    return true;
  }
  return nowMs - state.lastCheckedAtMs >= cooldownMs;
}
