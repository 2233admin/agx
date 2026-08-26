/**
 * Semantic ANSI color wrapping for the pure-text CLI path. Colors are
 * always additive information -- `shouldColor()` gates every wrapper so
 * that with `NO_COLOR` set (any value) or `stdout` not a TTY, nothing here
 * ever emits an escape sequence and every wrapped string degrades back to
 * plain, fully-readable text (DESIGN.md "颜色永远是叠加信息").
 *
 * `shouldColor()` reads `NO_COLOR`/`process.stdout.isTTY` fresh on every
 * call rather than caching -- tests flip both within a single process to
 * assert different branches (Design Notes: spec-cli-ux-delta.md).
 *
 * Exactly four semantic roles (success/degraded/failure/attention) plus
 * two non-phase helpers (neutral -- implicit, i.e. unwrapped -- and dim).
 * No other color is ever introduced (Boundaries & Constraints: "语义色只
 * 有四个角色...不新增颜色").
 */

import type { LaunchPhase } from '../domain/activation';

const RESET = '\x1b[0m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RED = '\x1b[31m';
const DIM = '\x1b[2m';

/**
 * `ink`'s `<Text color="...">` prop takes a chalk-style color *name*, not
 * an ANSI escape sequence, so the TUI (`tui.tsx`) cannot reuse the `wrap()`
 * -based helpers below directly. This is the single source of truth for
 * "which named color each semantic role maps to" that both the ANSI
 * wrappers here and the TUI's `color` props read from, so the two never
 * drift independently out of sync.
 */
export const ROLE_COLOR_NAMES = {
  success: 'green',
  degraded: 'yellow',
  attention: 'yellow',
  failure: 'red',
} as const;

export function shouldColor(): boolean {
  if (process.env.NO_COLOR !== undefined) {
    return false;
  }
  return process.stdout.isTTY === true;
}

function wrap(code: string, text: string): string {
  return shouldColor() ? `${code}${text}${RESET}` : text;
}

/** `succeeded`. Never used anywhere else. */
export function success(text: string): string {
  return wrap(GREEN, text);
}

/** `degraded` -- same value as `attention`, distinct semantic role. */
export function degraded(text: string): string {
  return wrap(YELLOW, text);
}

/** `requires-restart`, `cancelled`, and "Known differences" section titles. */
export function attention(text: string): string {
  return wrap(YELLOW, text);
}

/** `failed`/`incomplete` -- reserved for outcomes the user did not choose. */
export function failure(text: string): string {
  return wrap(RED, text);
}

/** Secondary, non-load-bearing text: ids, prompts, recovery hints, the handoff line. */
export function dim(text: string): string {
  return wrap(DIM, text);
}

/**
 * Maps a `LaunchPlan.phase` (EXPERIENCE.md State Patterns table) to the
 * semantic color wrapper for that phase. In-flight phases (`prepared`,
 * `awaiting-confirmation`, `applying`, `observing`) are neutral -- returned
 * unwrapped -- because a phase is never colored before it settles.
 */
export function colorForPhase(phase: LaunchPhase, text: string): string {
  switch (phase) {
    case 'succeeded':
      return success(text);
    case 'degraded':
      return degraded(text);
    case 'failed':
    case 'incomplete':
      return failure(text);
    case 'cancelled':
    case 'requires-restart':
      return attention(text);
    default:
      return text;
  }
}
