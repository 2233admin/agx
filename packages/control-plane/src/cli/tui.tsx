/**
 * `[DELTA]` Interactive TUI entry point (EXPERIENCE.md IA third layer,
 * DESIGN.md's `[DELTA]` components). Two screens -- `list`/`detail` --
 * built with `ink`. Reuses the exact same underlying operations as the
 * pure-text CLI path (`listConfigRevisions`, `prepareLaunchPlan`,
 * `confirmLaunchPlan`, `launchOmp`, `getLaunchStatus`) so the domain state
 * machine and its invariants are never bypassed or reimplemented here.
 *
 * `TuiApp` is a presentational component only -- it never talks to a
 * repository or spawns anything itself. It reports the user's decision
 * ("launch this revision" / "quit") via callback props, which keeps it
 * directly testable with `ink-testing-library` (Code Map:
 * `tests/cli/tui.test.tsx`). All of the imperative work -- opening
 * dependencies, entering/exiting the alt-screen, driving
 * `prepareLaunchPlan`/`confirmLaunchPlan`/`launchOmp`, and printing the
 * handoff line/final status -- lives in `runTui()`.
 *
 * Selection state (`inverse`/`color` props) is left entirely to `ink`
 * (itself built on `chalk`), which already does its own `NO_COLOR`/TTY
 * capability detection -- `colors.ts` is not reused inside the TUI screens
 * themselves (Design Notes).
 */

import React, { useState } from 'react';
import { EventEmitter } from 'node:events';
import { Box, render, Text, useInput } from 'ink';

import type { StableConfigRevision } from '../domain/config';
import { computeKnownDifferences, confirmLaunchPlan, getLaunchStatus, launchOmp, prepareLaunchPlan, type LaunchDeps } from '../application/launch';
import { listConfigRevisions } from '../application/queries';
import { defaultExtensionPath } from '../adapters/omp/process-port';
import { ROLE_COLOR_NAMES } from './colors';
import { t } from './i18n';
import { formatAvailability, formatDefaultMarker, renderDetail, renderHandoffLine, renderLaunchFailure, renderLaunchStatus } from './render';
import { CONFIGS_VERSION } from './version';
import { openDeps, type CliOverrides, type FullDeps } from './index';
const TUI_DIAGNOSTICS_ENABLED = process.env.CONFIGS_TUI_DEBUG === '1';

function debugTui(stage: string, details: Record<string, unknown> = {}): void {
  if (!TUI_DIAGNOSTICS_ENABLED) {
    return;
  }
  try {
    process.stderr.write(
      `[configs-tui] ${JSON.stringify({
        stage,
        ...details,
        version: CONFIGS_VERSION,
        executable: process.execPath,
        argv: process.argv,
        platform: process.platform,
        stdinIsTTY: process.stdin.isTTY === true,
        stdoutIsTTY: process.stdout.isTTY === true,
      })}\n`,
    );
  } catch {
    // Diagnostics must never change TUI behavior.
  }
}

function stdinListenerCounts(source: NodeJS.ReadStream): Record<string, number> {
  return {
    data: source.listenerCount('data'),
    readable: source.listenerCount('readable'),
    end: source.listenerCount('end'),
    close: source.listenerCount('close'),
    error: source.listenerCount('error'),
  };
}

debugTui('module-loaded', { stdinListeners: stdinListenerCounts(process.stdin) });


const ALT_SCREEN_ENTER = '\x1b[?1049h';
const ALT_SCREEN_EXIT = '\x1b[?1049l';

function enterAltScreen(): void {
  process.stdout.write(ALT_SCREEN_ENTER);
}

function exitAltScreen(): void {
  process.stdout.write(ALT_SCREEN_EXIT);
}

/**
 * Ink's production renderer consumes a `readable`/`read()` stream, while Bun
 * Windows console streams can deliver raw keyboard bytes through `data`
 * without notifying `readable`. Bun also requires raw mode before the data
 * listener is attached. Bridge the source's data events into the contract
 * Ink actually consumes and own that bootstrap cleanup around Ink's lifecycle.
 */
