import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { main } from '../../src/cli/index';
import { SqliteConfigRevisionRepository } from '../../src/adapters/sqlite/repository';
import { t } from '../../src/cli/i18n';
import { known } from '../../src/domain/facts';
import type { CapabilityReference, SourceCategory, StableConfigRevision } from '../../src/domain/config';
import type {
  CapabilityProbeResult,
  LaunchContext,
  LaunchContextWriter,
  OmpProcessPort,
  OmpSpawnParams,
  OmpSpawnResult,
  OmpCapabilityProbePort,
} from '../../src/application/ports';
import type { Fact } from '../../src/domain/facts';

function ref(kind: CapabilityReference['kind'], name: string, sourceCategory: SourceCategory = 'project-capability'): CapabilityReference {
  return {
    kind,
    name,
    sourceCategory: known(sourceCategory),
    summary: known('skill'),
    sourceRef: known(`ref/${name}`),
    contentFingerprint: known(`fingerprint/${name}`),
  };
}

function sampleRevision(overrides: Partial<StableConfigRevision> & { configName: string; revisionId: string }): StableConfigRevision {
  return {
    configName: overrides.configName,
    revisionId: overrides.revisionId,
    defaultMarker: overrides.defaultMarker ?? known(false),
    scopeBoundary: overrides.scopeBoundary ?? known('a scope boundary'),
    availability: overrides.availability ?? known('resolved'),
    instructions: overrides.instructions ?? [],
    skills: overrides.skills ?? [ref('skill', 'openspec-explore')],
    mcp: overrides.mcp ?? [],
    hooks: overrides.hooks ?? [],
    plugins: overrides.plugins ?? [],
    triggerCategory: overrides.triggerCategory ?? 'new-scenario',
    evidenceRef: overrides.evidenceRef ?? 'test-evidence',
    supersedesRevisionId: overrides.supersedesRevisionId ?? null,
  };
}

class FakeOmpProcessPort implements OmpProcessPort {
  version: Fact<string> = known('17.4.1');
  detectVersionCalls = 0;
  spawnResult: OmpSpawnResult = { exitCode: 0, signal: null };
  lastSpawnParams: OmpSpawnParams | null = null;

  async detectVersion() {
    this.detectVersionCalls += 1;
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

let tmpDir: string;
let dbPath: string;
let logs: string[];
let errors: string[];
let originalLog: typeof console.log;
let originalError: typeof console.error;
let ompPort: FakeOmpProcessPort;
let capabilityProbe: FakeOmpCapabilityProbe;
let contextWriter: FakeLaunchContextWriter;

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), 'control-plane-cli-launch-'));
  dbPath = path.join(tmpDir, 'db.sqlite3');
  process.env.CONTROL_PLANE_DB_PATH = dbPath;
  // `[DELTA]` default output language is now `zh`; these assertions were
  // written against the (unchanged) English strings, so pin the language
  // explicitly rather than rewrite every assertion.
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

  ompPort = new FakeOmpProcessPort();
  capabilityProbe = new FakeOmpCapabilityProbe();
  contextWriter = new FakeLaunchContextWriter();
});

afterEach(() => {
  console.log = originalLog;
  console.error = originalError;
  delete process.env.CONTROL_PLANE_DB_PATH;
  delete process.env.CONFIGS_LANG;
  rmSync(tmpDir, { recursive: true, force: true });
});

function seed(revisions: readonly StableConfigRevision[]): void {
  const repo = new SqliteConfigRevisionRepository(dbPath);
  try {
    repo.seed(revisions);
  } finally {
    repo.close();
  }
}

function overrides() {
  return { ompPort, capabilityProbe, contextWriter };
}

