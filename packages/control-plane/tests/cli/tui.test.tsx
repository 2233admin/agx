import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { render } from 'ink-testing-library';

import { TuiApp, runAutoConfirmLaunch, runTuiWithDeps, type RunTuiHooks, type TuiDecision } from '../../src/cli/tui';
import type { FullDeps } from '../../src/cli/index';
import { t } from '../../src/cli/i18n';
import { confirmLaunchPlan, prepareLaunchPlan } from '../../src/application/launch';
import { FsClaudeContentMaterializer } from '../../src/adapters/clients/claude/content-materializer';
import type { ClientId } from '../../src/domain/client';
import type { LaunchPlan } from '../../src/domain/activation';
import { known } from '../../src/domain/facts';
import type { Fact } from '../../src/domain/facts';
import type { CapabilityReference, StableConfigRevision } from '../../src/domain/config';
import type {
  CapabilityProbeResult,
  ClaudeCapabilityProbePort,
  ClaudeCapabilityProbeResult,
  ClaudeInvocationDirPort,
  ClaudeLaunchContext,
  ClaudeLaunchContextWriter,
  ClaudeProcessPort,
  ClaudeSpawnParams,
  ClaudeSpawnResult,
  ConfigRevisionRepository,
  LaunchContext,
  LaunchContextWriter,
  LaunchPlanRepository,
  OmpCapabilityProbePort,
  OmpProcessPort,
  OmpSpawnParams,
  OmpSpawnResult,
} from '../../src/application/ports';

/**
 * `TuiApp` is purely presentational (Design Notes in `src/cli/tui.tsx`):
 * it never touches a repository or spawns anything, only reports the
 * user's decision via `onLaunch`/`onQuit`. That is what makes it directly
 * testable here with `ink-testing-library` instead of a real terminal.
 *
 * `ink`'s input handling is wired up via a `useEffect` (raw-mode
 * subscription) and React's passive-effect flush is asynchronous relative
 * to `render()`/`stdin.write()` returning -- so every interaction below
 * awaits a `flush()` tick after mounting and after each keystroke before
 * asserting on callbacks/`lastFrame()`.
 */

let originalLang: string | undefined;

beforeEach(() => {
  originalLang = process.env.CONFIGS_LANG;
  process.env.CONFIGS_LANG = 'en';
});

afterEach(() => {
  if (originalLang === undefined) {
    delete process.env.CONFIGS_LANG;
  } else {
    process.env.CONFIGS_LANG = originalLang;
  }
});

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

const ESC = '';
const UP = `${ESC}[A`;
const DOWN = `${ESC}[B`;
const RIGHT = `${ESC}[C`;
const ENTER = '\r';
const ESCAPE = ESC;

async function press(stdin: { write: (data: string) => void }, sequence: string): Promise<void> {
  stdin.write(sequence);
  await flush();
}

function ref(kind: CapabilityReference['kind'], name: string): CapabilityReference {
  return {
    kind,
    name,
    sourceCategory: known('project-capability'),
    summary: known(`${kind}: ${name}`),
    sourceRef: known(`ref/${name}`),
    contentFingerprint: known(`fingerprint/${name}`),
  };
}

function revision(overrides: Partial<StableConfigRevision> & { configName: string; revisionId: string }): StableConfigRevision {
  return {
    configName: overrides.configName,
    revisionId: overrides.revisionId,
    defaultMarker: overrides.defaultMarker ?? known(false),
    scopeBoundary: overrides.scopeBoundary ?? known('a scope boundary'),
    availability: overrides.availability ?? known('resolved'),
    instructions: overrides.instructions ?? [],
    skills: overrides.skills ?? [],
    mcp: overrides.mcp ?? [],
    hooks: overrides.hooks ?? [],
    plugins: overrides.plugins ?? [],
    triggerCategory: overrides.triggerCategory ?? 'new-scenario',
    evidenceRef: overrides.evidenceRef ?? 'test-evidence',
    supersedesRevisionId: overrides.supersedesRevisionId ?? null,
  };
}

/**
 * Fakes for the full `FullDeps` bag (`src/cli/index.ts`), shared by the
 * `runAutoConfirmLaunch` and `runTuiWithDeps` describe blocks below --
 * in-memory stand-ins so neither block touches real SQLite or spawns a
 * real process.
 */
