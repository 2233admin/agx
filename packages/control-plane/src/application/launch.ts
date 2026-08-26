import {
  computePlanHash,
  createLaunchPlan,
  deriveLaunchStatus,
  transitionLaunchPlan,
} from '../domain/activation';
import type { LaunchPhase, LaunchPlan, LaunchStatus, ObservedOutcome } from '../domain/activation';
import { resolveClientSupport, ALL_CLIENT_IDS } from '../domain/client';
import type { ClientId } from '../domain/client';
import type { StableConfigRevision } from '../domain/config';
import { type Fact, unknown } from '../domain/facts';
import { ConfigNotFoundError, ConfigUnsupportedError, getConfigRevisionDetail } from './queries';
import type {
  ClaudeProcessPort,
  ConfigRevisionRepository,
  LaunchContextWriter,
  LaunchPlanRepository,
  OmpCapabilityProbePort,
  OmpProcessPort,
  OmpSpawnResult,
} from './ports';

/** Selected client is not (yet) supported -- see `domain/client.ts`. */
export class UnsupportedClientError extends Error {
  readonly kind = 'unsupported-client' as const;

  constructor(
    readonly clientId: string,
    readonly reason: string,
  ) {
    super(`client not supported: ${clientId} (${reason})`);
    this.name = 'UnsupportedClientError';
  }
}

/**
 * A confirmation was attempted against a plan that is no longer (or never
 * was, for this token) `awaiting-confirmation` -- the plan moved on, was
 * replaced, or the confirmation belongs to a different plan/revision.
 */
export class StaleConfirmationError extends Error {
  readonly kind = 'stale-confirmation' as const;

  constructor(
    readonly planId: string,
    readonly reason: string,
  ) {
    super(
      `confirmation is stale for plan ${planId} (${reason}); a plan can only be confirmed once, and only while it is still awaiting confirmation -- start the launch flow again for a new confirmation`,
    );
    this.name = 'StaleConfirmationError';
  }
}

/** A domain-level `transitionLaunchPlan` rejection surfaced to a caller. */
export class InvalidTransitionError extends Error {
  readonly kind = 'invalid-transition' as const;

  constructor(
    readonly planId: string,
    readonly phase: LaunchPhase,
    readonly eventType: string,
    readonly reason: string,
  ) {
    super(`invalid transition for plan ${planId}: cannot apply "${eventType}" while in phase "${phase}" (${reason})`);
    this.name = 'InvalidTransitionError';
  }
}

export class LaunchPlanNotFoundError extends Error {
  readonly kind = 'launch-plan-not-found' as const;

  constructor(readonly planId: string) {
    super(`launch plan not found: ${planId}`);
    this.name = 'LaunchPlanNotFoundError';
  }
}

export interface LaunchDeps {
  readonly configRepository: ConfigRevisionRepository;
  readonly launchPlanRepository: LaunchPlanRepository;
}

export interface LaunchOmpDeps extends LaunchDeps {
  readonly ompPort: OmpProcessPort;
  readonly capabilityProbe: OmpCapabilityProbePort;
  readonly contextWriter: LaunchContextWriter;
}

export interface LaunchStatusDeps extends LaunchDeps {
  readonly ompPort: OmpProcessPort;
  /**
   * `[Epic 4 retro fix]` Only consulted when resolving a `'claude-code'`
   * plan's status without an explicit `clientVersion` override -- e.g. bare
   * `configs status` (no plan id), which after `findMostRecentActivePlan`
   * can now land on a Claude plan (Story 4.6 made `'claude-code'` a second
   * real client). Optional so existing OMP-only callers/tests need not
   * supply it; absent for a Claude plan, version resolution degrades to an
   * honest Unknown rather than wrongly querying `ompPort`.
   */
  readonly claudeProcessPort?: Pick<ClaudeProcessPort, 'detectVersion'>;
}

function generateId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

/**
 * MVP: Instructions/MCP/Hooks/Plugins are never materialized into the OMP
 * invocation in this Story (Story 1.1 never captured the raw bytes/
 * connection definitions needed to do so honestly) -- only their presence
 * is surfaced as a typed `degraded` reason. Skills are the only group
 * actually assembled (by name, via OMP's own discovery).
 */
export function computeKnownDifferences(revision: StableConfigRevision): string[] {
  const differences: string[] = [];
  if (revision.instructions.length > 0) {
    differences.push('instructions-content-not-materialized-in-mvp');
  }
  if (revision.mcp.length > 0) {
    differences.push('mcp-content-not-materialized-in-mvp');
  }
  if (revision.hooks.length > 0) {
    differences.push('hooks-content-not-materialized-in-mvp');
  }
  if (revision.plugins.length > 0) {
    differences.push('plugins-content-not-materialized-in-mvp');
  }
  return differences;
}

