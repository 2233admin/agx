import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  computeClaudeKnownDifferences,
  launchClaudeFresh,
  prepareClaudeAlreadyRunningLaunchPlan,
  prepareClaudeFreshLaunchPlan,
  type LaunchClaudeFreshDeps,
} from '../../src/application/claude-launch';
import { FsClaudeContentMaterializer } from '../../src/adapters/clients/claude/content-materializer';
import { InvalidTransitionError, LaunchPlanNotFoundError, confirmLaunchPlan, rejectLaunchPlan } from '../../src/application/launch';
import { transitionLaunchPlan } from '../../src/domain/activation';
import type { ClientId } from '../../src/domain/client';
import type { LaunchPlan } from '../../src/domain/activation';
import { isKnown, known, unknown } from '../../src/domain/facts';
import type { CapabilityReference, StableConfigRevision } from '../../src/domain/config';
import type {
  ClaudeCapabilityProbePort,
  ClaudeCapabilityProbeResult,
  ClaudeInvocationDirPort,
  ClaudeLaunchContext,
  ClaudeLaunchContextWriter,
  ClaudeProcessPort,
  ClaudeSpawnParams,
  ClaudeSpawnResult,
  ConfigRevisionRepository,
  LaunchPlanRepository,
} from '../../src/application/ports';

function ref(kind: CapabilityReference['kind'], name: string, sourceRef: CapabilityReference['sourceRef'] = known(`ref/${name}`)): CapabilityReference {
  return {
    kind,
    name,
    sourceCategory: known('project-capability'),
    summary: known(`${kind}: ${name}`),
    sourceRef,
    contentFingerprint: known(`fingerprint/${name}`),
  };
}

/** Tracks tmp dirs created by individual tests below so they always get cleaned up, even on failure. */
const tmpDirsToClean: string[] = [];

/**
 * `[Story 3.4]` 需要真实物化内容的测试，会把全仓共用的那个供给根
 * （`cli/supply-root.ts`）指向自己的临时目录，因为 `sourceRef` 如今只能是
 * 供给根内的相对 POSIX 路径——这些测试此前用的绝对 `mkdtemp` 路径会被
 * fail-closed 拒掉。覆盖值是**保存并恢复**的，不是只 `delete`，因此不可能泄漏
 * 到别的测试文件里。
 */
let originalSupplyRoot: string | undefined;
let supplyRootOverridden = false;

function useSupplyRoot(dir: string): void {
  if (!supplyRootOverridden) {
    originalSupplyRoot = process.env.CONTROL_PLANE_SUPPLY_ROOT;
    supplyRootOverridden = true;
  }
  process.env.CONTROL_PLANE_SUPPLY_ROOT = dir;
}