class TuiStdinBridge extends EventEmitter {
  readonly isTTY: boolean;
  private readonly bootstrapRawMode: boolean;
  // Bun/Orca can reset the console input mode when setRawMode(true) is
  // repeated. The bridge enables raw mode before attaching data, so make
  // Ink's second enable call idempotent.
  private rawModeEnabled = false;
  private readonly chunks: Array<string | Buffer> = [];
  private rawModeRearmTimer: ReturnType<typeof setTimeout> | undefined;
  private rawModeRearmAttempted = false;
  private firstInputLogged = false;
  private readonly onSourceData = (chunk: string | Uint8Array): void => {
    if (this.rawModeRearmTimer !== undefined) {
      clearTimeout(this.rawModeRearmTimer);
      this.rawModeRearmTimer = undefined;
    }
    const bytes = Buffer.from(chunk);
    if (!this.firstInputLogged) {
      this.firstInputLogged = true;
      debugTui('stdin:first-data', {
        inputType: typeof chunk,
        byteLength: bytes.length,
        bytes: Array.from(bytes.subarray(0, 32)),
        stdinListeners: stdinListenerCounts(this.source),
      });
    }
    this.chunks.push(typeof chunk === 'string' ? chunk : bytes);
    this.emit('readable');
  };

  constructor(private readonly source: NodeJS.ReadStream) {
    super();
    this.isTTY = source.isTTY === true;
    this.bootstrapRawMode = process.platform === 'win32' && this.isTTY;
    debugTui('bridge:construct', {
      isTTY: this.isTTY,
      wasPaused: source.isPaused(),
      stdinListeners: stdinListenerCounts(source),
    });
    if (this.bootstrapRawMode) {
      source.setRawMode(true);
      this.rawModeEnabled = true;
      debugTui('raw-mode:set', { requested: true, applied: true, reason: 'bootstrap', stdinListeners: stdinListenerCounts(source) });
    }
    source.setEncoding('utf8');
    source.on('data', this.onSourceData);
    debugTui('bridge:data-attached', { stdinListeners: stdinListenerCounts(source) });
  }
  private scheduleRawModeRearm(): void {
    if (!this.bootstrapRawMode || this.rawModeRearmAttempted || this.rawModeRearmTimer !== undefined) {
      return;
    }
    this.rawModeRearmTimer = setTimeout(() => {
      this.rawModeRearmTimer = undefined;
      if (this.firstInputLogged || !this.rawModeEnabled) {
        return;
      }
      this.rawModeRearmAttempted = true;
      debugTui('raw-mode:rearm', { reason: 'no-input-before-timeout', stdinListeners: stdinListenerCounts(this.source) });
      this.source.setRawMode(false);
      this.source.setRawMode(true);
      this.rawModeEnabled = true;
    }, 250);
  }

  override addListener(eventName: string | symbol, listener: (...args: unknown[]) => void): this {
    const result = super.addListener(eventName, listener);
    if (eventName === 'readable') {
      debugTui('bridge:readable-attached', { bridgeReadableListeners: this.listenerCount('readable'), stdinListeners: stdinListenerCounts(this.source) });
      this.scheduleRawModeRearm();
    }
    if (eventName === 'readable' && this.chunks.length > 0) {
      queueMicrotask(() => this.emit('readable'));
    }
    return result;
  }

  setEncoding(encoding: BufferEncoding): this {
    this.source.setEncoding(encoding);
    return this;
  }

  setRawMode(enabled: boolean): this {
    const applied = !this.bootstrapRawMode || enabled !== this.rawModeEnabled;
    if (applied) {
      this.source.setRawMode(enabled);
      this.rawModeEnabled = enabled;
    }
    debugTui('raw-mode:set', {
      requested: enabled,
      applied,
      tracked: this.rawModeEnabled,
      stdinListeners: stdinListenerCounts(this.source),
    });
    return this;
  }

  ref(): this {
    this.source.ref();
    return this;
  }