describe('configs use', () => {
  test('选择+一次确认+启动成功: --yes launches through prepared->awaiting-confirmation->applying->observing->succeeded, prints status once', async () => {
    seed([sampleRevision({ configName: 'general', revisionId: 'rev-1' })]);

    const code = await main(['use', 'rev-1', '--yes'], overrides());
    expect(code).toBe(0);
    const output = logs.join('\n');
    // Confirmation summary shown exactly once, then final status.
    expect(output.match(/one-time confirmation/g)?.length).toBe(1);
    expect(output).toContain('Phase: succeeded');
    expect(output).toContain('Apply result: applied');
    expect(ompPort.detectVersionCalls).toBe(1);
    expect(output.match(/17\.4\.1/g)?.length).toBe(2);
    expect(ompPort.lastSpawnParams).not.toBeNull();

    // The handoff line (DESIGN.md `{components.handoff-line}`) is printed
    // exactly once, after confirmation is granted (i.e. after the
    // confirmation summary's closing sentence) and before `omp` "takes
    // over" -- which here means before the final status block, since the
    // final status can only be known once `launchOmp` has returned.
    const handoffLine = t('handoffLine');
    const handoffMatches = output.split(handoffLine).length - 1;
    expect(handoffMatches).toBe(1);
    const confirmationIndex = output.indexOf('one-time confirmation');
    const handoffIndex = output.indexOf(handoffLine);
    const finalStatusIndex = output.indexOf('Phase: succeeded');
    expect(handoffIndex).toBeGreaterThan(confirmationIndex);
    expect(handoffIndex).toBeLessThan(finalStatusIndex);
  });

  // `[Story 4.6]` `claude-code` is no longer an unsupported client at this
  // gate (`resolveClientSupport('claude-code')` now returns `supported:
  // true` -- Story 4.1~4.5b delivered a real adapter). `codex-cli` remains
  // the one client this CLI-level "unsupported" path still exercises; see
  // `tests/integration/cli-claude-launch.test.ts` for `claude-code`'s own
  // (now-supported) coverage.
  test('不支持的客户端: codex-cli returns immediately, no confirmation, no db file ever created', async () => {
    const code = await main(['use', 'rev-1', '--client', 'codex-cli'], overrides());
    expect(code).toBe(1);
    const output = logs.join('\n');
    expect(output).toContain('not supported yet');
    expect(output).not.toMatch(/one-time confirmation/);
    expect(ompPort.lastSpawnParams).toBeNull();
    // Boundaries & Constraints: an unsupported-client selection must return
    // before any plan is created -- and before the sqlite repositories are
    // even opened, so the db file (and its migrations) must never exist.
    expect(existsSync(dbPath)).toBe(false);
  });

  test('配置不存在: shows typed failure, exits non-zero, never starts OMP', async () => {
    const code = await main(['use', 'does-not-exist', '--yes'], overrides());
    expect(code).toBe(1);
    const output = logs.join('\n');
    expect(output).toContain('does-not-exist');
    expect(ompPort.lastSpawnParams).toBeNull();
  });

  test('用户拒绝确认: interactive rejection cancels the plan and never starts OMP', async () => {
    seed([sampleRevision({ configName: 'general', revisionId: 'rev-1' })]);

    const originalStdin = process.stdin;
    const fakeStdin = createFakeStdin('n\n');
    Object.defineProperty(process, 'stdin', { value: fakeStdin, configurable: true });
    try {
      const code = await main(['use', 'rev-1'], overrides());
      expect(code).toBe(1);
      const output = logs.join('\n');
      expect(output).toContain('cancelled');
      expect(ompPort.lastSpawnParams).toBeNull();
    } finally {
      Object.defineProperty(process, 'stdin', { value: originalStdin, configurable: true });
    }
  });

  test('OMP 进程非零退出: shows failure phase/reason, does not fabricate success', async () => {
    seed([sampleRevision({ configName: 'general', revisionId: 'rev-1' })]);
    ompPort.spawnResult = { exitCode: 3, signal: null };

    const code = await main(['use', 'rev-1', '--yes'], overrides());
    expect(code).toBe(1);
    const output = logs.join('\n');
    expect(output).toContain('failed');
    expect(output).toContain('3');
  });

  test('Instructions/MCP 无法在 MVP 内真实装配: non-empty instructions -> degraded status, still exit 0', async () => {
    seed([
      sampleRevision({
        configName: 'general',
        revisionId: 'rev-1',
        instructions: [ref('instruction', 'i1', 'project-prompt')],
      }),
    ]);

    const code = await main(['use', 'rev-1', '--yes'], overrides());
    expect(code).toBe(0);
    const output = logs.join('\n');
    expect(output).toContain('Phase: degraded');
    expect(output).toContain('instructions-content-not-materialized-in-mvp');
  });

  test('forwarded args after -- are passed through opaquely to the OMP port', async () => {
    seed([sampleRevision({ configName: 'general', revisionId: 'rev-1' })]);
    const code = await main(['use', 'rev-1', '--yes', '--', 'do the task', '--not-a-real-flag'], overrides());
    expect(code).toBe(0);
    expect(ompPort.lastSpawnParams!.forwardedArgs).toEqual(['do the task', '--not-a-real-flag']);
  });

  test('denylisted forwarded arg (-e) is rejected with a typed usage error before any DB write or spawn', async () => {
    const code = await main(['use', 'rev-1', '--yes', '--', '-e', '/some/other/extension.ts'], overrides());
    expect(code).toBe(2);
    expect(errors.join('\n')).toContain('forwarded argument "-e" is not allowed');
    // Rejected ahead of opening the repositories entirely -- no db file, no spawn.
    expect(existsSync(dbPath)).toBe(false);
    expect(ompPort.lastSpawnParams).toBeNull();
  });

  test('denylisted forwarded arg (--profile=other) is rejected before any DB write or spawn', async () => {
    const code = await main(['use', 'rev-1', '--yes', '--', '--profile=other'], overrides());
    expect(code).toBe(2);
    expect(errors.join('\n')).toContain('forwarded argument "--profile=other" is not allowed');
    expect(existsSync(dbPath)).toBe(false);
    expect(ompPort.lastSpawnParams).toBeNull();
  });

  test('denylisted forwarded arg (--resume) is rejected before any DB write or spawn', async () => {
    const code = await main(['use', 'rev-1', '--yes', '--', '--resume', 'session-id'], overrides());
    expect(code).toBe(2);
    expect(errors.join('\n')).toContain('forwarded argument "--resume" is not allowed');
    expect(existsSync(dbPath)).toBe(false);
    expect(ompPort.lastSpawnParams).toBeNull();
  });

  test('confirmation summary echoes non-denylisted forwarded args before confirmation is asked', async () => {
    seed([sampleRevision({ configName: 'general', revisionId: 'rev-1' })]);
    const code = await main(['use', 'rev-1', '--yes', '--', 'do the task', '--not-a-real-flag'], overrides());
    expect(code).toBe(0);
    const output = logs.join('\n');
    // The forwarded args must appear in the confirmation summary, i.e.
    // before the "one-time confirmation" marker line that closes it.
    const confirmationIndex = output.indexOf('one-time confirmation');
    const forwardedIndex = output.indexOf('do the task --not-a-real-flag');
    expect(forwardedIndex).toBeGreaterThan(-1);
    expect(forwardedIndex).toBeLessThan(confirmationIndex);
  });
});