class FakeConfigRevisionRepository implements ConfigRevisionRepository {
  private readonly revisions = new Map<string, StableConfigRevision>();
  /** When set, `listAll()` rejects with this instead of returning normally. */
  listAllError: Error | null = null;
  closeCallCount = 0;

  add(revision: StableConfigRevision): void {
    this.revisions.set(revision.revisionId, revision);
  }
  async listAll(): Promise<readonly StableConfigRevision[]> {
    if (this.listAllError !== null) {
      throw this.listAllError;
    }
    return [...this.revisions.values()];
  }
  async findById(revisionId: string): Promise<StableConfigRevision | null> {
    return this.revisions.get(revisionId) ?? null;
  }
  close(): void {
    this.closeCallCount += 1;
  }
}

class FakeLaunchPlanRepository implements LaunchPlanRepository {
  readonly plans = new Map<string, LaunchPlan>();
  readonly saveLog: LaunchPlan[] = [];
  closeCallCount = 0;
  async save(plan: LaunchPlan): Promise<void> {
    this.plans.set(plan.planId, plan);
    this.saveLog.push(plan);
  }
  async findById(planId: string): Promise<LaunchPlan | null> {
    return this.plans.get(planId) ?? null;
  }
  async findActiveForClient(client: ClientId): Promise<LaunchPlan | null> {
    const forClient = [...this.plans.values()].filter((plan) => plan.client === client);
    return forClient.length === 0 ? null : forClient[forClient.length - 1]!;
  }
  close(): void {
    this.closeCallCount += 1;
  }
}

class FakeOmpProcessPort implements OmpProcessPort {
  version: Fact<string> = known('17.4.1');
  spawnResult: OmpSpawnResult = { exitCode: 0, signal: null };
  lastSpawnParams: OmpSpawnParams | null = null;
  async detectVersion() {
    return this.version;
  }
  async spawn(params: OmpSpawnParams): Promise<OmpSpawnResult> {
    this.lastSpawnParams = params;
    return this.spawnResult;
  }
}

class FakeOmpCapabilityProbe implements OmpCapabilityProbePort {
  result: CapabilityProbeResult = { level: 'unsupported', reason: 'omp-native-interface-has-no-agent-system-config-concept' };
  async probeStatusViewingCapability(): Promise<CapabilityProbeResult> {
    return this.result;
  }
}

class FakeLaunchContextWriter implements LaunchContextWriter {
  readonly written: LaunchContext[] = [];
  async write(context: LaunchContext): Promise<string> {
    this.written.push(context);
    return `/fake/launch-context/${context.planId}.json`;
  }
}

/**
 * `[Story 4.6]` `FullDeps` now also carries the four Claude ports -- the
 * TUI itself is untouched by this Story (out of scope) and never exercises
 * these, but `fakeFullDeps()`'s return type must still satisfy `FullDeps`.
 * Minimal no-op fakes only, never called by anything under test here.
 */
class FakeClaudeProcessPort implements ClaudeProcessPort {
  async detectVersion() {
    return known('9.9.9');
  }
  async captureHelpText() {
    return known('');
  }
  async spawn(_params: ClaudeSpawnParams): Promise<ClaudeSpawnResult> {
    return { exitCode: 0, signal: null };
  }
}

class FakeClaudeCapabilityProbe implements ClaudeCapabilityProbePort {
  async probeHardControlCapabilities(): Promise<readonly ClaudeCapabilityProbeResult[]> {
    return [];
  }
}

class FakeClaudeLaunchContextWriter implements ClaudeLaunchContextWriter {
  async write(context: ClaudeLaunchContext): Promise<string> {
    return `/fake/claude-launch-context/${context.planId}.json`;
  }
}

class FakeClaudeInvocationDirPort implements ClaudeInvocationDirPort {
  async prepare(operationId: string): Promise<string> {
    return `/fake/claude-invocations/${operationId}`;
  }

  async cleanup(): Promise<void> {
    // No real filesystem behind this fake -- nothing to remove.
  }
}