  unref(): this {
    this.source.unref();
    return this;
  }
  read(): string | Buffer | null {
    const chunk = this.chunks.shift() ?? null;
    if (chunk !== null) {
      debugTui('bridge:read', {
        inputType: typeof chunk,
        byteLength: typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.length,
        queuedChunks: this.chunks.length,
      });
    }
    return chunk;
  }

  dispose(): void {
    if (this.rawModeRearmTimer !== undefined) {
      clearTimeout(this.rawModeRearmTimer);
      this.rawModeRearmTimer = undefined;
    }
    debugTui('bridge:dispose:start', { stdinListeners: stdinListenerCounts(this.source), queuedChunks: this.chunks.length });
    this.source.removeListener('data', this.onSourceData);
    if (this.bootstrapRawMode && this.rawModeEnabled) {
      this.source.setRawMode(false);
      this.rawModeEnabled = false;
      debugTui('raw-mode:set', { requested: false, applied: true, reason: 'dispose', stdinListeners: stdinListenerCounts(this.source) });
    }
    this.chunks.length = 0;
    this.removeAllListeners();
    debugTui('bridge:dispose:done', { stdinListeners: stdinListenerCounts(this.source) });
  }
}

function prepareTuiStdin(): { readonly input: NodeJS.ReadStream; readonly cleanup: (forChildHandoff?: boolean) => void } {
  const source = process.stdin;
  const wasPaused = source.isPaused();
  debugTui('stdin:prepare:start', { wasPaused, stdinListeners: stdinListenerCounts(source) });
  const bridge = new TuiStdinBridge(source);
  source.resume();
  debugTui('stdin:prepare:resumed', { stdinListeners: stdinListenerCounts(source) });
  let cleanedUp = false;
  return {
    input: bridge as unknown as NodeJS.ReadStream,
    cleanup: (forChildHandoff = false) => {
      if (cleanedUp) {
        debugTui('stdin:cleanup:duplicate');
        return;
      }
      cleanedUp = true;
      debugTui('stdin:cleanup:start', { wasPaused, forChildHandoff, stdinListeners: stdinListenerCounts(source) });
      // The parent waits for a handed-off child. Keep its stream paused so
      // it cannot consume console bytes intended for the child process.
      if (forChildHandoff) {
        source.pause();
      }
      bridge.dispose();
      if (!forChildHandoff) {
        if (wasPaused) {
          source.pause();
        } else {
          source.resume();
        }
      }
      debugTui('stdin:cleanup:done', { restoredPaused: source.isPaused(), stdinListeners: stdinListenerCounts(source) });
    },
  };
}

type TuiScreen = { readonly kind: 'list'; readonly selectedIndex: number } | { readonly kind: 'detail'; readonly selectedIndex: number };

export interface TuiAppProps {
  readonly revisions: readonly StableConfigRevision[];
  readonly knownDifferencesByRevision: ReadonlyMap<string, readonly string[]>;
  readonly onLaunch: (revision: StableConfigRevision) => void;
  readonly onQuit: () => void;
}

/**
 * Presentational two-screen TUI. `Enter` reports the currently selected
 * revision via `onLaunch` from *either* screen (list or detail) --
 * "selected即启动", no y/N prompt and no confirmation-summary screen
 * (EXPERIENCE.md "TUI 自动确认"). `q` reports `onQuit` from either screen
 * without ever having called `onLaunch` -- no `LaunchPlan` is created on
 * that path.
 */