/**
 * MVP-FR4/FR10: bind a revision + client into a fresh `LaunchPlan`. The
 * client-support check happens first and throws before anything is
 * persisted or shown -- `configs use`/`switch` on `claude-code`/
 * `codex-cli` must never create a plan or display a confirmation.
 *
 * A revision that does not exist or cannot be resolved does *not* throw:
 * it produces a plan that is immediately `prepared -> failed` (reusing
 * `ConfigNotFoundError`/`ConfigUnsupportedError`'s message as the typed
 * reason) so the CLI can render the failure the same way it renders any
 * other launch failure.
 */
export async function prepareLaunchPlan(
  deps: LaunchDeps,
  params: { readonly revisionId: string; readonly client: ClientId },
): Promise<LaunchPlan> {
  const support = resolveClientSupport(params.client);
  if (!support.supported) {
    throw new UnsupportedClientError(params.client, support.reason ?? 'unsupported client');
  }

  const createdAt = new Date().toISOString();
  const planHash = computePlanHash(params.revisionId, params.client, createdAt);

  let configName = params.revisionId;
  let prepareFailureReason: string | null = null;
  try {
    const revision = await getConfigRevisionDetail(deps.configRepository, params.revisionId);
    configName = revision.configName;
  } catch (error) {
    if (error instanceof ConfigNotFoundError || error instanceof ConfigUnsupportedError) {
      prepareFailureReason = error.message;
    } else {
      throw error;
    }
  }

  let plan = createLaunchPlan({
    planId: generateId('plan'),
    operationId: generateId('op'),
    revisionId: params.revisionId,
    configName,
    client: params.client,
    planHash,
    createdAt,
  });

  const event =
    prepareFailureReason !== null
      ? ({ type: 'prepared-failed', reason: prepareFailureReason } as const)
      : ({ type: 'prepared-ok' } as const);
  const result = transitionLaunchPlan(plan, event);
  if (!result.ok) {
    throw new InvalidTransitionError(plan.planId, plan.phase, event.type, result.reason);
  }
  plan = result.plan;

  await deps.launchPlanRepository.save(plan);
  return plan;
}

/**
 * MVP-FR5/FR8: confirm exactly once. The token is built from the plan's
 * own current identity, so the only way this can fail is that the plan is
 * no longer `awaiting-confirmation` -- which is always surfaced as
 * `StaleConfirmationError` regardless of the domain-level reason string.
 */
export async function confirmLaunchPlan(deps: LaunchDeps, planId: string): Promise<LaunchPlan> {
  const plan = await deps.launchPlanRepository.findById(planId);
  if (plan === null) {
    throw new LaunchPlanNotFoundError(planId);
  }

  const result = transitionLaunchPlan(plan, {
    type: 'confirmed',
    token: { planId: plan.planId, revisionId: plan.revisionId, planHash: plan.planHash, issuedAt: new Date().toISOString() },
  });
  if (!result.ok) {
    throw new StaleConfirmationError(planId, result.reason);
  }

  await deps.launchPlanRepository.save(result.plan);
  return result.plan;
}

/** User declined the confirmation: `awaiting-confirmation -> cancelled`. OMP is never started. */
export async function rejectLaunchPlan(deps: LaunchDeps, planId: string): Promise<LaunchPlan> {
  const plan = await deps.launchPlanRepository.findById(planId);
  if (plan === null) {
    throw new LaunchPlanNotFoundError(planId);
  }
  const result = transitionLaunchPlan(plan, { type: 'rejected' });
  if (!result.ok) {
    throw new InvalidTransitionError(planId, plan.phase, 'rejected', result.reason);
  }
  await deps.launchPlanRepository.save(result.plan);
  return result.plan;
}

function deriveOutcome(
  spawnResult: OmpSpawnResult,
  applyResult: 'applied' | 'degraded',
): { readonly outcome: ObservedOutcome; readonly reason?: string } {
  if (spawnResult.exitCode === 0) {
    return { outcome: applyResult === 'applied' ? 'succeeded' : 'degraded' };
  }
  if (spawnResult.exitCode !== null) {
    return { outcome: 'failed', reason: `omp exited with code ${spawnResult.exitCode}` };
  }
  return {
    outcome: 'incomplete',
    reason: `omp process ended without a determinable exit code (signal: ${spawnResult.signal ?? 'unknown'})`,
  };
}

function applyFailure(plan: LaunchPlan, reason: string): LaunchPlan {
  const result = transitionLaunchPlan(plan, { type: 'apply-failed', reason });
  if (!result.ok) {
    throw new InvalidTransitionError(plan.planId, plan.phase, 'apply-failed', result.reason);
  }
  return result.plan;
}