/** Builds a full, in-memory `FullDeps` bag for `runTuiWithDeps()` tests. */
function fakeFullDeps(): {
  readonly deps: FullDeps;
  readonly configRepository: FakeConfigRevisionRepository;
  readonly launchPlanRepository: FakeLaunchPlanRepository;
  readonly ompPort: FakeOmpProcessPort;
  readonly capabilityProbe: FakeOmpCapabilityProbe;
  readonly contextWriter: FakeLaunchContextWriter;
} {
  const configRepository = new FakeConfigRevisionRepository();
  const launchPlanRepository = new FakeLaunchPlanRepository();
  const ompPort = new FakeOmpProcessPort();
  const capabilityProbe = new FakeOmpCapabilityProbe();
  const contextWriter = new FakeLaunchContextWriter();
  const claudeProcessPort = new FakeClaudeProcessPort();
  const claudeCapabilityProbe = new FakeClaudeCapabilityProbe();
  const claudeLaunchContextWriter = new FakeClaudeLaunchContextWriter();
  const claudeInvocationDirPort = new FakeClaudeInvocationDirPort();
  const claudeContentMaterializer = new FsClaudeContentMaterializer();
  return {
    deps: {
      configRepository,
      launchPlanRepository,
      ompPort,
      capabilityProbe,
      contextWriter,
      claudeProcessPort,
      claudeCapabilityProbe,
      claudeLaunchContextWriter,
      claudeInvocationDirPort,
      claudeContentMaterializer,
    },
    configRepository,
    launchPlanRepository,
    ompPort,
    capabilityProbe,
    contextWriter,
  };
}

/**
 * Ink's production renderer consumes stdin through `readable`/`read()`.
 * This fake emits only `data`, reproducing Bun's Windows console behavior
 * that the TUI stdin bridge adapts while recording lifecycle restoration.
 */
class FakeTuiStdin extends EventEmitter {
  readonly isTTY = true;
  readonly events: string[] = [];
  readonly rawModeCalls: boolean[] = [];
  resumeCallCount = 0;
  pauseCallCount = 0;
  private resumed = false;
  private readonly chunks: string[] = [];

  override addListener(...args: Parameters<EventEmitter['addListener']>): this {
    const [eventName] = args;
    if (eventName === 'data') {
      this.events.push('data-listener');
    }
    return super.addListener(...args);
  }

  isPaused(): boolean {
    return !this.resumed;
  }

  resume(): this {
    this.resumeCallCount += 1;
    this.resumed = true;
    this.events.push('resume');
    return this;
  }

  pause(): this {
    this.pauseCallCount += 1;
    this.resumed = false;
    this.events.push('pause');
    return this;
  }

  setEncoding(_encoding: string): this {
    return this;
  }

  setRawMode(enabled: boolean): this {
    this.rawModeCalls.push(enabled);
    return this;
  }

  ref(): this {
    return this;
  }

  unref(): this {
    return this;
  }

  read(): string | null {
    return this.chunks.shift() ?? null;
  }

  pushInput(input: string | Uint8Array): void {
    if (this.resumed) {
      this.emit('data', input);
      return;
    }
    this.chunks.push(typeof input === 'string' ? input : new TextDecoder().decode(input));
  }
}