export function TuiApp({ revisions, knownDifferencesByRevision, onLaunch, onQuit }: TuiAppProps): React.JSX.Element {
  const [screen, setScreen] = useState<TuiScreen>({ kind: 'list', selectedIndex: 0 });

  useInput((input, key) => {
    // Ctrl+C is treated identically to `q` -- both go through `onQuit()`
    // so the caller's cleanup (exit alt-screen, close deps) always runs.
    // `render()` is mounted with `exitOnCtrlC: false` precisely so ink
    // never short-circuits that path itself (see `runTuiScreen`). Ink
    // parses the raw `\x03` byte into `input === 'c'` + `key.ctrl`, not a
    // literal `'\x03'` string (`parse-keypress.js`'s "ctrl+letter" branch).
    if (input === 'q' || (input === 'c' && key.ctrl)) {
      onQuit();
      return;
    }

    if (screen.kind === 'list') {
      if (key.upArrow) {
        setScreen((prev) => ({ kind: 'list', selectedIndex: Math.max(0, prev.selectedIndex - 1) }));
        return;
      }
      if (key.downArrow) {
        setScreen((prev) => ({ kind: 'list', selectedIndex: Math.max(0, Math.min(revisions.length - 1, prev.selectedIndex + 1)) }));
        return;
      }
      if (key.return) {
        const revision = revisions[screen.selectedIndex];
        if (revision !== undefined) {
          onLaunch(revision);
        }
        return;
      }
      if (key.rightArrow) {
        if (revisions.length > 0) {
          setScreen({ kind: 'detail', selectedIndex: screen.selectedIndex });
        }
        return;
      }
      return;
    }

    // screen.kind === 'detail'
    if (key.return) {
      const revision = revisions[screen.selectedIndex];
      if (revision !== undefined) {
        onLaunch(revision);
      }
      return;
    }
    if (key.escape) {
      setScreen({ kind: 'list', selectedIndex: screen.selectedIndex });
    }
  });

  if (revisions.length === 0) {
    return (
      <Box flexDirection="column">
        <Text>{t('emptyList.line1')}</Text>
        <Text>{t('emptyList.line2')}</Text>
        <Text>{t('emptyList.line3')}</Text>
        <Text> </Text>
        <Text dimColor>{t('tui.listFooter')}</Text>
      </Box>
    );
  }

  if (screen.kind === 'list') {
    return (
      <Box flexDirection="column">
        {revisions.map((revision, index) => {
          const marker = formatDefaultMarker(revision);
          const availability = formatAvailability(revision);
          const hasKnownDifferences = (knownDifferencesByRevision.get(revision.revisionId) ?? []).length > 0;
          const label = `${revision.configName}  [${marker}]  ${t('list.statusLabel')}=${availability}`;
          return (
            <Text key={revision.revisionId} inverse={index === screen.selectedIndex}>
              {label}
              {hasKnownDifferences ? <Text color={ROLE_COLOR_NAMES.attention}> {t('tui.knownDifferencesMarker')}</Text> : null}
            </Text>
          );
        })}
        <Text> </Text>
        <Text dimColor>{t('tui.listFooter')}</Text>
      </Box>
    );
  }

  const revision = revisions[screen.selectedIndex]!;
  const diffs = knownDifferencesByRevision.get(revision.revisionId) ?? [];
  return (
    <Box flexDirection="column">
      {renderDetail(revision)
        .split('\n')
        .map((line, index) => (
          // eslint-disable-next-line react/no-array-index-key -- static content, index-stable within a single render
          <Text key={index}>{line}</Text>
        ))}
      {diffs.length > 0 ? (
        <Box flexDirection="column">
          <Text> </Text>
          <Text color={ROLE_COLOR_NAMES.attention}>{t('confirmation.knownDifferencesTitle')}</Text>
          {diffs.map((reason) => (
            <Text key={reason}>{`  - ${reason}`}</Text>
          ))}
        </Box>
      ) : null}
      <Text> </Text>
      <Text dimColor>{t('tui.detailFooter')}</Text>
    </Box>
  );
}

export type TuiDecision = { readonly kind: 'launch'; readonly revision: StableConfigRevision } | { readonly kind: 'quit' };

/**
 * Mounts `TuiApp` inside the alt-screen and resolves once the user either
 * selects a revision to launch or quits -- never re-entered afterwards
 * (the ink instance is unmounted before this resolves).
 */
