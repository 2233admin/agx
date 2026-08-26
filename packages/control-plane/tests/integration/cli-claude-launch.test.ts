/**
 * `[Story 4.6]` `configs use/switch --client claude-code` CLI entrypoint --
 * covers the spec's I/O & Edge-Case Matrix end to end through `main()`
 * (real SQLite, `CliOverrides`-injected fake Claude ports), mirroring
 * `tests/integration/cli-launch.test.ts`'s shape for the OMP side.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { main } from '../../src/cli/index';
import { SqliteConfigRevisionRepository } from '../../src/adapters/sqlite/repository';
import { SUPPLY_REF_REJECTION_MARKER } from '../../src/cli/supply-root';
import { known } from '../../src/domain/facts';
import type { Fact } from '../../src/domain/facts';
import type { CapabilityReference, SourceCategory, StableConfigRevision } from '../../src/domain/config';
import type {
  ClaudeCapabilityProbePort,
  ClaudeCapabilityProbeResult,
  ClaudeInvocationDirPort,
  ClaudeLaunchContext,
  ClaudeLaunchContextWriter,
  ClaudeProcessPort,
  ClaudeSpawnParams,
  ClaudeSpawnResult,
} from '../../src/application/ports';

function ref(
  kind: CapabilityReference['kind'],
  name: string,
  sourceRef: CapabilityReference['sourceRef'],
  sourceCategory: SourceCategory = 'project-capability',
): CapabilityReference {
  return {
    kind,
    name,
    sourceCategory: known(sourceCategory),
    summary: known(`${kind} reference: ${name}`),
    sourceRef,
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
    skills: overrides.skills ?? [],
    mcp: overrides.mcp ?? [],
    hooks: overrides.hooks ?? [],
    plugins: overrides.plugins ?? [],
    triggerCategory: overrides.triggerCategory ?? 'new-scenario',
    evidenceRef: overrides.evidenceRef ?? 'test-evidence',
    supersedesRevisionId: overrides.supersedesRevisionId ?? null,
  };
}

function probeResult(overrides: Partial<ClaudeCapabilityProbeResult> & { capabilityId: string }): ClaudeCapabilityProbeResult {
  return {
    capabilityId: overrides.capabilityId,
    subject: overrides.subject ?? `subject for ${overrides.capabilityId}`,
    required: overrides.required ?? true,
    status: overrides.status ?? 'supported',
    validationMethod: overrides.validationMethod ?? 'mechanical',
    evidenceRef: overrides.evidenceRef ?? `evidence for ${overrides.capabilityId}`,
    observedAt: overrides.observedAt ?? '2026-01-01T00:00:00Z',
  };
}

function allSupportedProbeResults(): ClaudeCapabilityProbeResult[] {
  return [
    probeResult({ capabilityId: 'claude.permission-mode-control', required: true, status: 'supported' }),
    probeResult({ capabilityId: 'claude.mcp-project-scope-control', required: true, status: 'supported' }),
    probeResult({ capabilityId: 'claude.setting-sources-control', required: true, status: 'supported' }),
    probeResult({ capabilityId: 'claude.hook-deny-return-value', required: false, status: 'unknown' }),
    probeResult({ capabilityId: 'claude.plugin-dir-delivery', required: true, status: 'supported' }),
    probeResult({ capabilityId: 'claude.append-system-prompt-delivery', required: true, status: 'supported' }),
  ];
}

class FakeClaudeProcessPort implements ClaudeProcessPort {
  version: Fact<string> = known('2.1.241');
  detectVersionCalls = 0;
  spawnResult: ClaudeSpawnResult = { exitCode: 0, signal: null };
  spawnError: Error | null = null;
  lastSpawnParams: ClaudeSpawnParams | null = null;

  async detectVersion() {
    this.detectVersionCalls += 1;
    return this.version;
  }

  async captureHelpText() {
    return known('');
  }

  async spawn(params: ClaudeSpawnParams): Promise<ClaudeSpawnResult> {
    this.lastSpawnParams = params;
    if (this.spawnError !== null) {
      throw this.spawnError;
    }
    return this.spawnResult;
  }
}

class FakeClaudeCapabilityProbe implements ClaudeCapabilityProbePort {
  results: readonly ClaudeCapabilityProbeResult[] = allSupportedProbeResults();

  async probeHardControlCapabilities(): Promise<readonly ClaudeCapabilityProbeResult[]> {
    return this.results;
  }
}

class FakeClaudeLaunchContextWriter implements ClaudeLaunchContextWriter {
  readonly written: ClaudeLaunchContext[] = [];

  async write(context: ClaudeLaunchContext): Promise<string> {
    this.written.push(context);
    return `/fake/claude-launch-context/${context.planId}.json`;
  }
}

class FakeClaudeInvocationDirPort implements ClaudeInvocationDirPort {
  readonly cleanedUp: string[] = [];

  constructor(private readonly baseDir: string) {}

  async prepare(operationId: string): Promise<string> {
    const dir = path.join(this.baseDir, operationId);
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  async cleanup(invocationDir: string): Promise<void> {
    this.cleanedUp.push(invocationDir);
    rmSync(invocationDir, { recursive: true, force: true });
  }
}

let tmpDir: string;
let invocationBaseDir: string;
let dbPath: string;
let logs: string[];
let errors: string[];
let originalLog: typeof console.log;
let originalError: typeof console.error;
let claudeProcessPort: FakeClaudeProcessPort;
let claudeCapabilityProbe: FakeClaudeCapabilityProbe;
let claudeLaunchContextWriter: FakeClaudeLaunchContextWriter;
let claudeInvocationDirPort: FakeClaudeInvocationDirPort;
/**
 * `[Story 3.4]` 每个测试前后保存并恢复（不是只 `delete`）：自我开发本仓的人
 * 完全可能在环境里正当地导出了 `CONTROL_PLANE_SUPPLY_ROOT`，本套件不得把它
 * 抹掉给下一个测试文件用。
 */