describe('TuiApp list screen', () => {
  test('renders every revision name and a default/generic marker', async () => {
    const revisions = [
      revision({ configName: 'general', revisionId: 'rev-general', defaultMarker: known(true) }),
      revision({ configName: 'research-v3', revisionId: 'rev-research', defaultMarker: known(false) }),
    ];
    const { lastFrame } = render(<TuiApp revisions={revisions} knownDifferencesByRevision={new Map()} onLaunch={() => {}} onQuit={() => {}} />);
    await flush();
    const frame = lastFrame() ?? '';
    expect(frame).toContain('general');
    expect(frame).toContain('research-v3');
    // revision id must not appear -- TUI selects by name, not by id
    // (EXPERIENCE.md: "revision id 不在这一屏出现").
    expect(frame).not.toContain('rev-general');
  });

  test('marks a revision with known differences and leaves the others unmarked', async () => {
    const revisions = [
      revision({ configName: 'general', revisionId: 'rev-general' }),
      revision({ configName: 'research-v3', revisionId: 'rev-research', instructions: [ref('instruction', 'i1')] }),
    ];
    const knownDifferencesByRevision = new Map([
      ['rev-general', []],
      ['rev-research', ['instructions-content-not-materialized-in-mvp']],
    ]);
    const { lastFrame } = render(
      <TuiApp revisions={revisions} knownDifferencesByRevision={knownDifferencesByRevision} onLaunch={() => {}} onQuit={() => {}} />,
    );
    await flush();
    const lines = (lastFrame() ?? '').split('\n');
    const generalLine = lines.find((line) => line.includes('general') && !line.includes('research')) ?? '';
    const researchLine = lines.find((line) => line.includes('research-v3')) ?? '';
    expect(researchLine).toContain('(has known differences)');
    expect(generalLine).not.toContain('(has known differences)');
  });

  test('Enter on the selected (first) row reports that revision via onLaunch, with no y/N prompt involved', async () => {
    const revisions = [revision({ configName: 'general', revisionId: 'rev-general' }), revision({ configName: 'writing-v1', revisionId: 'rev-writing' })];
    let launched: StableConfigRevision | null = null;
    const { stdin } = render(
      <TuiApp revisions={revisions} knownDifferencesByRevision={new Map()} onLaunch={(r) => (launched = r)} onQuit={() => {}} />,
    );
    await flush();
    await press(stdin, ENTER);
    expect(launched).not.toBeNull();
    expect(launched!.revisionId).toBe('rev-general');
  });

  test('down arrow moves the selection before Enter launches it', async () => {
    const revisions = [revision({ configName: 'general', revisionId: 'rev-general' }), revision({ configName: 'writing-v1', revisionId: 'rev-writing' })];
    let launched: StableConfigRevision | null = null;
    const { stdin } = render(
      <TuiApp revisions={revisions} knownDifferencesByRevision={new Map()} onLaunch={(r) => (launched = r)} onQuit={() => {}} />,
    );
    await flush();
    await press(stdin, DOWN);
    await press(stdin, ENTER);
    expect(launched!.revisionId).toBe('rev-writing');
  });

  test('up arrow at the top of the list stays clamped at the first row', async () => {
    const revisions = [revision({ configName: 'general', revisionId: 'rev-general' }), revision({ configName: 'writing-v1', revisionId: 'rev-writing' })];
    let launched: StableConfigRevision | null = null;
    const { stdin } = render(
      <TuiApp revisions={revisions} knownDifferencesByRevision={new Map()} onLaunch={(r) => (launched = r)} onQuit={() => {}} />,
    );
    await flush();
    await press(stdin, UP);
    await press(stdin, ENTER);
    expect(launched!.revisionId).toBe('rev-general');
  });

  test('down arrow at the bottom of a single-item list stays clamped at index 0 (regression: used to compute -1 with 0 revisions)', async () => {
    const revisions = [revision({ configName: 'only-one', revisionId: 'rev-only' })];
    let launched: StableConfigRevision | null = null;
    const { stdin } = render(
      <TuiApp revisions={revisions} knownDifferencesByRevision={new Map()} onLaunch={(r) => (launched = r)} onQuit={() => {}} />,
    );
    await flush();
    await press(stdin, DOWN);
    await press(stdin, DOWN);
    await press(stdin, ENTER);
    expect(launched!.revisionId).toBe('rev-only');
  });

  test('Ctrl+C is treated the same as q -- quits without ever calling onLaunch', async () => {
    const revisions = [revision({ configName: 'general', revisionId: 'rev-general' })];
    let quit = false;
    let launched = false;
    const { stdin } = render(
      <TuiApp
        revisions={revisions}
        knownDifferencesByRevision={new Map()}
        onLaunch={() => {
          launched = true;
        }}
        onQuit={() => {
          quit = true;
        }}
      />,
    );
    await flush();
    // The raw byte ink parses into `input === 'c'` + `key.ctrl === true`
    // (`parse-keypress.js`'s "ctrl+letter" branch) -- not a literal
    // `'\x03'` string.
    await press(stdin, '\x03');
    expect(quit).toBe(true);
    expect(launched).toBe(false);
  });

  test('the undocumented "i" alternate keybinding for entering detail no longer exists -- only the right arrow does', async () => {
    const revisions = [revision({ configName: 'general', revisionId: 'rev-general' })];
    const { stdin, lastFrame } = render(
      <TuiApp revisions={revisions} knownDifferencesByRevision={new Map()} onLaunch={() => {}} onQuit={() => {}} />,
    );
    await flush();
    const beforeFrame = lastFrame() ?? '';
    await press(stdin, 'i');
    // Still on the list screen -- "i" is not bound to anything, so the
    // frame (footer hint text in particular) is unchanged.
    expect(lastFrame() ?? '').toBe(beforeFrame);
    expect(lastFrame() ?? '').toContain(t('tui.listFooter'));
  });

  test('q quits without ever calling onLaunch -- no LaunchPlan is created on this path', async () => {
    const revisions = [revision({ configName: 'general', revisionId: 'rev-general' })];
    let quit = false;
    let launched = false;
    const { stdin } = render(
      <TuiApp
        revisions={revisions}
        knownDifferencesByRevision={new Map()}
        onLaunch={() => {
          launched = true;
        }}
        onQuit={() => {
          quit = true;
        }}
      />,
    );
    await flush();
    await press(stdin, 'q');
    expect(quit).toBe(true);
    expect(launched).toBe(false);
  });

  test('empty revision list renders the same honest empty-state text as the pure-text CLI, not a crash', async () => {
    const { lastFrame } = render(<TuiApp revisions={[]} knownDifferencesByRevision={new Map()} onLaunch={() => {}} onQuit={() => {}} />);
    await flush();
    expect(lastFrame() ?? '').toContain('No saved configuration revisions found.');
  });
});