function runTuiScreen(revisions: readonly StableConfigRevision[], knownDifferencesByRevision: ReadonlyMap<string, readonly string[]>): Promise<TuiDecision> {
  return new Promise((resolve) => {
    debugTui('screen:start', { revisionCount: revisions.length });
    const tuiStdin = prepareTuiStdin();
    debugTui('screen:before-render');
    try {
      const instance = render(
        <TuiApp
          revisions={revisions}
          knownDifferencesByRevision={knownDifferencesByRevision}
          // Ink invokes these handlers from the stdin data callback. Let that
          // callback return before raw-mode cleanup; otherwise Windows keeps
          // the console input handle busy when the next process starts.
          onLaunch={(revision) => {
            debugTui('screen:decision', { kind: 'launch', revisionId: revision.revisionId });
            setImmediate(() => {
              try {
                instance.unmount();
              } finally {
                tuiStdin.cleanup(true);
              }
              resolve({ kind: 'launch', revision });
            });
          }}
          onQuit={() => {
            debugTui('screen:decision', { kind: 'quit' });
            setImmediate(() => {
              try {
                instance.unmount();
              } finally {
                tuiStdin.cleanup();
              }
              resolve({ kind: 'quit' });
            });
          }}
        />,
        // Ink's default `exitOnCtrlC` unmounts and calls `process.exit()`
        // directly on Ctrl+C, bypassing `exitAltScreen()`/dependency
        // cleanup in `runTui()`. Disabling it here routes Ctrl+C through
        // `TuiApp`'s own `useInput` handler (which calls `onQuit()`) instead
        // -- the same cleanup path as a normal `q` quit.
        { exitOnCtrlC: false, stdin: tuiStdin.input },
      );
      debugTui('screen:rendered');
    } catch (error) {
      debugTui('screen:render-error', { message: error instanceof Error ? error.message : String(error) });
      try {
        tuiStdin.cleanup();
      } finally {
        throw error;
      }
    }
  });
}

/**
 * Drives the same auto-confirm path `--yes` uses on the pure-text CLI:
 * `prepareLaunchPlan` then immediately `confirmLaunchPlan` -- no y/N
 * prompt, no confirmation-summary screen, but the exact same
 * `prepared -> awaiting-confirmation -> applying` domain transitions
 * (EXPERIENCE.md "TUI 自动确认"). Returns the plan wherever it lands --
 * still `awaiting-confirmation` never happens as a *returned* result here
 * since it is immediately confirmed; a plan that failed to prepare comes
 * back in `failed` instead.
 */
export async function runAutoConfirmLaunch(deps: LaunchDeps, revisionId: string): Promise<import('../domain/activation').LaunchPlan> {
  const prepared = await prepareLaunchPlan(deps, { revisionId, client: 'omp' });
  if (prepared.phase !== 'awaiting-confirmation') {
    return prepared;
  }
  return confirmLaunchPlan(deps, prepared.planId);
}

/**
 * Injectable seams for testing `runTuiWithDeps()`'s own orchestration
 * (alt-screen ordering, cleanup-on-throw, handoff-line placement, etc.)
 * without mounting a real `ink` app or opening real SQLite repositories.
 * All three default to the real implementations -- `runTui()`'s
 * production call site never passes any of these.
 */
export interface RunTuiHooks {
  readonly pickDecision?: (
    revisions: readonly StableConfigRevision[],
    knownDifferencesByRevision: ReadonlyMap<string, readonly string[]>,
  ) => Promise<TuiDecision>;
  readonly enterAltScreen?: () => void;
  readonly exitAltScreen?: () => void;
}

/**
 * Everything `runTui()` does once dependencies are already open: lists
 * revisions, mounts the two-screen TUI, and on a launch decision drives
 * the same confirm/launch/observe path as `configs use --yes`. The
 * alt-screen is always exited before anything is printed as plain text
 * (handoff line, failure block, final status) -- DESIGN.md
 * `{components.handoff-line}` and Interaction Primitives "终端交接" --
 * and `deps`' repositories are always closed exactly once, regardless of
 * which branch returns or throws.
 *
 * Split out from `runTui()` (which just calls `openDeps()` then this) so
 * tests can drive the orchestration directly against fake/in-memory
 * `FullDeps` and injected `RunTuiHooks`, without a real terminal or SQLite
 * file (`tests/cli/tui.test.tsx`).
 */
