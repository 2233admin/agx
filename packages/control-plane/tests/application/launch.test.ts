import { describe, expect, test } from 'bun:test';

import {
  InvalidTransitionError,
  LaunchPlanNotFoundError,
  StaleConfirmationError,
  UnsupportedClientError,
  confirmLaunchPlan,
  getLaunchStatus,
  launchOmp,
  prepareLaunchPlan,
  rejectLaunchPlan,
  requestConfigSwitch,
  type LaunchOmpDeps,
  type LaunchStatusDeps,
} from '../../src/application/launch';
import type { ClientId } from '../../src/domain/client';
import type { LaunchPlan } from '../../src/domain/activation';
import { isKnown, isUnknown, known, unknown } from '../../src/domain/facts';
import type { Fact } from '../../src/domain/facts';
import type { CapabilityReference, StableConfigRevision } from '../../src/domain/config';
import type {
  CapabilityProbeResult,
  ConfigRevisionRepository,
  LaunchContext,
  LaunchContextWriter,
  LaunchPlanRepository,
  OmpCapabilityProbePort,
  OmpProcessPort,
  OmpSpawnParams,
  OmpSpawnResult,
} from '../../src/application/ports';

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

class FakeConfigRevisionRepository implements ConfigRevisionRepository {
  private readonly revisions = new Map<string, StableConfigRevision>();

  add(revision: StableConfigRevision): void {
    this.revisions.set(revision.revisionId, revision);
  }

  /** Simulates the revision becoming unavailable (e.g. deleted) after it was already read once. */
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

class FakeOmpProcessPort implements OmpProcessPort {
  version: Fact<string> = known('17.4.1');
  detectVersionCalls = 0;
  spawnResult: OmpSpawnResult = { exitCode: 0, signal: null };
  spawnError: Error | null = null;
  lastSpawnParams: OmpSpawnParams | null = null;

  async detectVersion() {
    this.detectVersionCalls += 1;
    return this.version;
  }