describe('TuiApp detail screen', () => {
  test('right arrow switches to the detail screen, showing the same fields as renderDetail plus inline known differences', async () => {
    const revisions = [
      revision({
        configName: 'research-v3',
        revisionId: 'rev-research',
        instructions: [ref('instruction', 'i1')],
        skills: [ref('skill', 'openspec-explore')],
      }),
    ];
    const knownDifferencesByRevision = new Map([['rev-research', ['instructions-content-not-materialized-in-mvp']]]);
    const { stdin, lastFrame } = render(
      <TuiApp revisions={revisions} knownDifferencesByRevision={knownDifferencesByRevision} onLaunch={() => {}} onQuit={() => {}} />,
    );
    await flush();
    await press(stdin, RIGHT);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('research-v3');
    expect(frame).toContain('openspec-explore');
    expect(frame).toContain('instructions-content-not-materialized-in-mvp');
  });

  test('Escape returns from the detail screen back to the list screen, preserving selection', async () => {
    const revisions = [revision({ configName: 'general', revisionId: 'rev-general' }), revision({ configName: 'writing-v1', revisionId: 'rev-writing' })];
    let launched: StableConfigRevision | null = null;
    const { stdin, lastFrame } = render(
      <TuiApp revisions={revisions} knownDifferencesByRevision={new Map()} onLaunch={(r) => (launched = r)} onQuit={() => {}} />,
    );
    await flush();
    await press(stdin, RIGHT);
    expect(lastFrame() ?? '').not.toContain('writing-v1');
    await press(stdin, ESCAPE);
    expect(lastFrame() ?? '').toContain('writing-v1');
    // Selection is preserved across the round trip -- Enter after
    // returning still targets the originally-selected revision.
    await press(stdin, ENTER);
    expect(launched!.revisionId).toBe('rev-general');
  });

  test('Enter on the detail screen also reports onLaunch directly, with no confirmation-summary screen in between', async () => {
    const revisions = [revision({ configName: 'general', revisionId: 'rev-general' })];
    let launched: StableConfigRevision | null = null;
    const { stdin } = render(
      <TuiApp revisions={revisions} knownDifferencesByRevision={new Map()} onLaunch={(r) => (launched = r)} onQuit={() => {}} />,
    );
    await flush();
    await press(stdin, RIGHT);
    await press(stdin, ENTER);
    expect(launched!.revisionId).toBe('rev-general');
  });

  test('q on the detail screen also quits without calling onLaunch', async () => {
    const revisions = [revision({ configName: 'general', revisionId: 'rev-general' })];
    let quit = false;
    let launched = false;
    const { stdin } = render(
      <TuiApp
        revisions={revisions}
        knownDifferencesByRevision={new Map()}
        onLaunch={() => {
          launched = true;
        }}
        onQuit={() => {
          quit = true;
        }}
      />,
    );
    await flush();
    await press(stdin, RIGHT);
    await press(stdin, 'q');
    expect(quit).toBe(true);
    expect(launched).toBe(false);
  });
});