afterEach(() => {
  if (supplyRootOverridden) {
    if (originalSupplyRoot === undefined) {
      delete process.env.CONTROL_PLANE_SUPPLY_ROOT;
    } else {
      process.env.CONTROL_PLANE_SUPPLY_ROOT = originalSupplyRoot;
    }
    supplyRootOverridden = false;
  }
  while (tmpDirsToClean.length > 0) {
    const dir = tmpDirsToClean.pop()!;
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeTmpDir(prefix: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirsToClean.push(dir);
  return dir;
}

function revision(overrides: Partial<StableConfigRevision> & { configName: string; revisionId: string }): StableConfigRevision {
  return {
    configName: overrides.configName,
    revisionId: overrides.revisionId,
    defaultMarker: known(false),
    scopeBoundary: known('a scope boundary'),
    availability: known('resolved'),
    instructions: overrides.instructions ?? [],
    skills: overrides.skills ?? [],
    mcp: overrides.mcp ?? [],
    hooks: overrides.hooks ?? [],
    plugins: overrides.plugins ?? [],
    triggerCategory: 'new-scenario',
    evidenceRef: 'test-evidence',
    supersedesRevisionId: null,
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

function allSupportedProbeResults(overrides: Partial<Record<string, Partial<ClaudeCapabilityProbeResult>>> = {}): ClaudeCapabilityProbeResult[] {
  const base: ClaudeCapabilityProbeResult[] = [
    probeResult({ capabilityId: 'claude.permission-mode-control', required: true, status: 'supported' }),
    probeResult({ capabilityId: 'claude.mcp-project-scope-control', required: true, status: 'supported' }),
    probeResult({ capabilityId: 'claude.setting-sources-control', required: true, status: 'supported' }),
    probeResult({ capabilityId: 'claude.hook-deny-return-value', required: false, status: 'unknown' }),
    // `[Story 4.5b]` AD-21's content-materialization delivery gates.
    probeResult({ capabilityId: 'claude.plugin-dir-delivery', required: true, status: 'supported' }),
    probeResult({ capabilityId: 'claude.append-system-prompt-delivery', required: true, status: 'supported' }),
  ];
  return base.map((result) => ({ ...result, ...(overrides[result.capabilityId] ?? {}) }));
}

class FakeConfigRevisionRepository implements ConfigRevisionRepository {
  private readonly revisions = new Map<string, StableConfigRevision>();

  add(revision: StableConfigRevision): void {
    this.revisions.set(revision.revisionId, revision);
  }

  remove(revisionId: string): void {
    this.revisions.delete(revisionId);
  }

  async listAll(): Promise<readonly StableConfigRevision[]> {
    return [...this.revisions.values()];
  }

  async findById(revisionId: string): Promise<StableConfigRevision | null> {
    return this.revisions.get(revisionId) ?? null;
  }
}

class FakeLaunchPlanRepository implements LaunchPlanRepository {
  readonly plans = new Map<string, LaunchPlan>();
  readonly saveLog: LaunchPlan[] = [];

  async save(plan: LaunchPlan): Promise<void> {
    this.plans.set(plan.planId, plan);
    this.saveLog.push(plan);
  }

  async findById(planId: string): Promise<LaunchPlan | null> {
    return this.plans.get(planId) ?? null;
  }

  async findActiveForClient(client: ClientId): Promise<LaunchPlan | null> {
    const forClient = [...this.plans.values()].filter((plan) => plan.client === client);
    if (forClient.length === 0) return null;
    return forClient.reduce((latest, plan) => (plan.createdAt > latest.createdAt ? plan : latest));
  }
}

class FakeClaudeCapabilityProbe implements ClaudeCapabilityProbePort {
  results: readonly ClaudeCapabilityProbeResult[] = allSupportedProbeResults();

  async probeHardControlCapabilities(): Promise<readonly ClaudeCapabilityProbeResult[]> {
    return this.results;
  }
}

class FakeClaudeProcessPort implements ClaudeProcessPort {
  spawnResult: ClaudeSpawnResult = { exitCode: 0, signal: null };
  spawnError: Error | null = null;
  lastSpawnParams: ClaudeSpawnParams | null = null;

  async detectVersion() {
    return known('9.9.9');
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

class FakeClaudeLaunchContextWriter implements ClaudeLaunchContextWriter {
  readonly written: ClaudeLaunchContext[] = [];

  async write(context: ClaudeLaunchContext): Promise<string> {
    this.written.push(context);
    return `/fake/claude-launch-context/${context.planId}.json`;
  }
}

class FakeClaudeInvocationDirPort implements ClaudeInvocationDirPort {
  prepareError: Error | null = null;
  readonly requestedOperationIds: string[] = [];

  /**
   * `[Story 4.5b]` When `realBaseDir` is `null` (the default, used by every
   * pre-existing test), `prepare` returns a placeholder path that is never
   * dereferenced on the real filesystem -- safe as long as the revision
   * under test has no non-empty instructions/skills/mcp group (AD-21's
   * `materializeClaudeContent` only ever touches the filesystem for a
   * non-empty group with at least one resolvable reference). Tests that
   * exercise real content materialization pass a real, `mkdtemp`-created
   * `realBaseDir` instead.
   */
  readonly cleanedUp: string[] = [];

  constructor(private readonly realBaseDir: string | null = null) {}

  async prepare(operationId: string): Promise<string> {
    this.requestedOperationIds.push(operationId);
    if (this.prepareError !== null) {
      throw this.prepareError;
    }
    if (this.realBaseDir !== null) {
      const dir = path.join(this.realBaseDir, operationId);
      mkdirSync(dir, { recursive: true });
      return dir;
    }
    return `/fake/claude-invocations/${operationId}`;
  }

  async cleanup(invocationDir: string): Promise<void> {
    this.cleanedUp.push(invocationDir);
    if (this.realBaseDir !== null) {
      rmSync(invocationDir, { recursive: true, force: true });
    }
  }
}

function buildDeps(options: { readonly realInvocationBaseDir?: string } = {}) {
  const configRepository = new FakeConfigRevisionRepository();
  const launchPlanRepository = new FakeLaunchPlanRepository();
  const claudeProcessPort = new FakeClaudeProcessPort();
  const claudeCapabilityProbe = new FakeClaudeCapabilityProbe();
  const claudeLaunchContextWriter = new FakeClaudeLaunchContextWriter();
  const claudeInvocationDirPort = new FakeClaudeInvocationDirPort(options.realInvocationBaseDir ?? null);
  const claudeContentMaterializer = new FsClaudeContentMaterializer();
  const deps: LaunchClaudeFreshDeps = {
    configRepository,
    launchPlanRepository,
    claudeProcessPort,
    claudeCapabilityProbe,
    claudeLaunchContextWriter,
    claudeInvocationDirPort,
    claudeContentMaterializer,
  };
  return { deps, configRepository, launchPlanRepository, claudeProcessPort, claudeCapabilityProbe, claudeLaunchContextWriter, claudeInvocationDirPort };
}

describe('prepareClaudeFreshLaunchPlan', () => {
  test('valid revisionId prepares a plan through to awaiting-confirmation', async () => {
    const { deps, configRepository } = buildDeps();
    configRepository.add(revision({ configName: 'general', revisionId: 'rev-1' }));

    const plan = await prepareClaudeFreshLaunchPlan(deps, { revisionId: 'rev-1' });
    expect(plan.phase).toBe('awaiting-confirmation');
    expect(plan.client).toBe('claude-code');
    expect(plan.configName).toBe('general');
    expect(plan.revisionId).toBe('rev-1');
  });

  test('配置不存在: prepared -> failed, persisted, reusing ConfigNotFoundError message as the typed reason', async () => {
    const { deps } = buildDeps();
    const plan = await prepareClaudeFreshLaunchPlan(deps, { revisionId: 'does-not-exist' });
    expect(plan.phase).toBe('failed');
    expect(isKnown(plan.failureReason) && plan.failureReason.value).toContain('configuration revision not found');
  });
});

describe('launchClaudeFresh', () => {
  async function preparedAndConfirmed(deps: ReturnType<typeof buildDeps>['deps'], configRepository: FakeConfigRevisionRepository, rev: StableConfigRevision) {
    configRepository.add(rev);
    const plan = await prepareClaudeFreshLaunchPlan(deps, { revisionId: rev.revisionId });
    return confirmLaunchPlan(deps, plan.planId);
  }

  test('AC1 成功路径: prepared -> awaiting-confirmation -> applying -> observing -> succeeded, observationStage reaches launched then observed', async () => {
    const { deps, configRepository, claudeLaunchContextWriter, claudeProcessPort, claudeInvocationDirPort } = buildDeps();
    const confirmed = await preparedAndConfirmed(deps, configRepository, revision({ configName: 'general', revisionId: 'rev-1' }));
    expect(confirmed.phase).toBe('applying');

    const outcome = await launchClaudeFresh(deps, { planId: confirmed.planId });

    expect(outcome.plan.phase).toBe('succeeded');
    expect(isKnown(outcome.plan.observedOutcome) && outcome.plan.observedOutcome.value).toBe('succeeded');
    expect(outcome.observationStage).toBe('observed');
    expect(outcome.recoveryAction).toBeNull();
    expect(outcome.affectedCapabilities).toEqual([]);
    expect(outcome.manifest?.manifestStatus).toBe('ready');
    expect(outcome.adapterPlan?.launchTarget).toBe('fresh');
    expect(claudeLaunchContextWriter.written).toHaveLength(1);
    expect(claudeLaunchContextWriter.written[0]!.applyResult).toBe('applied');
    expect(claudeInvocationDirPort.requestedOperationIds).toEqual([confirmed.operationId]);
    expect(claudeProcessPort.lastSpawnParams!.cwd).toBe(`/fake/claude-invocations/${confirmed.operationId}`);
    expect(claudeProcessPort.lastSpawnParams!.env.CLAUDE_CONFIG_DIR).toBe(`/fake/claude-invocations/${confirmed.operationId}`);
    expect(claudeProcessPort.lastSpawnParams!.argv).toEqual(['--permission-mode', 'manual']);
  });

  test('AC1 中间态断言: right after process-started, the persisted plan is already "observing" (launched) before exit is captured', async () => {
    const { deps, configRepository, launchPlanRepository } = buildDeps();
    const confirmed = await preparedAndConfirmed(deps, configRepository, revision({ configName: 'general', revisionId: 'rev-1' }));

    await launchClaudeFresh(deps, { planId: confirmed.planId });

    const phasesSaved = launchPlanRepository.saveLog.filter((p) => p.planId === confirmed.planId).map((p) => p.phase);
    expect(phasesSaved).toContain('observing');
    // observing always precedes the terminal outcome phase in the save order.
    expect(phasesSaved.indexOf('observing')).toBeLessThan(phasesSaved.indexOf('succeeded'));
  });

  test('[Story 4.5b] AC1 hooks/plugins 仍如实报告未物化差异（AD-21 明确不覆盖，Never 边界）: degraded with typed knownDifferences', async () => {
    const { deps, configRepository, claudeLaunchContextWriter } = buildDeps();
    const rev = revision({
      configName: 'general',
      revisionId: 'rev-1',
      hooks: [ref('hook', 'h1')],
      plugins: [ref('plugin', 'p1')],
    });
    const confirmed = await preparedAndConfirmed(deps, configRepository, rev);

    const outcome = await launchClaudeFresh(deps, { planId: confirmed.planId });

    expect(outcome.plan.phase).toBe('degraded');
    const differences = claudeLaunchContextWriter.written[0]!.knownDifferences;
    expect(differences).toContain('hooks-content-not-materialized-in-fresh-launch');
    expect(differences).toContain('plugins-content-not-materialized-in-fresh-launch');
    // Neither instructions/skills/mcp is referenced in this scenario, so none of
    // those three known-difference labels should appear.
    expect(differences).not.toContain('instructions-content-not-materialized-in-fresh-launch');
    expect(differences).not.toContain('skills-content-not-materialized-in-fresh-launch');
    expect(differences).not.toContain('mcp-content-not-materialized-in-fresh-launch');
  });

  test('[Story 4.5b] AC1 内容真实物化成功: instructions/skills 的真实内容被读出并交付, 不再报告"未物化"差异', async () => {
    const sourceDir = makeTmpDir('control-plane-claude-launch-materialize-src-');
    const invocationBaseDir = makeTmpDir('control-plane-claude-launch-materialize-inv-');
    useSupplyRoot(sourceDir);
    writeFileSync(path.join(sourceDir, 'general.md'), 'Be a helpful general-purpose assistant.', 'utf8');
    mkdirSync(path.join(sourceDir, 'skills', 'openspec-explore'), { recursive: true });
    writeFileSync(path.join(sourceDir, 'skills', 'openspec-explore', 'SKILL.md'), '# openspec-explore\n\nExplore the spec.', 'utf8');

    const { deps, configRepository, claudeLaunchContextWriter, claudeProcessPort } = buildDeps({ realInvocationBaseDir: invocationBaseDir });
    const rev = revision({
      configName: 'general',
      revisionId: 'rev-1',
      instructions: [ref('instruction', 'general.md', known('general.md'))],
      skills: [ref('skill', 'openspec-explore', known('skills/openspec-explore'))],
    });
    const confirmed = await preparedAndConfirmed(deps, configRepository, rev);

    const outcome = await launchClaudeFresh(deps, { planId: confirmed.planId });

    expect(outcome.plan.phase).toBe('succeeded');
    const differences = claudeLaunchContextWriter.written[0]!.knownDifferences;
    expect(differences).toEqual([]);
    expect(claudeLaunchContextWriter.written[0]!.applyResult).toBe('applied');

    const argv = claudeProcessPort.lastSpawnParams!.argv;
    expect(argv).toContain('--permission-mode');
    const appendIndex = argv.indexOf('--append-system-prompt');
    expect(appendIndex).toBeGreaterThanOrEqual(0);
    expect(argv[appendIndex + 1]).toBe('Be a helpful general-purpose assistant.');
    const pluginDirIndex = argv.indexOf('--plugin-dir');
    expect(pluginDirIndex).toBeGreaterThanOrEqual(0);
    const pluginDirPath = argv[pluginDirIndex + 1]!;
    expect(pluginDirPath.endsWith(path.join('materialized', 'plugin'))).toBe(true);
  });

  test('[Story 4.5b] AC1 必需内容物化失败（sourceRef 不可解析）: spawn 前 fail closed，不产生部分物化后仍 spawn 的中间态', async () => {
    const { deps, configRepository, claudeProcessPort } = buildDeps();
    const rev = revision({
      configName: 'general',
      revisionId: 'rev-1',
      skills: [ref('skill', 'ghost-skill', unknown('not-captured-by-cap-fs-adapter', '2026-01-01T00:00:00Z'))],
    });
    const confirmed = await preparedAndConfirmed(deps, configRepository, rev);

    const outcome = await launchClaudeFresh(deps, { planId: confirmed.planId });

    expect(outcome.plan.phase).toBe('failed');
    expect(isKnown(outcome.plan.failureReason) && outcome.plan.failureReason.value).toContain('content-materialization-blocked');
    expect(isKnown(outcome.plan.failureReason) && outcome.plan.failureReason.value).toContain('claude.plugin-dir-delivery');
    expect(outcome.affectedCapabilities).toEqual(['claude.plugin-dir-delivery']);
    expect(outcome.recoveryAction).not.toBeNull();
    // Never spawn once a required content group fails to materialize.
    expect(claudeProcessPort.lastSpawnParams).toBeNull();
  });

  test('[Story 4.5b] AC1 必需 MCP 内容物化失败（cap-fs.ts 今天恒定的 Unknown sourceRef）: spawn 前 fail closed', async () => {
    const { deps, configRepository, claudeProcessPort } = buildDeps();
    const rev = revision({
      configName: 'general',
      revisionId: 'rev-1',
      mcp: [ref('mcp', 'some-mcp', unknown('not-captured-by-cap-fs-adapter', '2026-01-01T00:00:00Z'))],
    });
    const confirmed = await preparedAndConfirmed(deps, configRepository, rev);

    const outcome = await launchClaudeFresh(deps, { planId: confirmed.planId });

    expect(outcome.plan.phase).toBe('failed');
    expect(isKnown(outcome.plan.failureReason) && outcome.plan.failureReason.value).toContain('content-materialization-blocked');
    expect(isKnown(outcome.plan.failureReason) && outcome.plan.failureReason.value).toContain('claude.mcp-project-scope-control');
    expect(outcome.affectedCapabilities).toEqual(['claude.mcp-project-scope-control']);
    expect(claudeProcessPort.lastSpawnParams).toBeNull();
  });

  test('[Story 4.5b][patch] AC1 多个必需内容组同时物化失败: 全部被报告，而不仅是第一个', async () => {
    const { deps, configRepository, claudeProcessPort } = buildDeps();
    const rev = revision({
      configName: 'general',
      revisionId: 'rev-1',
      skills: [ref('skill', 'ghost-skill', unknown('not-captured-by-cap-fs-adapter', '2026-01-01T00:00:00Z'))],
      mcp: [ref('mcp', 'ghost-mcp', unknown('not-captured-by-cap-fs-adapter', '2026-01-01T00:00:00Z'))],
    });
    const confirmed = await preparedAndConfirmed(deps, configRepository, rev);

    const outcome = await launchClaudeFresh(deps, { planId: confirmed.planId });

    expect(outcome.plan.phase).toBe('failed');
    const reason = isKnown(outcome.plan.failureReason) ? outcome.plan.failureReason.value : '';
    expect(reason).toContain('claude.plugin-dir-delivery');
    expect(reason).toContain('claude.mcp-project-scope-control');
    expect([...outcome.affectedCapabilities].sort()).toEqual(
      ['claude.mcp-project-scope-control', 'claude.plugin-dir-delivery'].sort(),
    );
    expect(claudeProcessPort.lastSpawnParams).toBeNull();
  });

  test('[Story 4.5b][patch] 真实物化成功后宿主拒绝启动（非零退出码）: affectedCapabilities 含真正被交付的内容 capabilityId', async () => {
    const sourceDir = makeTmpDir('control-plane-claude-launch-materialize-fail-src-');
    const invocationBaseDir = makeTmpDir('control-plane-claude-launch-materialize-fail-inv-');
    useSupplyRoot(sourceDir);
    writeFileSync(path.join(sourceDir, 'general.md'), 'Be a helpful general-purpose assistant.', 'utf8');
    mkdirSync(path.join(sourceDir, 'skills', 'openspec-explore'), { recursive: true });
    writeFileSync(path.join(sourceDir, 'skills', 'openspec-explore', 'SKILL.md'), '# openspec-explore', 'utf8');

    const { deps, configRepository, claudeProcessPort } = buildDeps({ realInvocationBaseDir: invocationBaseDir });
    claudeProcessPort.spawnResult = { exitCode: 13, signal: null };
    const rev = revision({
      configName: 'general',
      revisionId: 'rev-1',
      instructions: [ref('instruction', 'general.md', known('general.md'))],
      skills: [ref('skill', 'openspec-explore', known('skills/openspec-explore'))],
    });
    const confirmed = await preparedAndConfirmed(deps, configRepository, rev);

    const outcome = await launchClaudeFresh(deps, { planId: confirmed.planId });

    expect(outcome.plan.phase).toBe('failed');
    // Content really was materialized and handed to `spawn()` (the argv
    // genuinely carried it) -- the host then rejected the launch, so the
    // capabilities that actually contributed real, delivered argv must be
    // named, not just the static hard-control ones.
    expect(claudeProcessPort.lastSpawnParams!.argv).toContain('--append-system-prompt');
    expect(claudeProcessPort.lastSpawnParams!.argv).toContain('--plugin-dir');
    expect([...outcome.affectedCapabilities].sort()).toEqual(
      [
        'claude.append-system-prompt-delivery',
        'claude.permission-mode-control',
        'claude.plugin-dir-delivery',
        'claude.setting-sources-control',
      ].sort(),
    );
  });

  test('[Story 4.5b][patch] 真实物化成功后 spawn 抛出（二进制不可达）: affectedCapabilities 含真正被交付的内容 capabilityId', async () => {
    const sourceDir = makeTmpDir('control-plane-claude-launch-materialize-throw-src-');
    const invocationBaseDir = makeTmpDir('control-plane-claude-launch-materialize-throw-inv-');
    useSupplyRoot(sourceDir);
    mkdirSync(path.join(sourceDir, 'skills', 'openspec-explore'), { recursive: true });
    writeFileSync(path.join(sourceDir, 'skills', 'openspec-explore', 'SKILL.md'), '# openspec-explore', 'utf8');

    const { deps, configRepository, claudeProcessPort } = buildDeps({ realInvocationBaseDir: invocationBaseDir });
    claudeProcessPort.spawnError = new Error('claude-binary-not-found');
    const rev = revision({
      configName: 'general',
      revisionId: 'rev-1',
      skills: [ref('skill', 'openspec-explore', known('skills/openspec-explore'))],
    });
    const confirmed = await preparedAndConfirmed(deps, configRepository, rev);

    const outcome = await launchClaudeFresh(deps, { planId: confirmed.planId });

    expect(outcome.plan.phase).toBe('failed');
    expect(isKnown(outcome.plan.failureReason) && outcome.plan.failureReason.value).toContain('spawn-process');
    expect([...outcome.affectedCapabilities].sort()).toEqual(
      ['claude.permission-mode-control', 'claude.plugin-dir-delivery', 'claude.setting-sources-control'].sort(),
    );
  });

  test('AC2 必需能力不可达: capability-blocked -> failed before any spawn, missing capabilities + recovery action surfaced, no partial state', async () => {
    const { deps, configRepository, claudeCapabilityProbe, claudeProcessPort } = buildDeps();
    claudeCapabilityProbe.results = allSupportedProbeResults({
      'claude.mcp-project-scope-control': { status: 'unsupported', required: true },
    });
    const confirmed = await preparedAndConfirmed(
      deps,
      configRepository,
      revision({ configName: 'general', revisionId: 'rev-1', mcp: [ref('mcp', 'm1')] }),
    );

    const outcome = await launchClaudeFresh(deps, { planId: confirmed.planId });

    expect(outcome.plan.phase).toBe('failed');
    expect(isKnown(outcome.plan.failureReason) && outcome.plan.failureReason.value).toContain('capability-blocked');
    expect(isKnown(outcome.plan.failureReason) && outcome.plan.failureReason.value).toContain('claude.mcp-project-scope-control');
    expect(outcome.affectedCapabilities).toEqual(['claude.mcp-project-scope-control']);
    expect(outcome.recoveryAction).not.toBeNull();
    expect(outcome.manifest).toBeNull();
    expect(outcome.adapterPlan).toBeNull();
    // AC2: never fake success, never silently fall back -- and never spawn at all once blocked.
    expect(claudeProcessPort.lastSpawnParams).toBeNull();
  });

  test('AC2 宿主拒绝硬控制边界（非零退出码）: failed, affected capabilities + recovery action surfaced, not faked as success', async () => {
    const { deps, configRepository, claudeProcessPort } = buildDeps();
    claudeProcessPort.spawnResult = { exitCode: 13, signal: null };
    const confirmed = await preparedAndConfirmed(deps, configRepository, revision({ configName: 'general', revisionId: 'rev-1' }));

    const outcome = await launchClaudeFresh(deps, { planId: confirmed.planId });

    expect(outcome.plan.phase).toBe('failed');
    expect(isKnown(outcome.plan.failureReason) && outcome.plan.failureReason.value).toContain('13');
    expect(outcome.affectedCapabilities).toEqual(['claude.permission-mode-control']);
    expect(outcome.recoveryAction).not.toBeNull();
    expect(outcome.observationStage).toBe('observed');
  });

  test('AC2 affectedCapabilities 不过度归咎: hooks referenced (never argv-contributing) is excluded from affectedCapabilities on a rejected launch', async () => {
    const { deps, configRepository, claudeProcessPort } = buildDeps();
    claudeProcessPort.spawnResult = { exitCode: 13, signal: null };
    const confirmed = await preparedAndConfirmed(
      deps,
      configRepository,
      revision({ configName: 'general', revisionId: 'rev-1', hooks: [ref('hook', 'h1')] }),
    );

    const outcome = await launchClaudeFresh(deps, { planId: confirmed.planId });

    expect(outcome.plan.phase).toBe('failed');
    // `claude.hook-deny-return-value` is relevant (hooks referenced) and
    // shows up in `manifest.capabilityPolicy`, but it never contributes an
    // argv flag -- it must never be blamed for a rejected launch.
    expect(outcome.manifest?.capabilityPolicy.map((n) => n.capabilityId)).toContain('claude.hook-deny-return-value');
    expect(outcome.affectedCapabilities).not.toContain('claude.hook-deny-return-value');
    expect(outcome.affectedCapabilities).toEqual(['claude.permission-mode-control']);
  });

  test('signal-terminated exit -> incomplete, not faked as failed or succeeded', async () => {
    const { deps, configRepository, claudeProcessPort } = buildDeps();
    claudeProcessPort.spawnResult = { exitCode: null, signal: 'SIGTERM' };
    const confirmed = await preparedAndConfirmed(deps, configRepository, revision({ configName: 'general', revisionId: 'rev-1' }));

    const outcome = await launchClaudeFresh(deps, { planId: confirmed.planId });

    expect(outcome.plan.phase).toBe('incomplete');
    expect(outcome.observationStage).toBe('observed');
    expect(outcome.recoveryAction).not.toBeNull();
  });

  test('spawn 抛出（二进制不可达）: apply-failed with typed reason, plan lands in a valid terminal phase, no partial state', async () => {
    const { deps, configRepository, claudeProcessPort } = buildDeps();
    claudeProcessPort.spawnError = new Error('claude-binary-not-found');
    const confirmed = await preparedAndConfirmed(deps, configRepository, revision({ configName: 'general', revisionId: 'rev-1' }));

    const outcome = await launchClaudeFresh(deps, { planId: confirmed.planId });

    expect(outcome.plan.phase).toBe('failed');
    expect(isKnown(outcome.plan.failureReason) && outcome.plan.failureReason.value).toContain('spawn-process');
    expect(isKnown(outcome.plan.failureReason) && outcome.plan.failureReason.value).toContain('claude-binary-not-found');
    expect(outcome.observationStage).toBe('planned');
    expect(outcome.recoveryAction).not.toBeNull();
  });

  test('invocation 目录准备失败: apply-failed without ever spawning, no partial state', async () => {
    const { deps, configRepository, claudeInvocationDirPort, claudeProcessPort } = buildDeps();
    claudeInvocationDirPort.prepareError = new Error('disk-full');
    const confirmed = await preparedAndConfirmed(deps, configRepository, revision({ configName: 'general', revisionId: 'rev-1' }));

    const outcome = await launchClaudeFresh(deps, { planId: confirmed.planId });

    expect(outcome.plan.phase).toBe('failed');
    expect(isKnown(outcome.plan.failureReason) && outcome.plan.failureReason.value).toContain('invocation-dir');
    expect(claudeProcessPort.lastSpawnParams).toBeNull();
    expect(outcome.observationStage).toBe('planned');
  });

  test('修订在确认后、启动前被删除: typed failure instead of unhandled throw', async () => {
    const { deps, configRepository } = buildDeps();
    const confirmed = await preparedAndConfirmed(deps, configRepository, revision({ configName: 'general', revisionId: 'rev-1' }));
    configRepository.remove('rev-1');

    const outcome = await launchClaudeFresh(deps, { planId: confirmed.planId });

    expect(outcome.plan.phase).toBe('failed');
    expect(isKnown(outcome.plan.failureReason) && outcome.plan.failureReason.value).toContain('revision-lookup');
    expect(outcome.observationStage).toBe('planned');
  });

  test('launchClaudeFresh requires the plan to already be in the "applying" phase', async () => {
    const { deps, configRepository } = buildDeps();
    configRepository.add(revision({ configName: 'general', revisionId: 'rev-1' }));
    const plan = await prepareClaudeFreshLaunchPlan(deps, { revisionId: 'rev-1' }); // still awaiting-confirmation

    await expect(launchClaudeFresh(deps, { planId: plan.planId })).rejects.toBeInstanceOf(InvalidTransitionError);
  });

  test('rejects a plan created for a different client (e.g. omp) even if its phase is "applying"', async () => {
    const { deps, launchPlanRepository } = buildDeps();
    const foreignPlan: LaunchPlan = {
      planId: 'plan-omp-1',
      operationId: 'op-omp-1',
      revisionId: 'rev-1',
      configName: 'general',
      client: 'omp',
      planHash: 'ph_fake',
      phase: 'applying',
      createdAt: '2026-01-01T00:00:00Z',
      confirmedAt: known('2026-01-01T00:00:00Z'),
      failureReason: unknown('no-failure-recorded', '2026-01-01T00:00:00Z'),
      observedOutcome: unknown('not-yet-observed', '2026-01-01T00:00:00Z'),
    };
    await launchPlanRepository.save(foreignPlan);

    await expect(launchClaudeFresh(deps, { planId: foreignPlan.planId })).rejects.toBeInstanceOf(InvalidTransitionError);
  });

  test('unknown planId throws LaunchPlanNotFoundError', async () => {
    const { deps } = buildDeps();
    await expect(launchClaudeFresh(deps, { planId: 'no-such-plan' })).rejects.toBeInstanceOf(LaunchPlanNotFoundError);
  });

  test('用户拒绝确认: awaiting-confirmation -> cancelled via the reused rejectLaunchPlan, claude never spawned', async () => {
    const { deps, configRepository, claudeProcessPort } = buildDeps();
    configRepository.add(revision({ configName: 'general', revisionId: 'rev-1' }));
    const plan = await prepareClaudeFreshLaunchPlan(deps, { revisionId: 'rev-1' });

    const rejected = await rejectLaunchPlan(deps, plan.planId);
    expect(rejected.phase).toBe('cancelled');
    expect(claudeProcessPort.lastSpawnParams).toBeNull();
  });
});

describe('prepareClaudeAlreadyRunningLaunchPlan', () => {
  test('目标判定为 already-running，配置存在: plan lands directly on requires-restart in one save, no probe/spawn', async () => {
    const { deps, configRepository, launchPlanRepository, claudeCapabilityProbe, claudeProcessPort } = buildDeps();
    configRepository.add(revision({ configName: 'general', revisionId: 'rev-1' }));
    const probeSpy = { called: false };
    claudeCapabilityProbe.probeHardControlCapabilities = async () => {
      probeSpy.called = true;
      return [];
    };

    const outcome = await prepareClaudeAlreadyRunningLaunchPlan(deps, { revisionId: 'rev-1' });

    expect(outcome.plan.phase).toBe('requires-restart');
    expect(outcome.plan.client).toBe('claude-code');
    expect(outcome.plan.configName).toBe('general');
    expect(isKnown(outcome.plan.failureReason) && outcome.plan.failureReason.value).toBe('already-running-session-target');
    expect(outcome.observationStage).toBe('planned');
    expect(outcome.manifest).toBeNull();
    expect(outcome.adapterPlan).toBeNull();
    expect(outcome.affectedCapabilities).toEqual([]);
    expect(outcome.recoveryAction).not.toBeNull();
    expect(probeSpy.called).toBe(false);
    expect(claudeProcessPort.lastSpawnParams).toBeNull();
    const savesForPlan = launchPlanRepository.saveLog.filter((p) => p.planId === outcome.plan.planId);
    expect(savesForPlan).toHaveLength(1);
  });

  test('配置不存在: still resolves to requires-restart, configName falls back to revisionId, not blocked or thrown', async () => {
    const { deps, launchPlanRepository } = buildDeps();

    const outcome = await prepareClaudeAlreadyRunningLaunchPlan(deps, { revisionId: 'does-not-exist' });

    expect(outcome.plan.phase).toBe('requires-restart');
    expect(outcome.plan.configName).toBe('does-not-exist');
    expect(outcome.observationStage).toBe('planned');
    const savesForPlan = launchPlanRepository.saveLog.filter((p) => p.planId === outcome.plan.planId);
    expect(savesForPlan).toHaveLength(1);
  });

  test('requires-restart 后再次尝试任何事件: transitionLaunchPlan rejects all further events, including target-requires-restart itself', async () => {
    const { deps, configRepository } = buildDeps();
    configRepository.add(revision({ configName: 'general', revisionId: 'rev-1' }));

    const outcome = await prepareClaudeAlreadyRunningLaunchPlan(deps, { revisionId: 'rev-1' });

    const again = transitionLaunchPlan(outcome.plan, { type: 'target-requires-restart' });
    expect(again.ok).toBe(false);
    const processStarted = transitionLaunchPlan(outcome.plan, { type: 'process-started' });
    expect(processStarted.ok).toBe(false);
  });

  test('误把 already-running 的 plan 传给 launchClaudeFresh: rejected as an invalid transition, never spawns', async () => {
    const { deps, configRepository, claudeProcessPort } = buildDeps();
    configRepository.add(revision({ configName: 'general', revisionId: 'rev-1' }));
    const outcome = await prepareClaudeAlreadyRunningLaunchPlan(deps, { revisionId: 'rev-1' });

    await expect(launchClaudeFresh(deps, { planId: outcome.plan.planId })).rejects.toBeInstanceOf(InvalidTransitionError);
    expect(claudeProcessPort.lastSpawnParams).toBeNull();
  });
});

describe('computeClaudeKnownDifferences', () => {
  const emptyMaterialization = {
    instructions: { appendSystemPromptText: null, failures: [] },
    skills: { pluginDirPath: null, failures: [] },
    mcp: { mcpConfigPath: null, failures: [] },
  };

  test('empty revision + ready manifest -> no differences', async () => {
    const { configRepository, claudeCapabilityProbe } = buildDeps();
    const rev = revision({ configName: 'general', revisionId: 'rev-1' });
    configRepository.add(rev);
    const { compileClaudeAssemblyManifest } = await import('../../src/adapters/clients/claude/assembly-manifest');
    const results = await claudeCapabilityProbe.probeHardControlCapabilities();
    const manifestResult = compileClaudeAssemblyManifest(rev, results);
    if (manifestResult.kind !== 'compiled') throw new Error('expected compiled');

    expect(computeClaudeKnownDifferences(rev, manifestResult.manifest, emptyMaterialization)).toEqual([]);
  });

  test('[Story 4.5b] non-empty instructions/skills/mcp with zero materialization failures -> no differences (fully delivered)', async () => {
    const { configRepository, claudeCapabilityProbe } = buildDeps();
    const rev = revision({
      configName: 'general',
      revisionId: 'rev-1',
      instructions: [ref('instruction', 'i1')],
      skills: [ref('skill', 's1')],
    });
    configRepository.add(rev);
    const { compileClaudeAssemblyManifest } = await import('../../src/adapters/clients/claude/assembly-manifest');
    const results = await claudeCapabilityProbe.probeHardControlCapabilities();
    const manifestResult = compileClaudeAssemblyManifest(rev, results);
    if (manifestResult.kind !== 'compiled') throw new Error('expected compiled');

    const fullyDeliveredMaterialization = {
      instructions: { appendSystemPromptText: 'text', failures: [] },
      skills: { pluginDirPath: '/fake/materialized/plugin', failures: [] },
      mcp: { mcpConfigPath: null, failures: [] },
    };

    expect(computeClaudeKnownDifferences(rev, manifestResult.manifest, fullyDeliveredMaterialization)).toEqual([]);
  });

  test('[Story 4.5b] hooks/plugins always count as a difference when referenced, independent of materialization', async () => {
    const { configRepository, claudeCapabilityProbe } = buildDeps();
    const rev = revision({
      configName: 'general',
      revisionId: 'rev-1',
      hooks: [ref('hook', 'h1')],
      plugins: [ref('plugin', 'p1')],
    });
    configRepository.add(rev);
    const { compileClaudeAssemblyManifest } = await import('../../src/adapters/clients/claude/assembly-manifest');
    const results = await claudeCapabilityProbe.probeHardControlCapabilities();
    const manifestResult = compileClaudeAssemblyManifest(rev, results);
    if (manifestResult.kind !== 'compiled') throw new Error('expected compiled');

    const differences = computeClaudeKnownDifferences(rev, manifestResult.manifest, emptyMaterialization);
    expect(differences).toContain('hooks-content-not-materialized-in-fresh-launch');
    expect(differences).toContain('plugins-content-not-materialized-in-fresh-launch');
  });
});

// `[Story 4.7]` The `describe('[Story 4.5b/4.7] launchClaudeFresh against
// the real repo .cap/ (AC1 evidence)', ...)` block that lived here (Story
// 4.5b, extended by Story 4.7 to cover both real profiles) ran
// `launchClaudeFresh` against `loadCapConfigRevisions` output read from the
// real repo `.cap/` directory for both `general` and `agent-assembler`,
// asserting the final argv carried a real `--plugin-dir` (a real
// materialized plugin package containing a `skills/<name>/` directory per
// referenced skill) and a real `--append-system-prompt` text, with
// `computeClaudeKnownDifferences` reporting neither as not-materialized.
// `.cap/` was retired by Story 4.7 once this exact evidence was captured
// for both profiles (see spec-4-7-退役-cap-本体.md's Auto Run Result for the
// full captured results); the underlying content-materialization behavior
// this block exercised remains covered above by this file's synthetic-
// revision tests (e.g. "AC1 内容真实物化成功", "AC1 必需内容物化失败"),
// which do not depend on `.cap/` existing on disk.