export async function runTuiWithDeps(deps: FullDeps, hooks: RunTuiHooks = {}): Promise<number> {
  const pickDecision = hooks.pickDecision ?? runTuiScreen;
  const doEnterAltScreen = hooks.enterAltScreen ?? enterAltScreen;
  const doExitAltScreen = hooks.exitAltScreen ?? exitAltScreen;
  debugTui('orchestration:start');

  // A single outer `finally` closes both repositories exactly once,
  // regardless of which branch below returns or throws -- no branch
  // closes them itself anymore, which previously risked either a leaked
  // handle (if an exception unwound past an inner branch's manual close)
  // or a double-close (if two branches' close calls could both run).
  try {
    let revisions: readonly StableConfigRevision[];
    try {
      revisions = await listConfigRevisions(deps.configRepository);
      debugTui('orchestration:revisions-loaded', { revisionCount: revisions.length });
    } catch (error) {
      debugTui('orchestration:revision-load-error', { message: (error as Error).message });
      console.error(t('unexpectedFailure', { message: (error as Error).message }));
      return 1;
    }

    const knownDifferencesByRevision = new Map<string, readonly string[]>(revisions.map((revision) => [revision.revisionId, computeKnownDifferences(revision)]));

    // `exitAltScreen()` must run even if `pickDecision()` throws --
    // otherwise a crash mid-TUI would leave the user's real terminal
    // stuck showing the alt-screen buffer.
    let decision: TuiDecision;
    debugTui('orchestration:enter-alt-screen');
    doEnterAltScreen();
    try {
      decision = await pickDecision(revisions, knownDifferencesByRevision);
      debugTui('orchestration:decision-received', { kind: decision.kind });
    } finally {
      doExitAltScreen();
      debugTui('orchestration:exit-alt-screen');
    }

    if (decision.kind === 'quit') {
      debugTui('orchestration:quit');
      return 0;
    }

    debugTui('orchestration:prepare-launch', { revisionId: decision.revision.revisionId });
    const plan = await runAutoConfirmLaunch(deps, decision.revision.revisionId);
    debugTui('orchestration:launch-plan', { phase: plan.phase, planId: plan.planId });
    if (plan.phase !== 'applying') {
      // `prepareLaunchPlan` carried the plan straight to `failed` (e.g. the
      // revision vanished between the list rendering and this point) --
      // render it exactly like the pure-text CLI's own failure path.
      console.log(renderLaunchFailure(plan));
      return 1;
    }

    // `[DELTA]` Same ordering fix as the pure-text CLI path: the handoff
    // line only prints once `launchOmp` is actually about to spawn `omp`,
    // not unconditionally before calling it.
    const finalPlan = await launchOmp(deps, {
      planId: plan.planId,
      extensionPath: defaultExtensionPath(),
      forwardedArgs: [],
      cwd: process.cwd(),
      onSpawning: () => console.log(renderHandoffLine()),
    });

    debugTui('orchestration:launch-result', { phase: finalPlan.phase, planId: finalPlan.planId });
    if (finalPlan.phase === 'succeeded' || finalPlan.phase === 'degraded') {
      const status = await getLaunchStatus(deps, finalPlan.planId);
      console.log(renderLaunchStatus(status));
      return 0;
    }

    console.log(renderLaunchFailure(finalPlan));
    return 1;
  } finally {
    debugTui('orchestration:cleanup');
    deps.configRepository.close();
    deps.launchPlanRepository.close();
  }
}

/**
 * Full TUI entry point: opens dependencies, then delegates the rest of
 * the orchestration to `runTuiWithDeps()`.
 */
export async function runTui(overrides: CliOverrides): Promise<number> {
  const deps = await openDeps(overrides);
  if (deps === null) {
    return 1;
  }
  return runTuiWithDeps(deps);
}