/**
 * `runAutoConfirmLaunch` is the function `runTui()` calls once the user
 * presses Enter -- it must drive `LaunchPlan` through the exact same
 * `prepared -> awaiting-confirmation -> applying` transitions `--yes`
 * uses on the pure-text CLI (EXPERIENCE.md "TUI 自动确认"), with no
 * interactive y/N step anywhere in the call chain.
 */
describe('runAutoConfirmLaunch (TUI auto-confirm path, mocked deps)', () => {
  test('selecting a valid revision reaches "applying" (confirmed) with no rejected/cancelled event in between', async () => {
    const configRepository = new FakeConfigRevisionRepository();
    configRepository.add(revision({ configName: 'research-v3', revisionId: 'rev-research' }));
    const launchPlanRepository = new FakeLaunchPlanRepository();

    const plan = await runAutoConfirmLaunch({ configRepository, launchPlanRepository }, 'rev-research');

    expect(plan.phase).toBe('applying');
    // Exactly the phases `prepareLaunchPlan` + `confirmLaunchPlan` produce
    // on the pure-text `--yes` path -- never `cancelled`.
    expect(launchPlanRepository.saveLog.map((p) => p.phase)).toEqual(['awaiting-confirmation', 'applying']);
  });

  test('this is exactly the same transition sequence prepareLaunchPlan+confirmLaunchPlan produce directly (no divergent TUI-only code path)', async () => {
    const configRepository = new FakeConfigRevisionRepository();
    configRepository.add(revision({ configName: 'general', revisionId: 'rev-general' }));

    const launchPlanRepository = new FakeLaunchPlanRepository();
    const deps = { configRepository, launchPlanRepository };
    const prepared = await prepareLaunchPlan(deps, { revisionId: 'rev-general', client: 'omp' });
    const confirmedDirect = await confirmLaunchPlan(deps, prepared.planId);

    const launchPlanRepository2 = new FakeLaunchPlanRepository();
    const deps2 = { configRepository, launchPlanRepository: launchPlanRepository2 };
    const viaAutoConfirm = await runAutoConfirmLaunch(deps2, 'rev-general');

    expect(viaAutoConfirm.phase).toBe(confirmedDirect.phase);
  });

  test('a revision that fails to resolve lands the plan in "failed" instead of throwing, and is never confirmed', async () => {
    const configRepository = new FakeConfigRevisionRepository();
    const launchPlanRepository = new FakeLaunchPlanRepository();

    const plan = await runAutoConfirmLaunch({ configRepository, launchPlanRepository }, 'does-not-exist');

    expect(plan.phase).toBe('failed');
    expect(launchPlanRepository.saveLog.map((p) => p.phase)).toEqual(['failed']);
  });
});

/**
 * `runTuiWithDeps()` is everything `runTui()` does once dependencies are
 * already open (Design Notes in `src/cli/tui.tsx`): list revisions, run
 * the alt-screen TUI (via the injectable `pickDecision` hook, so no real
 * `ink` app or terminal is needed here), and on a launch decision drive
 * confirm/launch/observe. These tests exercise that orchestration
 * directly -- `TuiApp`'s own behavior is covered above, and
 * `runAutoConfirmLaunch`'s domain transitions are covered by the previous
 * describe block.
 */