/**
 * MVP-FR4/FR6/FR7/FR9: generate the launch context, probe native
 * capability, spawn OMP directly (argv array, never a shell) and observe
 * its outcome. `plan` must already be `applying` (i.e. already confirmed).
 *
 * The capability probe result decides whether the thin extension is
 * loaded at all: `'supported'` means OMP's native interface already
 * covers the status/switch contract, so no extension is installed (never
 * two competing fact sources); anything else installs it. Design Notes:
 * the real probe always returns `'unsupported'` today, but this branch is
 * kept structurally symmetric rather than special-cased away.
 */
export async function launchOmp(
  deps: LaunchOmpDeps,
  params: {
    readonly planId: string;
    readonly extensionPath: string;
    readonly forwardedArgs: readonly string[];
    readonly cwd: string;
    /**
     * Invoked exactly once, synchronously, immediately before `omp` is
     * actually spawned -- i.e. the true moment stdio control transfers.
     * Every earlier failure path (revision re-fetch, capability probe,
     * context-writer) returns a `failed` plan without ever reaching this
     * point, so a caller printing a "handing off to omp" line from this
     * callback (rather than unconditionally before calling `launchOmp`)
     * never prints it for a launch that never actually spawned `omp`.
     */
    readonly onSpawning?: () => void;
  },
): Promise<LaunchPlan> {
  let plan = await deps.launchPlanRepository.findById(params.planId);
  if (plan === null) {
    throw new LaunchPlanNotFoundError(params.planId);
  }
  if (plan.phase !== 'applying') {
    throw new InvalidTransitionError(
      params.planId,
      plan.phase,
      'spawn-process',
      'launchOmp requires a plan already in the "applying" phase (confirm it first)',
    );
  }

  let revision: StableConfigRevision;
  try {
    revision = await getConfigRevisionDetail(deps.configRepository, plan.revisionId);
  } catch (error) {
    if (error instanceof ConfigNotFoundError || error instanceof ConfigUnsupportedError) {
      // The revision became unavailable (deleted/unsupported) sometime
      // between the user's one-time confirmation and this re-fetch -- go
      // through the same typed-failure path as every other failure mode in
      // this function instead of letting the error escape unhandled.
      plan = applyFailure(plan, `revision-lookup: ${error.message}`);
      await deps.launchPlanRepository.save(plan);
      return plan;
    }
    throw error;
  }
  const knownDifferences = computeKnownDifferences(revision);
  const applyResult: 'applied' | 'degraded' = knownDifferences.length === 0 ? 'applied' : 'degraded';

  const probe = await deps.capabilityProbe.probeStatusViewingCapability();
  if (probe.level === 'unknown') {
    plan = applyFailure(plan, `spawn-process: ${probe.reason}`);
    await deps.launchPlanRepository.save(plan);
    return plan;
  }

  const extensionPath = probe.level === 'supported' ? null : params.extensionPath;

  const launchContextPath = await deps.contextWriter.write({
    version: 1,
    planId: plan.planId,
    configName: plan.configName,
    revisionId: plan.revisionId,
    client: plan.client,
    launchedAt: new Date().toISOString(),
    applyResult,
    knownDifferences,
    switchEntryPointHint: 'run `configs switch <id>` in the Agent System CLI',
  });

  let spawnResult: OmpSpawnResult;
  try {
    params.onSpawning?.();
    spawnResult = await deps.ompPort.spawn({
      revision,
      launchContextPath,
      extensionPath,
      forwardedArgs: params.forwardedArgs,
      cwd: params.cwd,
    });
  } catch (error) {
    plan = applyFailure(plan, `spawn-process: ${(error as Error).message}`);
    await deps.launchPlanRepository.save(plan);
    return plan;
  }

  const started = transitionLaunchPlan(plan, { type: 'process-started' });
  if (!started.ok) {
    throw new InvalidTransitionError(plan.planId, plan.phase, 'process-started', started.reason);
  }
  plan = started.plan;
  await deps.launchPlanRepository.save(plan);

  const outcome = deriveOutcome(spawnResult, applyResult);
  const observed = transitionLaunchPlan(plan, { type: 'observed', outcome: outcome.outcome, reason: outcome.reason });
  if (!observed.ok) {
    throw new InvalidTransitionError(plan.planId, plan.phase, 'observed', observed.reason);
  }
  plan = observed.plan;
  await deps.launchPlanRepository.save(plan);
  return plan;
}

/**
 * `[Epic 4 retro fix]` No repository query exists for "most recently created
 * plan across every client" (`findActiveForClient` is scoped to one client
 * by design -- see its own doc comment). Bare `configs status` must not
 * favor `'omp'` now that `'claude-code'` is a second real client
 * (Story 4.6): fan out across every known client and keep the newest
 * `createdAt` (ISO-8601 strings sort lexicographically the same as
 * chronologically). `null` only when no client has ever produced a plan.
 */