let originalSupplyRoot: string | undefined;

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), 'control-plane-cli-claude-launch-'));
  invocationBaseDir = path.join(tmpDir, 'invocations');
  mkdirSync(invocationBaseDir, { recursive: true });
  dbPath = path.join(tmpDir, 'db.sqlite3');
  process.env.CONTROL_PLANE_DB_PATH = dbPath;
  process.env.CONFIGS_LANG = 'en';
  // `[Story 3.4]` 下面每一条 `sourceRef` 都是相对这个根的。
  originalSupplyRoot = process.env.CONTROL_PLANE_SUPPLY_ROOT;
  process.env.CONTROL_PLANE_SUPPLY_ROOT = tmpDir;

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

  claudeProcessPort = new FakeClaudeProcessPort();
  claudeCapabilityProbe = new FakeClaudeCapabilityProbe();
  claudeLaunchContextWriter = new FakeClaudeLaunchContextWriter();
  claudeInvocationDirPort = new FakeClaudeInvocationDirPort(invocationBaseDir);
});

afterEach(() => {
  console.log = originalLog;
  console.error = originalError;
  delete process.env.CONTROL_PLANE_DB_PATH;
  delete process.env.CONFIGS_LANG;
  if (originalSupplyRoot === undefined) {
    delete process.env.CONTROL_PLANE_SUPPLY_ROOT;
  } else {
    process.env.CONTROL_PLANE_SUPPLY_ROOT = originalSupplyRoot;
  }
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
  return { claudeProcessPort, claudeCapabilityProbe, claudeLaunchContextWriter, claudeInvocationDirPort };
}

/**
 * 在供给根下写出真实存在的 skill 目录与指令文件，好让物化真的能成功。
 * `[Story 3.4]` 返回的是**供给根内相对 POSIX** 形态的 `sourceRef`，即唯一
 * 合法形态。
 */
function makeRealSkillAndInstruction(): { readonly skillRef: string; readonly instructionRef: string } {
  mkdirSync(path.join(tmpDir, 'skills', 'my-skill'), { recursive: true });
  writeFileSync(path.join(tmpDir, 'skills', 'my-skill', 'SKILL.md'), '# My Skill\n', 'utf8');
  writeFileSync(path.join(tmpDir, 'instructions.md'), 'Be a helpful agent.', 'utf8');

  return { skillRef: 'skills/my-skill', instructionRef: 'instructions.md' };
}

describe('configs use --client claude-code', () => {
  test('无 active plan + 真实内容物化: fresh launch reaches succeeded, delivers --plugin-dir/--append-system-prompt', async () => {
    const { skillRef, instructionRef } = makeRealSkillAndInstruction();
    seed([
      sampleRevision({
        configName: 'general',
        revisionId: 'rev-1',
        skills: [ref('skill', 'my-skill', known(skillRef))],
        instructions: [ref('instruction', 'core', known(instructionRef), 'project-prompt')],
      }),
    ]);

    const code = await main(['use', 'rev-1', '--client', 'claude-code', '--yes'], overrides());
    expect(code).toBe(0);
    const output = logs.join('\n');
    expect(output).toContain('Phase: succeeded');
    expect(output).toContain('Apply result: applied');
    expect(claudeProcessPort.detectVersionCalls).toBe(1);
    expect(claudeProcessPort.lastSpawnParams).not.toBeNull();
    expect(claudeProcessPort.lastSpawnParams!.argv).toContain('--plugin-dir');
    expect(claudeProcessPort.lastSpawnParams!.argv).toContain('--append-system-prompt');
    expect(claudeLaunchContextWriter.written).toHaveLength(1);
  });

  test('已有 active Claude plan: switch/use both go straight to requires-restart, no confirmation, no spawn', async () => {
    seed([sampleRevision({ configName: 'general', revisionId: 'rev-1' }), sampleRevision({ configName: 'reviewer', revisionId: 'rev-2' })]);

    const first = await main(['use', 'rev-1', '--client', 'claude-code', '--yes'], overrides());
    expect(first).toBe(0);
    logs = [];
    claudeProcessPort.lastSpawnParams = null;

    const code = await main(['switch', 'rev-2', '--client', 'claude-code', '--yes'], overrides());
    expect(code).toBe(0);
    const output = logs.join('\n');
    expect(output).toContain('Phase: requires-restart');
    expect(output).not.toMatch(/Proceed with this launch/);
    expect(claudeProcessPort.lastSpawnParams).toBeNull();
  });

  test('已有 active Claude plan via plain `use` (not just `switch`) also resolves to requires-restart', async () => {
    seed([sampleRevision({ configName: 'general', revisionId: 'rev-1' }), sampleRevision({ configName: 'reviewer', revisionId: 'rev-2' })]);

    await main(['use', 'rev-1', '--client', 'claude-code', '--yes'], overrides());
    logs = [];
    claudeProcessPort.lastSpawnParams = null;

    const code = await main(['use', 'rev-2', '--client', 'claude-code', '--yes'], overrides());
    expect(code).toBe(0);
    expect(logs.join('\n')).toContain('Phase: requires-restart');
    expect(claudeProcessPort.lastSpawnParams).toBeNull();
  });

  test('[Story 4.6 review fix] 上一次尝试以 failed 收场: does NOT permanently misreport as already-running -- a later attempt still reaches a real fresh launch', async () => {
    seed([sampleRevision({ configName: 'general', revisionId: 'rev-1', mcp: [ref('mcp', 'a-server', known('/does-not-matter'))] })]);
    // First attempt: required capability unsupported -> the plan lands on
    // `failed` (not `succeeded`/`degraded`), and IS still `findActiveForClient`'s
    // most-recently-created plan afterward.
    claudeCapabilityProbe.results = allSupportedProbeResults().map((result) =>
      result.capabilityId === 'claude.mcp-project-scope-control' ? { ...result, status: 'unsupported' } : result,
    );
    const firstCode = await main(['use', 'rev-1', '--client', 'claude-code', '--yes'], overrides());
    expect(firstCode).toBe(1);
    logs = [];

    // Second attempt against a different (now fully-supported) revision:
    // must NOT short-circuit to `requires-restart` just because a `failed`
    // plan for this client exists -- it must run the real fresh flow.
    seed([sampleRevision({ configName: 'reviewer', revisionId: 'rev-2' })]);
    claudeCapabilityProbe.results = allSupportedProbeResults();
    const secondCode = await main(['use', 'rev-2', '--client', 'claude-code', '--yes'], overrides());
    expect(secondCode).toBe(0);
    const output = logs.join('\n');
    expect(output).toContain('Phase: succeeded');
    expect(output).not.toContain('requires-restart');
    expect(claudeProcessPort.lastSpawnParams).not.toBeNull();
  });

  test('[Story 4.6 review fix] 上一次确认被用户拒绝 (cancelled): also does not misreport as already-running', async () => {
    seed([sampleRevision({ configName: 'general', revisionId: 'rev-1' })]);
    const originalStdin = process.stdin;
    const fakeStdin = createFakeStdin('n\n');
    Object.defineProperty(process, 'stdin', { value: fakeStdin, configurable: true });
    try {
      const firstCode = await main(['use', 'rev-1', '--client', 'claude-code'], overrides());
      expect(firstCode).toBe(1);
    } finally {
      Object.defineProperty(process, 'stdin', { value: originalStdin, configurable: true });
    }
    logs = [];

    const secondCode = await main(['use', 'rev-1', '--client', 'claude-code', '--yes'], overrides());
    expect(secondCode).toBe(0);
    const output = logs.join('\n');
    expect(output).toContain('Phase: succeeded');
    expect(claudeProcessPort.lastSpawnParams).not.toBeNull();
  });

  test('配置修订不存在: renders launch failure, exit code 1, never spawns', async () => {
    const code = await main(['use', 'does-not-exist', '--client', 'claude-code', '--yes'], overrides());
    expect(code).toBe(1);
    const output = logs.join('\n');
    expect(output).toContain('does-not-exist');
    expect(claudeProcessPort.lastSpawnParams).toBeNull();
  });

  test('用户拒绝确认: interactive rejection cancels the plan and never spawns claude', async () => {
    seed([sampleRevision({ configName: 'general', revisionId: 'rev-1' })]);

    const originalStdin = process.stdin;
    const fakeStdin = createFakeStdin('n\n');
    Object.defineProperty(process, 'stdin', { value: fakeStdin, configurable: true });
    try {
      const code = await main(['use', 'rev-1', '--client', 'claude-code'], overrides());
      expect(code).toBe(1);
      const output = logs.join('\n');
      expect(output).toContain('cancelled');
      expect(claudeProcessPort.lastSpawnParams).toBeNull();
    } finally {
      Object.defineProperty(process, 'stdin', { value: originalStdin, configurable: true });
    }
  });

  test('必需硬控制能力 unsupported: fails before spawn, shows phase/reason/affected-capabilities/recovery-action, exit code 1', async () => {
    seed([sampleRevision({ configName: 'general', revisionId: 'rev-1', mcp: [ref('mcp', 'a-server', known('/does-not-matter'))] })]);
    claudeCapabilityProbe.results = allSupportedProbeResults().map((result) =>
      result.capabilityId === 'claude.mcp-project-scope-control' ? { ...result, status: 'unsupported' } : result,
    );

    const code = await main(['use', 'rev-1', '--client', 'claude-code', '--yes'], overrides());
    expect(code).toBe(1);
    const output = logs.join('\n');
    expect(output).toContain('failed');
    expect(output).toContain('claude.mcp-project-scope-control');
    expect(claudeProcessPort.lastSpawnParams).toBeNull();
    // `[Story 4.6 review fix]` The CLI must surface the outcome-specific
    // `affectedCapabilities`/`recoveryAction` -- not just the generic,
    // static `failure.recovery` text every OMP failure also shows.
    expect(output).toContain('Affected capabilities: claude.mcp-project-scope-control');
    expect(output).toContain('Claude recovery:');
    expect(output).toContain('确认 Claude Code 版本/环境支持上述必需能力');
  });

  test('必需内容引用 sourceRef 不可读: content-materialization fail-closed before spawn, exit code 1', async () => {
    seed([
      sampleRevision({
        configName: 'general',
        revisionId: 'rev-1',
        skills: [ref('skill', 'missing-skill', known('does-not-exist-skill-dir'))],
      }),
    ]);

    const code = await main(['use', 'rev-1', '--client', 'claude-code', '--yes'], overrides());
    expect(code).toBe(1);
    const output = logs.join('\n');
    expect(output).toContain('failed');
    expect(output).toContain('claude.plugin-dir-delivery');
    expect(claudeProcessPort.lastSpawnParams).toBeNull();
    expect(output).toContain('Affected capabilities: claude.plugin-dir-delivery');
    expect(output).toContain('Claude recovery:');
  });

  test('[Story 3.4] 非法 sourceRef 的诊断必须抵达用户可见输出：同时含非法值与当时生效的供给根', async () => {
    // 本 Story 的 Problem 就是「无门可指根因」。拒绝原因只有一路活过
    // `resolveSourcePath` 到终端之间的每一层才有用——只在 adapter 边界断言的话，
    // `describeMaterializationFailures` 把原因丢掉、只打裸 capability 名，测试
    // 是发现不了的。
    const illegalRef = '../escaped-outside-the-supply-root';
    seed([
      sampleRevision({
        configName: 'general',
        revisionId: 'rev-1',
        skills: [ref('skill', 'escaping-skill', known(illegalRef))],
      }),
    ]);

    const code = await main(['use', 'rev-1', '--client', 'claude-code', '--yes'], overrides());
    expect(code).toBe(1);
    const output = logs.join('\n');
    expect(output).toContain(SUPPLY_REF_REJECTION_MARKER);
    expect(output).toContain(illegalRef);
    expect(output).toContain(path.resolve(tmpDir));
    expect(claudeProcessPort.lastSpawnParams).toBeNull();
  });

  test('claude 进程非零退出: shows failure phase/reason, does not fabricate success', async () => {
    seed([sampleRevision({ configName: 'general', revisionId: 'rev-1' })]);
    claudeProcessPort.spawnResult = { exitCode: 7, signal: null };

    const code = await main(['use', 'rev-1', '--client', 'claude-code', '--yes'], overrides());
    expect(code).toBe(1);
    const output = logs.join('\n');
    expect(output).toContain('failed');
    expect(output).toContain('7');
  });

  test('[Story 4.6 review fix] forwarded args after `--` are rejected as a typed usage error, not silently dropped', async () => {
    const code = await main(['use', 'rev-1', '--client', 'claude-code', '--yes', '--', 'do the task'], overrides());
    expect(code).toBe(2);
    expect(errors.join('\n')).toContain('forwarded arguments after `--` are not supported yet with `--client claude-code`');
    // Rejected ahead of opening the repositories entirely.
    expect(claudeProcessPort.lastSpawnParams).toBeNull();
  });
});

describe('configs use --client omp (regression)', () => {
  test('OMP 路径不受 Claude 支持翻转影响: still requires the real OMP ports, unaffected by claude-code becoming supported', async () => {
    // No claude overrides passed at all -- if dispatch ever accidentally
    // routed `--client omp` through the Claude flow, this would either
    // throw (missing ports) or behave differently; it must behave exactly
    // like the pre-existing OMP suite (`tests/integration/cli-launch.test.ts`).
    const code = await main(['use', 'rev-1', '--client', 'omp']);
    // No revision seeded and no OMP overrides -- this asserts not just that
    // the command fails, but specifically *why* (the OMP revision-lookup
    // failure path), so a future dispatch bug that accidentally routed
    // `--client omp` through the Claude flow (which would fail differently
    // -- e.g. with a "prepared-failed"/Claude-specific reason string, or
    // not at all) would be caught here rather than passing on a bare
    // `code === 1` coincidence.
    expect(code).toBe(1);
    const output = logs.join('\n');
    expect(output).toContain('configuration revision not found: rev-1');
    expect(output).toContain('Launch plan');
    expect(output).toContain('failed');
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