describe('runTuiWithDeps orchestration (mocked deps + injected alt-screen/decision hooks)', () => {
  let originalLang: string | undefined;
  let originalLog: typeof console.log;
  let originalError: typeof console.error;
  let logs: string[];
  let errors: string[];

  beforeEach(() => {
    originalLang = process.env.CONFIGS_LANG;
    process.env.CONFIGS_LANG = 'en';
    logs = [];
    errors = [];
    originalLog = console.log;
    originalError = console.error;
    console.log = (...args: unknown[]) => {
      logs.push(args.map(String).join(' '));
    };
    console.error = (...args: unknown[]) => {
      errors.push(args.map(String).join(' '));
    };
  });

  afterEach(() => {
    console.log = originalLog;
    console.error = originalError;
    if (originalLang === undefined) {
      delete process.env.CONFIGS_LANG;
    } else {
      process.env.CONFIGS_LANG = originalLang;
    }
  });

  function countCalls(fn: () => void): { readonly wrapped: () => void; count(): number } {
    let count = 0;
    return { wrapped: () => (count += 1), count: () => count };
  }

  // Most tests below don't care about the alt-screen escape codes
  // themselves -- only the tests explicitly about alt-screen ordering
  // assert on them. Everything else passes these no-ops so the real
  // `\x1b[?1049h`/`\x1b[?1049l` sequences never hit this test run's real
  // stdout.
  const noAltScreen = { enterAltScreen: () => {}, exitAltScreen: () => {} };

  test('resumes stdin before Ink subscribes to readable input and still routes Ctrl+C through the normal quit cleanup', async () => {
    const { deps, configRepository } = fakeFullDeps();
    configRepository.add(revision({ configName: 'general', revisionId: 'rev-general' }));
    const stdin = new FakeTuiStdin();
    const originalStdin = process.stdin;
    Object.defineProperty(process, 'stdin', { value: stdin, configurable: true });

    try {
      expect(stdin.isPaused()).toBe(true);
      const tui = runTuiWithDeps(deps, noAltScreen);
      await flush();
      await flush();

      expect(stdin.resumeCallCount).toBe(1);
      expect(stdin.listenerCount('data')).toBe(1);

      stdin.pushInput(Buffer.from([0x03]));
      await tui;
      expect(stdin.rawModeCalls).toEqual([true, false]);
      expect(stdin.listenerCount('readable')).toBe(0);
      expect(stdin.listenerCount('data')).toBe(0);
      expect(stdin.pauseCallCount).toBe(1);
      expect(stdin.events[stdin.events.length - 1]).toBe('pause');
      expect(stdin.isPaused()).toBe(true);
    } finally {
      Object.defineProperty(process, 'stdin', { value: originalStdin, configurable: true });
    }
  });

  test('re-arms Windows raw mode once when no input arrives after Ink subscribes', async () => {
    if (process.platform !== 'win32') {
      return;
    }
    const { deps, configRepository } = fakeFullDeps();
    const stdin = new FakeTuiStdin();
    const originalStdin = process.stdin;
    Object.defineProperty(process, 'stdin', { value: stdin, configurable: true });

    try {
      const tui = runTuiWithDeps(deps, noAltScreen);
      await flush();
      await flush();
      await new Promise((resolve) => setTimeout(resolve, 300));

      const expectedBeforeQuit = process.platform === 'win32' ? [true, false, true] : [true];
      const expectedAfterQuit = process.platform === 'win32' ? [true, false, true, false] : [true, false];
      expect(stdin.rawModeCalls).toEqual(expectedBeforeQuit);
      stdin.pushInput('q');
      await tui;
      expect(stdin.rawModeCalls).toEqual(expectedAfterQuit);
      expect(stdin.listenerCount('data')).toBe(0);
      expect(stdin.listenerCount('readable')).toBe(0);
    } finally {
      Object.defineProperty(process, 'stdin', { value: originalStdin, configurable: true });
    }
  });

  test('alt-screen is entered before pickDecision runs and exited after -- both exactly once on the "quit" path', async () => {
    const { deps } = fakeFullDeps();
    const order: string[] = [];
    const hooks: RunTuiHooks = {
      enterAltScreen: () => order.push('enter'),
      pickDecision: async () => {
        order.push('pick');
        return { kind: 'quit' };
      },
      exitAltScreen: () => order.push('exit'),
    };

    const code = await runTuiWithDeps(deps, hooks);

    expect(code).toBe(0);
    expect(order).toEqual(['enter', 'pick', 'exit']);
  });

  test('exitAltScreen still runs, and the error still propagates, when pickDecision throws (finding #1)', async () => {
    const { deps } = fakeFullDeps();
    const enter = countCalls(() => {});
    const exit = countCalls(() => {});
    const boom = new Error('ink crashed');
    const hooks: RunTuiHooks = {
      enterAltScreen: enter.wrapped,
      pickDecision: async () => {
        throw boom;
      },
      exitAltScreen: exit.wrapped,
    };

    await expect(runTuiWithDeps(deps, hooks)).rejects.toBe(boom);
    expect(enter.count()).toBe(1);
    // The whole point of finding #1: exiting the alt-screen must not be
    // skipped just because the screen threw instead of resolving.
    expect(exit.count()).toBe(1);
  });

  test('dependency close ordering: both repositories are closed exactly once each, after the decision resolves', async () => {
    const { deps, configRepository, launchPlanRepository } = fakeFullDeps();
    const hooks: RunTuiHooks = { pickDecision: async () => ({ kind: 'quit' }) };

    await runTuiWithDeps(deps, hooks);

    expect(configRepository.closeCallCount).toBe(1);
    expect(launchPlanRepository.closeCallCount).toBe(1);
  });

  test('dependencies are still closed exactly once each when pickDecision throws', async () => {
    const { deps, configRepository, launchPlanRepository } = fakeFullDeps();
    const hooks: RunTuiHooks = {
      pickDecision: async () => {
        throw new Error('boom');
      },
    };

    await expect(runTuiWithDeps(deps, hooks)).rejects.toThrow('boom');
    expect(configRepository.closeCallCount).toBe(1);
    expect(launchPlanRepository.closeCallCount).toBe(1);
  });

  test('listConfigRevisions failure: never enters the alt-screen, prints a typed error, closes deps, and returns 1', async () => {
    const { deps, configRepository } = fakeFullDeps();
    configRepository.listAllError = new Error('disk on fire');
    let entered = false;
    const hooks: RunTuiHooks = {
      enterAltScreen: () => {
        entered = true;
      },
      pickDecision: async () => {
        throw new Error('must not be called -- listConfigRevisions already failed');
      },
    };

    const code = await runTuiWithDeps(deps, hooks);

    expect(code).toBe(1);
    expect(entered).toBe(false);
    expect(errors.join('\n')).toContain(t('unexpectedFailure', { message: 'disk on fire' }));
  });

  test('plan.phase !== "applying" (revision vanished between list rendering and launch): prints the failure block, never calls launchOmp, still closes deps', async () => {
    const { deps, configRepository, ompPort } = fakeFullDeps();
    // The revision is NOT added to the repository -- `runAutoConfirmLaunch`
    // -> `prepareLaunchPlan` -> `getConfigRevisionDetail` will fail to
    // resolve it, landing the plan in `failed` instead of `applying`,
    // exactly as if it had been deleted between the list screen rendering
    // and the user pressing Enter.
    const decision: TuiDecision = { kind: 'launch', revision: revision({ configName: 'ghost', revisionId: 'rev-vanished' }) };
    const hooks: RunTuiHooks = { ...noAltScreen, pickDecision: async () => decision };

    const code = await runTuiWithDeps(deps, hooks);

    expect(code).toBe(1);
    expect(logs.join('\n')).toContain('rev-vanished');
    expect(logs.join('\n')).toContain('failed');
    // `launchOmp` (via the OMP port) must never be reached for a plan that
    // never made it to `applying`.
    expect(ompPort.lastSpawnParams).toBeNull();
  });

  test('handoff line prints after confirmation and strictly before launchOmp spawns the process', async () => {
    const { deps, configRepository, ompPort } = fakeFullDeps();
    const target = revision({ configName: 'general', revisionId: 'rev-1' });
    configRepository.add(target);
    const events: string[] = [];
    const originalSpawn = ompPort.spawn.bind(ompPort);
    ompPort.spawn = async (params) => {
      events.push('spawn');
      return originalSpawn(params);
    };
    const realConsoleLog = console.log;
    console.log = (...args: unknown[]) => {
      const line = args.map(String).join(' ');
      if (line === t('handoffLine')) {
        events.push('handoff');
      }
      realConsoleLog(...args);
    };
    const hooks: RunTuiHooks = { ...noAltScreen, pickDecision: async () => ({ kind: 'launch', revision: target }) };

    const code = await runTuiWithDeps(deps, hooks);

    expect(code).toBe(0);
    expect(events).toEqual(['handoff', 'spawn']);
  });

  test('a successful launch reaches the final status block and returns 0', async () => {
    const { deps, configRepository } = fakeFullDeps();
    configRepository.add(revision({ configName: 'general', revisionId: 'rev-1' }));
    const hooks: RunTuiHooks = {
      ...noAltScreen,
      pickDecision: async () => ({ kind: 'launch', revision: revision({ configName: 'general', revisionId: 'rev-1' }) }),
    };

    const code = await runTuiWithDeps(deps, hooks);

    expect(code).toBe(0);
    expect(logs.join('\n')).toContain('Phase: succeeded');
  });
});