async function findMostRecentActivePlan(repository: LaunchPlanRepository): Promise<LaunchPlan | null> {
  const candidates = await Promise.all(ALL_CLIENT_IDS.map((client) => repository.findActiveForClient(client)));
  return candidates.reduce<LaunchPlan | null>((newest, candidate) => {
    if (candidate === null) {
      return newest;
    }
    if (newest === null || candidate.createdAt > newest.createdAt) {
      return candidate;
    }
    return newest;
  }, null);
}

/**
 * MVP-FR6: read-only projection of a plan's launch status. Recomputes
 * `knownDifferences` fresh from the (immutable) revision rather than
 * persisting a copy, so `status` always reflects the same derivation
 * `launchOmp` used.
 *
 * `[Epic 4 retro fix]` `knownDifferences` is only recomputed this way for
 * `'omp'` plans. `'claude-code'` plans (Story 4.6/AD-21) need a live
 * capability probe + content-materialization result to know their real
 * differences (`computeClaudeKnownDifferences` in `claude-launch.ts`) --
 * that pair is computed once, at launch time, and deliberately never
 * persisted (this is a read-only status projection, not a place to
 * re-probe/re-materialize). Re-running OMP's own MVP-flavored
 * `computeKnownDifferences` against a Claude revision produced the bug this
 * fixes: a successful, fully-materialized Claude launch still printed
 * `instructions-content-not-materialized-in-mvp`, which was simply false.
 * An honest Unknown-style marker (mirroring the existing
 * `revision-detail-unavailable-for-status-view` case just below) replaces
 * it instead of fabricating client-specific detail this function cannot
 * cheaply and safely recompute.
 */
export async function getLaunchStatus(deps: LaunchStatusDeps, planId: string | null, clientVersion?: Fact<string>): Promise<LaunchStatus> {
  const plan = planId !== null ? await deps.launchPlanRepository.findById(planId) : await findMostRecentActivePlan(deps.launchPlanRepository);
  if (plan === null) {
    throw new LaunchPlanNotFoundError(planId ?? '(no active plan)');
  }

  let knownDifferences: string[];
  if (plan.client !== 'omp') {
    knownDifferences = ['claude-known-differences-not-recomputed-for-status-view'];
  } else {
    try {
      const revision = await getConfigRevisionDetail(deps.configRepository, plan.revisionId);
      knownDifferences = computeKnownDifferences(revision);
    } catch (error) {
      // Only a typed "the revision itself couldn't be resolved" failure
      // degrades the status view to an Unknown-style known-difference --
      // any other (unexpected/infra) error must propagate, matching the
      // `isConfigQueryError` discrimination pattern used elsewhere in this
      // codebase rather than silently mislabeling it.
      if (error instanceof ConfigNotFoundError || error instanceof ConfigUnsupportedError) {
        knownDifferences = ['revision-detail-unavailable-for-status-view'];
      } else {
        throw error;
      }
    }
  }

  const resolvedClientVersion =
    clientVersion ??
    (await (plan.client === 'omp'
      ? deps.ompPort.detectVersion()
      : deps.claudeProcessPort !== undefined
        ? deps.claudeProcessPort.detectVersion()
        : Promise.resolve(unknown(`no-version-detector-available-for-client-${plan.client}`, new Date().toISOString()))));
  return deriveLaunchStatus(plan, resolvedClientVersion, knownDifferences);
}

export interface ConfigSwitchResult {
  readonly previousPlan: LaunchPlan;
  readonly newPlan: LaunchPlan;
}

/**
 * MVP-FR8: switching configuration never hot-reloads or auto-resumes the
 * current process. The current plan (must be `succeeded`/`degraded`) is
 * moved to `requires-restart`, and a brand-new plan is created for the new
 * revision, requiring its own fresh confirmation.
 */
export async function requestConfigSwitch(
  deps: LaunchDeps,
  params: { readonly currentPlanId: string; readonly newRevisionId: string; readonly client: ClientId },
): Promise<ConfigSwitchResult> {
  const currentPlan = await deps.launchPlanRepository.findById(params.currentPlanId);
  if (currentPlan === null) {
    throw new LaunchPlanNotFoundError(params.currentPlanId);
  }

  const switched = transitionLaunchPlan(currentPlan, { type: 'switch-requested' });
  if (!switched.ok) {
    throw new InvalidTransitionError(params.currentPlanId, currentPlan.phase, 'switch-requested', switched.reason);
  }
  await deps.launchPlanRepository.save(switched.plan);

  const newPlan = await prepareLaunchPlan(deps, { revisionId: params.newRevisionId, client: params.client });
  return { previousPlan: switched.plan, newPlan };
}