  async spawn(params: OmpSpawnParams): Promise<OmpSpawnResult> {
    this.lastSpawnParams = params;
    if (this.spawnError !== null) {
      throw this.spawnError;
    }
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

function buildDeps() {
  const configRepository = new FakeConfigRevisionRepository();
  const launchPlanRepository = new FakeLaunchPlanRepository();
  const ompPort = new FakeOmpProcessPort();
  const capabilityProbe = new FakeOmpCapabilityProbe();
  const contextWriter = new FakeLaunchContextWriter();
  const deps: LaunchOmpDeps & LaunchStatusDeps = { configRepository, launchPlanRepository, ompPort, capabilityProbe, contextWriter };
  return { deps, configRepository, launchPlanRepository, ompPort, capabilityProbe, contextWriter };
}

describe('prepareLaunchPlan', () => {
  test('选择+一次确认+启动成功: valid revisionId + client=omp prepares a plan through to awaiting-confirmation', async () => {
    const { deps, configRepository } = buildDeps();
    configRepository.add(revision({ configName: 'general', revisionId: 'rev-1' }));

    const plan = await prepareLaunchPlan(deps, { revisionId: 'rev-1', client: 'omp' });
    expect(plan.phase).toBe('awaiting-confirmation');
    expect(plan.configName).toBe('general');
    expect(plan.revisionId).toBe('rev-1');
  });

  // `[Story 4.6]` `resolveClientSupport('claude-code')` now returns
  // `supported: true` (Story 4.1~4.5b delivered a real adapter) -- only
  // `codex-cli` (no adapter exists) still hits this gate. See
  // `tests/domain/client.test.ts` for the flipped `claude-code` assertion
  // and `tests/application/claude-launch.test.ts`/
  // `tests/integration/cli-claude-launch.test.ts` for the Claude adapter's
  // own coverage.
  test('不支持的客户端: codex-cli throws before any plan is created or persisted', async () => {
    const { deps, launchPlanRepository } = buildDeps();

    await expect(prepareLaunchPlan(deps, { revisionId: 'rev-1', client: 'codex-cli' })).rejects.toBeInstanceOf(UnsupportedClientError);
    expect(launchPlanRepository.saveLog).toHaveLength(0);
  });

  test('配置不存在: prepared -> failed, persisted, reusing ConfigNotFoundError message as the typed reason', async () => {
    const { deps } = buildDeps();
    const plan = await prepareLaunchPlan(deps, { revisionId: 'does-not-exist', client: 'omp' });
    expect(plan.phase).toBe('failed');
    expect(isKnown(plan.failureReason) && plan.failureReason.value).toContain('configuration revision not found');
  });
});

describe('confirmLaunchPlan / rejectLaunchPlan', () => {
  test('用户拒绝确认: awaiting-confirmation -> cancelled, OMP never invoked', async () => {
    const { deps, configRepository, ompPort } = buildDeps();
    configRepository.add(revision({ configName: 'general', revisionId: 'rev-1' }));
    const plan = await prepareLaunchPlan(deps, { revisionId: 'rev-1', client: 'omp' });

    const rejected = await rejectLaunchPlan(deps, plan.planId);
    expect(rejected.phase).toBe('cancelled');
    expect(ompPort.lastSpawnParams).toBeNull();
  });

  test('重放旧确认: confirming an already-confirmed plan is rejected as StaleConfirmationError', async () => {
    const { deps, configRepository } = buildDeps();
    configRepository.add(revision({ configName: 'general', revisionId: 'rev-1' }));
    const plan = await prepareLaunchPlan(deps, { revisionId: 'rev-1', client: 'omp' });

    await confirmLaunchPlan(deps, plan.planId);
    await expect(confirmLaunchPlan(deps, plan.planId)).rejects.toBeInstanceOf(StaleConfirmationError);
  });

  test('confirming an unknown planId throws LaunchPlanNotFoundError', async () => {
    const { deps } = buildDeps();
    await expect(confirmLaunchPlan(deps, 'no-such-plan')).rejects.toBeInstanceOf(LaunchPlanNotFoundError);
  });
});

describe('launchOmp', () => {
  async function preparedAndConfirmed(deps: ReturnType<typeof buildDeps>['deps'], configRepository: FakeConfigRevisionRepository, rev: StableConfigRevision) {
    configRepository.add(rev);
    const plan = await prepareLaunchPlan(deps, { revisionId: rev.revisionId, client: 'omp' });
    return confirmLaunchPlan(deps, plan.planId);
  }

  test('OMP 二进制不可达（bridge 不可用）: capability probe unknown -> applying -> failed, phase reason mentions spawn-process', async () => {
    const { deps, configRepository, capabilityProbe, ompPort } = buildDeps();
    capabilityProbe.result = { level: 'unknown', reason: 'omp-binary-not-found' };
    const confirmed = await preparedAndConfirmed(deps, configRepository, revision({ configName: 'general', revisionId: 'rev-1' }));

    const final = await launchOmp(deps, { planId: confirmed.planId, extensionPath: '/ext.ts', forwardedArgs: [], cwd: '/cwd' });
    expect(final.phase).toBe('failed');
    expect(isKnown(final.failureReason) && final.failureReason.value).toContain('spawn-process');
    expect(isKnown(final.failureReason) && final.failureReason.value).toContain('omp-binary-not-found');
    expect(ompPort.lastSpawnParams).toBeNull();
  });

  test('成功: exit 0 with no capability differences -> succeeded, applyResult applied, context written', async () => {
    const { deps, configRepository, contextWriter } = buildDeps();
    const confirmed = await preparedAndConfirmed(deps, configRepository, revision({ configName: 'general', revisionId: 'rev-1' }));

    const final = await launchOmp(deps, { planId: confirmed.planId, extensionPath: '/ext.ts', forwardedArgs: [], cwd: '/cwd' });
    expect(final.phase).toBe('succeeded');
    expect(isKnown(final.observedOutcome) && final.observedOutcome.value).toBe('succeeded');
    expect(contextWriter.written).toHaveLength(1);
    expect(contextWriter.written[0]!.applyResult).toBe('applied');
    expect(contextWriter.written[0]!.knownDifferences).toEqual([]);
  });

  test('Instructions/MCP 无法在 MVP 内真实装配: non-empty instructions/mcp/hooks/plugins -> degraded with typed knownDifferences, skills unaffected', async () => {
    const { deps, configRepository, contextWriter, ompPort } = buildDeps();
    const rev = revision({
      configName: 'general',
      revisionId: 'rev-1',
      instructions: [ref('instruction', 'i1')],
      mcp: [ref('mcp', 'm1')],
      hooks: [ref('hook', 'h1')],
      plugins: [ref('plugin', 'p1')],
      skills: [ref('skill', 's1')],
    });
    const confirmed = await preparedAndConfirmed(deps, configRepository, rev);

    const final = await launchOmp(deps, { planId: confirmed.planId, extensionPath: '/ext.ts', forwardedArgs: [], cwd: '/cwd' });
    expect(final.phase).toBe('degraded');
    const differences = contextWriter.written[0]!.knownDifferences;
    expect(differences).toContain('instructions-content-not-materialized-in-mvp');
    expect(differences).toContain('mcp-content-not-materialized-in-mvp');
    expect(differences).toContain('hooks-content-not-materialized-in-mvp');
    expect(differences).toContain('plugins-content-not-materialized-in-mvp');
    // Skills are still assembled by name via OMP's own discovery.
    expect(ompPort.lastSpawnParams!.revision.skills.map((s) => s.name)).toEqual(['s1']);
  });

  test('OMP 进程非零退出: exitCode !== 0 -> failed, exitCode surfaced, not faked as success', async () => {
    const { deps, configRepository, ompPort } = buildDeps();
    ompPort.spawnResult = { exitCode: 7, signal: null };
    const confirmed = await preparedAndConfirmed(deps, configRepository, revision({ configName: 'general', revisionId: 'rev-1' }));

    const final = await launchOmp(deps, { planId: confirmed.planId, extensionPath: '/ext.ts', forwardedArgs: [], cwd: '/cwd' });
    expect(final.phase).toBe('failed');
    expect(isKnown(final.failureReason) && final.failureReason.value).toContain('7');
  });

  test('signal-terminated exit with no determinable exit code -> incomplete, not faked as failed or succeeded', async () => {
    const { deps, configRepository, ompPort } = buildDeps();
    ompPort.spawnResult = { exitCode: null, signal: 'SIGTERM' };
    const confirmed = await preparedAndConfirmed(deps, configRepository, revision({ configName: 'general', revisionId: 'rev-1' }));

    const final = await launchOmp(deps, { planId: confirmed.planId, extensionPath: '/ext.ts', forwardedArgs: [], cwd: '/cwd' });
    expect(final.phase).toBe('incomplete');
  });

  test('capability probe "supported" skips loading the thin extension -- no duplicate fact source', async () => {
    const { deps, configRepository, capabilityProbe, ompPort } = buildDeps();
    capabilityProbe.result = { level: 'supported', reason: 'native-covers-status-viewing' };
    const confirmed = await preparedAndConfirmed(deps, configRepository, revision({ configName: 'general', revisionId: 'rev-1' }));

    await launchOmp(deps, { planId: confirmed.planId, extensionPath: '/ext.ts', forwardedArgs: [], cwd: '/cwd' });
    expect(ompPort.lastSpawnParams!.extensionPath).toBeNull();
  });

  test('capability probe "degraded" still loads the thin extension, grouped with "unsupported"', async () => {
    const { deps, configRepository, capabilityProbe, ompPort } = buildDeps();
    capabilityProbe.result = { level: 'degraded', reason: 'native-partially-covers-status-viewing' };
    const confirmed = await preparedAndConfirmed(deps, configRepository, revision({ configName: 'general', revisionId: 'rev-1' }));

    await launchOmp(deps, { planId: confirmed.planId, extensionPath: '/ext.ts', forwardedArgs: [], cwd: '/cwd' });
    expect(ompPort.lastSpawnParams!.extensionPath).toBe('/ext.ts');
  });

  test('非 ASCII / 含空格路径: cwd/extensionPath with spaces and non-ASCII pass through untouched to the port', async () => {
    const { deps, configRepository, ompPort } = buildDeps();
    const confirmed = await preparedAndConfirmed(deps, configRepository, revision({ configName: 'general', revisionId: 'rev-1' }));
    const weirdCwd = 'C:/Users/名前 with spaces';
    const weirdExt = 'C:/ext ①.ts';

    await launchOmp(deps, { planId: confirmed.planId, extensionPath: weirdExt, forwardedArgs: [], cwd: weirdCwd });
    expect(ompPort.lastSpawnParams!.cwd).toBe(weirdCwd);
    expect(ompPort.lastSpawnParams!.extensionPath).toBe(weirdExt);
  });

  test('修订在确认后、启动前被删除: launchOmp catches the re-fetch\'s ConfigNotFoundError and produces a typed failure instead of an unhandled throw', async () => {
    const { deps, configRepository } = buildDeps();
    const confirmed = await preparedAndConfirmed(deps, configRepository, revision({ configName: 'general', revisionId: 'rev-1' }));

    // The revision was resolvable at prepare-time (and at confirmation) but
    // becomes unavailable in the window between the user's one-time
    // confirmation and launchOmp's own re-fetch of the revision.
    configRepository.remove('rev-1');

    const final = await launchOmp(deps, { planId: confirmed.planId, extensionPath: '/ext.ts', forwardedArgs: [], cwd: '/cwd' });
    expect(final.phase).toBe('failed');
    expect(isKnown(final.failureReason) && final.failureReason.value).toContain('revision-lookup');
    expect(isKnown(final.failureReason) && final.failureReason.value).toContain('configuration revision not found');
  });

  test('launchOmp requires the plan to already be in the "applying" phase', async () => {
    const { deps, configRepository } = buildDeps();
    configRepository.add(revision({ configName: 'general', revisionId: 'rev-1' }));
    const plan = await prepareLaunchPlan(deps, { revisionId: 'rev-1', client: 'omp' }); // still awaiting-confirmation

    await expect(launchOmp(deps, { planId: plan.planId, extensionPath: '/ext.ts', forwardedArgs: [], cwd: '/cwd' })).rejects.toBeInstanceOf(
      InvalidTransitionError,
    );
  });
});

describe('getLaunchStatus', () => {
  test('查看启动状态: returns revision/client/version/phase/applyResult/knownDifferences for an explicit planId', async () => {
    const { deps, configRepository } = buildDeps();
    configRepository.add(revision({ configName: 'general', revisionId: 'rev-1' }));
    const plan = await prepareLaunchPlan(deps, { revisionId: 'rev-1', client: 'omp' });

    const status = await getLaunchStatus(deps, plan.planId);
    expect(status.revisionId).toBe('rev-1');
    expect(status.client).toBe('omp');
    expect(status.phase).toBe('awaiting-confirmation');
    expect(isKnown(status.clientVersion)).toBe(true);
  });

  test('调用方已提供版本事实时: status reuses it without probing OMP again', async () => {
    const { deps, configRepository, ompPort } = buildDeps();
    configRepository.add(revision({ configName: 'general', revisionId: 'rev-1' }));
    const plan = await prepareLaunchPlan(deps, { revisionId: 'rev-1', client: 'omp' });

    const status = await getLaunchStatus(deps, plan.planId, known('17.4.1'));

    expect(status.clientVersion).toEqual(known('17.4.1'));
    expect(ompPort.detectVersionCalls).toBe(0);
  });

  test('falls back to findActiveForClient("omp") when no planId is given', async () => {
    const { deps, configRepository } = buildDeps();
    configRepository.add(revision({ configName: 'general', revisionId: 'rev-1' }));
    const plan = await prepareLaunchPlan(deps, { revisionId: 'rev-1', client: 'omp' });

    const status = await getLaunchStatus(deps, null);
    expect(status.revisionId).toBe(plan.revisionId);
  });

  test('throws LaunchPlanNotFoundError when no plan can be resolved', async () => {
    const { deps } = buildDeps();
    await expect(getLaunchStatus(deps, 'no-such-plan')).rejects.toBeInstanceOf(LaunchPlanNotFoundError);
    await expect(getLaunchStatus(deps, null)).rejects.toBeInstanceOf(LaunchPlanNotFoundError);
  });
});

describe('requestConfigSwitch', () => {
  async function toSucceeded(deps: ReturnType<typeof buildDeps>['deps'], configRepository: FakeConfigRevisionRepository, revisionId: string) {
    configRepository.add(revision({ configName: 'general', revisionId }));
    const plan = await prepareLaunchPlan(deps, { revisionId, client: 'omp' });
    const confirmed = await confirmLaunchPlan(deps, plan.planId);
    return launchOmp(deps, { planId: confirmed.planId, extensionPath: '/ext.ts', forwardedArgs: [], cwd: '/cwd' });
  }

  test('运行中配置切换: current succeeded plan -> requires-restart; a brand-new plan awaits its own confirmation', async () => {
    const { deps, configRepository } = buildDeps();
    const succeeded = await toSucceeded(deps, configRepository, 'rev-1');
    configRepository.add(revision({ configName: 'reviewer', revisionId: 'rev-2' }));

    const result = await requestConfigSwitch(deps, { currentPlanId: succeeded.planId, newRevisionId: 'rev-2', client: 'omp' });
    expect(result.previousPlan.phase).toBe('requires-restart');
    expect(result.newPlan.phase).toBe('awaiting-confirmation');
    expect(result.newPlan.revisionId).toBe('rev-2');
    expect(result.newPlan.planId).not.toBe(succeeded.planId);
  });

  test('switching away from a plan that is not succeeded/degraded is rejected', async () => {
    const { deps, configRepository } = buildDeps();
    configRepository.add(revision({ configName: 'general', revisionId: 'rev-1' }));
    const plan = await prepareLaunchPlan(deps, { revisionId: 'rev-1', client: 'omp' }); // awaiting-confirmation

    await expect(requestConfigSwitch(deps, { currentPlanId: plan.planId, newRevisionId: 'rev-2', client: 'omp' })).rejects.toBeInstanceOf(
      InvalidTransitionError,
    );
  });
});