describe('configs status', () => {
  test('查看启动状态: shows revision/client/version/phase/apply result/known differences for the most recent plan', async () => {
    seed([sampleRevision({ configName: 'general', revisionId: 'rev-1' })]);
    await main(['use', 'rev-1', '--yes'], overrides());
    logs = [];

    const code = await main(['status'], overrides());
    expect(code).toBe(0);
    const output = logs.join('\n');
    expect(output).toContain('Revision: rev-1');
    expect(output).toContain('Client: omp');
    expect(output).toContain('Phase: succeeded');
  });

  test('no plan yet: typed not-found message, exits non-zero', async () => {
    const code = await main(['status'], overrides());
    expect(code).toBe(1);
    expect(logs.join('\n')).toContain('No launch plan found');
  });
});

describe('configs switch', () => {
  test('运行中配置切换: switching from a succeeded plan requires a restart and a fresh confirmation for the new plan', async () => {
    seed([
      sampleRevision({ configName: 'general', revisionId: 'rev-1' }),
      sampleRevision({ configName: 'reviewer', revisionId: 'rev-2' }),
    ]);
    await main(['use', 'rev-1', '--yes'], overrides());
    logs = [];

    const code = await main(['switch', 'rev-2', '--yes'], overrides());
    expect(code).toBe(0);
    const output = logs.join('\n');
    expect(output).toContain('requires a restart');
    expect(output).toContain('Revision: rev-2');
    expect(output).toContain('Phase: succeeded');
    expect(ompPort.detectVersionCalls).toBe(2);
  });
});

function createFakeStdin(input: string) {
  const emitter = new EventEmitter();
  return Object.assign(emitter, {
    resume: () => {
      queueMicrotask(() => emitter.emit('data', input));
    },
    pause: () => {},
    setEncoding: () => {},
  });
}
