/**
 * `[Story 4.3]` Fresh-target launch/observe for the Claude Code adapter
 * (AD-20's `fresh` branch). Deliberately isomorphic to `application/
 * launch.ts`'s OMP flow (`prepareLaunchPlan`/`launchOmp`) -- same shared
 * `domain/activation.ts` state machine (`createLaunchPlan`/
 * `transitionLaunchPlan`), same `prepared -> awaiting-confirmation ->
 * applying -> observing -> succeeded|degraded|failed|incomplete` lifecycle
 * -- but never routed through `resolveClientSupport`/`prepareLaunchPlan`/
 * `launchOmp` themselves. Two reasons:
 *
 *  1. `[Story 4.6]` `resolveClientSupport('claude-code')` now returns
 *     `supported: true` (this file's own adapter, delivered across
 *     Story 4.1~4.5b, is exactly what makes that true) -- but these
 *     entrypoints still never route through it. This file's launch
 *     entrypoints are Claude-specific already (calling
 *     `prepareClaudeFreshLaunchPlan` at all *is* the "this client is
 *     supported here" signal), so re-checking that generic gate here would
 *     be redundant, not load-bearing. `tests/application/launch.test.ts`'s
 *     "不支持的客户端" case now pins `codex-cli` instead (see
 *     `tests/domain/client.test.ts` for the flipped `claude-code`
 *     assertion).
 *  2. `launchOmp` is hardcoded to OMP's own ports/argv-building/skills-only
 *     assembly story; forking a small, explicit set of Claude-specific
 *     functions here (mirroring its structure, not its OMP-specific
 *     content) is safer than trying to generalize `launch.ts` into a
 *     multi-client function and risking the ~344 existing OMP tests that
 *     already pin its exact behavior.
 *
 * `confirmLaunchPlan`/`rejectLaunchPlan` (from `application/launch.ts`) are
 * reused as-is (not duplicated) -- both operate purely on `LaunchPlan` via
 * `LaunchDeps` (`configRepository`/`launchPlanRepository`) and never touch
 * `resolveClientSupport` or any OMP-specific port, so they are already
 * client-agnostic.
 *
 * `[Story 4.4]` This file also carries AD-20's other launch target,
 * `prepareClaudeAlreadyRunningLaunchPlan` (the `already-running` branch):
 * unlike `launchClaudeFresh`, it never reaches `awaiting-confirmation`/
 * `applying`/`observing` at all -- it resolves a plan straight from
 * `prepared` to the existing `requires-restart` terminal phase via
 * `domain/activation.ts`'s `target-requires-restart` event, needs none of
 * `LaunchClaudeFreshDeps`' probe/spawn/context/invocation-dir ports, and
 * takes only the plain `LaunchDeps` this file already imports for
 * `prepareClaudeFreshLaunchPlan`.
 */
import {
  type LaunchPhase,
  type LaunchPlan,
  type ObservationStage,
  computePlanHash,
  createLaunchPlan,
  transitionLaunchPlan,
} from '../domain/activation';
import type { StableConfigRevision } from '../domain/config';
import { argvContributingCapabilityIds, compileClaudeAdapterPlan, determineClaudeLaunchTarget } from '../adapters/clients/claude/adapter-plan';
import type { ClaudeAdapterPlan } from '../adapters/clients/claude/adapter-plan';
import { compileClaudeAssemblyManifest } from '../adapters/clients/claude/assembly-manifest';
import type { ClaudeAssemblyManifest } from '../adapters/clients/claude/assembly-manifest';
import type { ClaudeContentMaterializationResult, ClaudeMaterializationFailure } from '../adapters/clients/claude/content-materializer';
import { InvalidTransitionError, LaunchPlanNotFoundError, type LaunchDeps } from './launch';
import { ConfigNotFoundError, ConfigUnsupportedError, getConfigRevisionDetail } from './queries';
import type {
  ClaudeCapabilityProbePort,
  ClaudeContentMaterializerPort,
  ClaudeInvocationDirPort,
  ClaudeLaunchContextWriter,
  ClaudeProcessPort,
  ClaudeSpawnResult,
  ConfigRevisionRepository,
  LaunchPlanRepository,
} from './ports';

export type { LaunchDeps };

export interface LaunchClaudeFreshDeps extends LaunchDeps {
  readonly claudeProcessPort: ClaudeProcessPort;
  readonly claudeCapabilityProbe: ClaudeCapabilityProbePort;
  readonly claudeLaunchContextWriter: ClaudeLaunchContextWriter;
  readonly claudeInvocationDirPort: ClaudeInvocationDirPort;
  /** `[Epic 4 retro fix]` AD-21 content materialization, now behind the same kind of port every other real-IO collaborator here already uses. */
  readonly claudeContentMaterializer: ClaudeContentMaterializerPort;
}

function generateId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

/**
 * `[Story 4.3]` Honest content-materialization gaps for a fresh Claude Code
 * launch, mirroring `application/launch.ts`'s `computeKnownDifferences` for
 * OMP.
 *
 * `[Story 4.5b]` AD-21 changes what "not materialized" means: this Story's
 * fresh launch now genuinely reads `sourceRef`-resolved Instructions/Skills/
 * MCP content and delivers it (`--append-system-prompt`/`--plugin-dir`/
 * `--mcp-config`) whenever `materializeClaudeContent` fully succeeds for
 * that group -- so a fully-materialized, non-empty group no longer counts as
 * a difference at all. A group only still counts as a difference when
 * `materialization` reports failures for it (only reachable when that
 * group's governing capability is *not* `required` -- see
 * `resolveContentGroupDelivery`'s Design Notes; every real, relevant
 * capability today is `required: true`, so this remains structurally
 * possible but not exercised by real `.cap/` data). `hooks`/`plugins` are
 * still entirely out of AD-21's scope (Story 4.2's `Never` boundary) and
 * always count as a difference when referenced, exactly as before -- read
 * from `revision` directly, never from `ClaudeAssemblyManifest`.
 */
export function computeClaudeKnownDifferences(
  revision: StableConfigRevision,
  manifest: ClaudeAssemblyManifest,
  materialization: ClaudeContentMaterializationResult,
): string[] {
  const differences: string[] = [];
  if (revision.instructions.length > 0 && materialization.instructions.failures.length > 0) {
    differences.push('instructions-content-not-materialized-in-fresh-launch');
  }
  if (revision.skills.length > 0 && materialization.skills.failures.length > 0) {
    differences.push('skills-content-not-materialized-in-fresh-launch');
  }
  if (revision.mcp.length > 0 && materialization.mcp.failures.length > 0) {
    differences.push('mcp-content-not-materialized-in-fresh-launch');
  }
  if (revision.hooks.length > 0) {
    differences.push('hooks-content-not-materialized-in-fresh-launch');
  }
  if (revision.plugins.length > 0) {
    differences.push('plugins-content-not-materialized-in-fresh-launch');
  }
  if (manifest.degradedCapabilities.length > 0) {
    differences.push(`degraded-capabilities: ${[...manifest.degradedCapabilities].sort().join(', ')}`);
  }
  return differences;
}

/** The `capabilityPolicy` note's own `required` flag governing one AD-21 content group; conservatively `true` when no such note exists at all (defensive-only -- every group this Story materializes has a governing capability). */
function requiredForContentGroup(manifest: ClaudeAssemblyManifest, capabilityId: string): boolean {
  return manifest.capabilityPolicy.find((note) => note.capabilityId === capabilityId)?.required ?? true;
}

function describeMaterializationFailures(failures: readonly ClaudeMaterializationFailure[]): string {
  return failures.length > 0 ? failures.map((failure) => `${failure.name}(${failure.reason})`).join('; ') : '未知原因';
}

/**
 * `[Story 4.5b]` AD-21's per-group launch decision, over one content group's
 * already-computed materialization outcome: an empty group never blocks and
 * never delivers anything; a fully-materialized non-empty group delivers its
 * real argv contribution; a partially/fully failed group blocks the whole
 * launch when its governing capability is `required` (today, always -- see
 * `requiredForContentGroup`), or is silently excluded from delivery
 * (degraded, not fabricated) when not. This is the one place AD-21's "不得
 * 部分物化后仍然 spawn" boundary is actually enforced.
 */
interface ContentGroupDeliveryPlan {
  readonly argv: readonly string[];
  readonly blocked: { readonly capabilityId: string; readonly reason: string } | null;
}

function resolveContentGroupDelivery(
  groupNonEmpty: boolean,
  failures: readonly ClaudeMaterializationFailure[],
  buildArgv: () => readonly string[],
  required: boolean,
  capabilityId: string,
): ContentGroupDeliveryPlan {
  if (!groupNonEmpty) {
    return { argv: [], blocked: null };
  }
  if (failures.length === 0) {
    return { argv: buildArgv(), blocked: null };
  }
  if (required) {
    return {
      argv: [],
      blocked: { capabilityId, reason: `${capabilityId} 内容物化失败：${describeMaterializationFailures(failures)}` },
    };
  }
  return { argv: [], blocked: null };
}

/**
 * `[Story 4.3]` Mirrors `application/launch.ts`'s `prepareLaunchPlan`, minus
 * the `resolveClientSupport` gate (see this file's top-of-file Design
 * Note). Capability probing and manifest/plan compilation are deliberately
 * deferred to `launchClaudeFresh` (matching OMP's own structure exactly:
 * `prepareLaunchPlan` never probes OMP's capability either) -- `prepare`
 * only resolves whether the chosen revision exists at all.
 */
export async function prepareClaudeFreshLaunchPlan(
  deps: LaunchDeps,
  params: { readonly revisionId: string },
): Promise<LaunchPlan> {
  const createdAt = new Date().toISOString();
  const planHash = computePlanHash(params.revisionId, 'claude-code', createdAt);

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
    client: 'claude-code',
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
 * `[Story 4.3]` AC2's display-support projection: everything a caller needs
 * to show "which stage failed, which capabilities were affected, the known
 * reason and a recovery action" without persisting anything new or
 * changing `domain/activation.ts`'s canonical `LaunchPlan` shape.
 * `manifest`/`adapterPlan` are `null` only when the flow never reached
 * (or could not reach) that compilation stage.
 */
export interface ClaudeLaunchOutcome {
  readonly plan: LaunchPlan;
  readonly observationStage: ObservationStage;
  readonly manifest: ClaudeAssemblyManifest | null;
  readonly adapterPlan: ClaudeAdapterPlan | null;
  /** `capabilityId`s implicated in a failure/degradation; empty when none are. */
  readonly affectedCapabilities: readonly string[];
  /** Human-readable next step; `null` only when the outcome was not a failure. */
  readonly recoveryAction: string | null;
}

function applyFailure(plan: LaunchPlan, reason: string): LaunchPlan {
  const result = transitionLaunchPlan(plan, { type: 'apply-failed', reason });
  if (!result.ok) {
    throw new InvalidTransitionError(plan.planId, plan.phase, 'apply-failed', result.reason);
  }
  return result.plan;
}

function outcomeFor(
  plan: LaunchPlan,
  observationStage: ObservationStage,
  manifest: ClaudeAssemblyManifest | null,
  adapterPlan: ClaudeAdapterPlan | null,
  affectedCapabilities: readonly string[],
  recoveryAction: string | null,
): ClaudeLaunchOutcome {
  return { plan, observationStage, manifest, adapterPlan, affectedCapabilities, recoveryAction };
}

/**
 * `[Story 4.4]` AD-20's already-running-session launch target: this product
 * does not own that process, so `apply` can only ever resolve to the
 * existing `requires-restart` terminal phase (AD-18) -- never `awaiting-
 * confirmation`/`applying`/`observing`. Deliberately calls
 * `deps.launchPlanRepository.save` exactly once (after the plan already
 * landed on its terminal phase) and never calls `claudeCapabilityProbe`,
 * `compileClaudeAssemblyManifest`/`compileClaudeAdapterPlan`, or
 * `claudeProcessPort.spawn` -- any of those would compute something that
 * looks like progress toward "applying" a plan this function can never
 * really apply, which is exactly the kind of half-true intermediate result
 * AD-10 forbids. `configName` resolution mirrors
 * `prepareClaudeFreshLaunchPlan`'s best-effort revision lookup, but --
 * unlike that function -- a lookup failure never blocks the terminal
 * outcome: whether or not the revision exists, the only possible terminal
 * phase for an already-running target is `requires-restart` (there is
 * nothing to have "not found" against, since nothing was ever going to be
 * applied).
 */
export async function prepareClaudeAlreadyRunningLaunchPlan(
  deps: LaunchDeps,
  params: { readonly revisionId: string },
): Promise<ClaudeLaunchOutcome> {
  const createdAt = new Date().toISOString();
  const planHash = computePlanHash(params.revisionId, 'claude-code', createdAt);

  let configName = params.revisionId;
  try {
    const revision = await getConfigRevisionDetail(deps.configRepository, params.revisionId);
    configName = revision.configName;
  } catch (error) {
    if (!(error instanceof ConfigNotFoundError || error instanceof ConfigUnsupportedError)) {
      throw error;
    }
    // Best-effort only (mirrors `prepareClaudeFreshLaunchPlan`): whether the
    // revision resolves or not, the already-running target's only possible
    // terminal phase is `requires-restart` -- a lookup failure here never
    // blocks or changes that outcome.
  }

  let plan = createLaunchPlan({
    planId: generateId('plan'),
    operationId: generateId('op'),
    revisionId: params.revisionId,
    configName,
    client: 'claude-code',
    planHash,
    createdAt,
  });

  // AD-10/AD-20 fail-closed target determination: this Story never has real
  // "this is the fresh spawn itself" evidence to offer (that is Story 4.5's
  // self-introspection scope), so it always passes `ownsFreshSpawn: false`.
  // The exhaustive `switch` below is the "forces every call site to revisit
  // its judgment" enforcement Story 4.3's `ClaudeLaunchTarget` doc comment
  // predicted -- it is not dead code: it fails loudly (rather than silently
  // mis-handling a `'fresh'` target as already-running) if this determinism
  // is ever violated.
  const target = determineClaudeLaunchTarget({ ownsFreshSpawn: false });
  switch (target) {
    case 'already-running':
      break;
    case 'fresh':
      throw new Error(
        `prepareClaudeAlreadyRunningLaunchPlan requires determineClaudeLaunchTarget to resolve to "already-running", got "${target}"`,
      );
    default: {
      const exhaustive: never = target;
      throw new Error(`prepareClaudeAlreadyRunningLaunchPlan encountered an unrecognized ClaudeLaunchTarget: "${exhaustive}"`);
    }
  }

  const transitioned = transitionLaunchPlan(plan, { type: 'target-requires-restart' });
  if (!transitioned.ok) {
    throw new InvalidTransitionError(plan.planId, plan.phase, 'target-requires-restart', transitioned.reason);
  }
  plan = transitioned.plan;

  await deps.launchPlanRepository.save(plan);

  return outcomeFor(
    plan,
    'planned',
    null,
    null,
    [],
    '需要重启当前 Claude Code 会话后重新应用：本产品无法对一个已经在运行的、非本产品拥有的会话热更新装配边界。',
  );
}

/** Mirrors `application/launch.ts`'s private `deriveOutcome` (same logic, over the Claude-specific `ClaudeSpawnResult` shape). */
function deriveClaudeObservedOutcome(
  spawnResult: ClaudeSpawnResult,
  applyResult: 'applied' | 'degraded',
): { readonly outcome: 'succeeded' | 'degraded' | 'failed' | 'incomplete'; readonly reason?: string } {
  if (spawnResult.exitCode === 0) {
    return { outcome: applyResult === 'applied' ? 'succeeded' : 'degraded' };
  }
  if (spawnResult.exitCode !== null) {
    return { outcome: 'failed', reason: `claude exited with code ${spawnResult.exitCode}` };
  }
  return {
    outcome: 'incomplete',
    reason: `claude process ended without a determinable exit code (signal: ${spawnResult.signal ?? 'unknown'})`,
  };
}

/**
 * `[Story 4.3]` AC1/AC2: generate the isolated invocation directory, probe
 * fresh hard-control capability evidence, compile the assembly manifest and
 * the real launch-facing `ClaudeAdapterPlan`, spawn a brand-new `claude`
 * process (never this repo's own running session, never touching `.cap/`)
 * and observe its outcome. `plan` must already be `applying` (i.e. already
 * confirmed via `confirmLaunchPlan`).
 *
 * Every failure path returns (never throws) a `ClaudeLaunchOutcome` whose
 * `plan.phase` is a valid AD-18 terminal-or-well-defined phase -- there is
 * no half-updated `LaunchPlan`: `deps.launchPlanRepository.save` is only
 * ever called with a complete, newly-transitioned plan, so an exception
 * partway through this function can never leave a stored plan in an
 * inconsistent phase (AC1's "不产生部分应用状态").
 */
export async function launchClaudeFresh(
  deps: LaunchClaudeFreshDeps,
  params: { readonly planId: string; readonly onSpawning?: () => void },
): Promise<ClaudeLaunchOutcome> {
  let plan = await deps.launchPlanRepository.findById(params.planId);
  if (plan === null) {
    throw new LaunchPlanNotFoundError(params.planId);
  }
  // Defensive: this plan repository is shared across clients (`LaunchPlan.client`
  // is a plain `ClientId` field, not a type-level guarantee) -- a plan created
  // for a different client (e.g. `omp`) must never be treated as a Claude
  // fresh launch just because its `planId` was passed here. `launchOmp` has
  // the same latent gap on the OMP side (this codebase's only other launch
  // entrypoint); this Story does not fix that OMP-side gap (out of scope,
  // would touch `application/launch.ts`), but does not repeat it here.
  if (plan.client !== 'claude-code') {
    throw new InvalidTransitionError(
      params.planId,
      plan.phase,
      'spawn-process',
      `launchClaudeFresh requires a plan whose client is "claude-code", got "${plan.client}"`,
    );
  }
  if (plan.phase !== 'applying') {
    throw new InvalidTransitionError(
      params.planId,
      plan.phase,
      'spawn-process',
      'launchClaudeFresh requires a plan already in the "applying" phase (confirm it first)',
    );
  }

  let revision: StableConfigRevision;
  try {
    revision = await getConfigRevisionDetail(deps.configRepository, plan.revisionId);
  } catch (error) {
    if (error instanceof ConfigNotFoundError || error instanceof ConfigUnsupportedError) {
      plan = applyFailure(plan, `revision-lookup: ${error.message}`);
      await deps.launchPlanRepository.save(plan);
      return outcomeFor(plan, 'planned', null, null, [], '重新选择一个当前存在且受支持的配置修订后重试');
    }
    throw error;
  }

  const probeResults = await deps.claudeCapabilityProbe.probeHardControlCapabilities();
  const manifestResult = compileClaudeAssemblyManifest(revision, probeResults);

  if (manifestResult.kind === 'blocked') {
    plan = applyFailure(plan, `capability-blocked: ${manifestResult.missingRequiredCapabilities.join(', ')}`);
    await deps.launchPlanRepository.save(plan);
    return outcomeFor(
      plan,
      'planned',
      null,
      null,
      manifestResult.missingRequiredCapabilities,
      '确认 Claude Code 版本/环境支持上述必需能力（重新执行 probe 验证），或改用受支持能力覆盖的配置修订后重试',
    );
  }

  const manifest = manifestResult.manifest;
  const adapterPlan = compileClaudeAdapterPlan(manifest);

  let invocationDir: string;
  try {
    invocationDir = await deps.claudeInvocationDirPort.prepare(plan.operationId);
  } catch (error) {
    plan = applyFailure(plan, `invocation-dir: ${(error as Error).message}`);
    await deps.launchPlanRepository.save(plan);
    return outcomeFor(plan, 'planned', manifest, adapterPlan, [], '确认本机磁盘可写且 Agent System 状态目录权限正常后重试');
  }

  // `[Epic 4 retro fix]` AD-21's cleanup constraint ("not before the spawned
  // process may still be reading") is satisfied by construction: every path
  // out of this `try` either never spawned `claude` at all, or already holds
  // `spawnResult` -- and `ClaudeProcessPort.spawn` (see
  // `adapters/clients/claude/process-port.ts`) only ever resolves after
  // `proc.exited`, i.e. the child has already fully exited. So cleanup in
  // `finally`, unconditionally, after every early `return` in this block,
  // is always safe. Best-effort: `cleanup`'s own contract never throws (see
  // `ClaudeInvocationDirPort`'s Design Notes), so it never masks whichever
  // outcome the `try` block actually produced.
  try {
    // `[Story 4.5b]` AD-21: read `sourceRef`-resolved real content and write it
    // under `invocationDir/materialized/` -- must happen after the invocation
    // directory exists, before the launch context is written or `claude` is
    // spawned. Any `required` group's failure fails this launch closed here,
    // before any content is ever handed to a spawned process (never a partial
    // materialization followed by a spawn -- see `resolveContentGroupDelivery`).
    // `materializeClaudeContent` itself is designed to never throw (every real
    // IO call it makes is individually caught and turned into a reported
    // `ClaudeMaterializationFailure`), but this call site is still guarded the
    // same way the `invocationDir` prepare step immediately above it is --
    // defense in depth against any future/unforeseen throw, never a silent
    // fallback to an unhandled rejection.
    let materialization: ClaudeContentMaterializationResult;
    try {
      materialization = await deps.claudeContentMaterializer.materialize(revision, invocationDir);
    } catch (error) {
      plan = applyFailure(plan, `content-materialization: ${(error as Error).message}`);
      await deps.launchPlanRepository.save(plan);
      return outcomeFor(plan, 'planned', manifest, adapterPlan, [], '确认内容来源路径可读、本机磁盘可写后重试');
    }

    const instructionsDelivery = resolveContentGroupDelivery(
      revision.instructions.length > 0,
      materialization.instructions.failures,
      () =>
        materialization.instructions.appendSystemPromptText !== null
          ? ['--append-system-prompt', materialization.instructions.appendSystemPromptText]
          : [],
      requiredForContentGroup(manifest, 'claude.append-system-prompt-delivery'),
      'claude.append-system-prompt-delivery',
    );
    const skillsDelivery = resolveContentGroupDelivery(
      revision.skills.length > 0,
      materialization.skills.failures,
      () => (materialization.skills.pluginDirPath !== null ? ['--plugin-dir', materialization.skills.pluginDirPath] : []),
      requiredForContentGroup(manifest, 'claude.plugin-dir-delivery'),
      'claude.plugin-dir-delivery',
    );
    // `[Story 4.5b]` `--strict-mcp-config` here duplicates the static flag
    // `adapter-plan.ts`'s `CAPABILITY_ARGV_MAP` already contributes for
    // `claude.mcp-project-scope-control` whenever that capability is relevant
    // (mcp non-empty) and supported/degraded -- which is guaranteed true by
    // the time this branch can even be reached (a `required`, relevant
    // capability that were `unsupported`/`unknown` would already have blocked
    // manifest compilation). Passing a boolean flag twice is harmless (last
    // value wins / idempotent), and AD-21's own Rule literally describes
    // `--mcp-config <path> --strict-mcp-config` as one atomic delivery pair,
    // so this is kept self-contained rather than relying on the static argv's
    // separately-computed contribution. Currently unreachable with real
    // `.cap/` data (both real profiles have empty `mcp`) -- same "path not yet
    // reachable, still correctly implemented" status the spec calls out.
    const mcpDelivery = resolveContentGroupDelivery(
      revision.mcp.length > 0,
      materialization.mcp.failures,
      () =>
        materialization.mcp.mcpConfigPath !== null
          ? ['--mcp-config', materialization.mcp.mcpConfigPath, '--strict-mcp-config']
          : [],
      requiredForContentGroup(manifest, 'claude.mcp-project-scope-control'),
      'claude.mcp-project-scope-control',
    );

    // `[Story 4.5b]` Collect *every* blocked content group, not just the first
    // -- mirrors the `manifestResult.kind === 'blocked'` branch above, which
    // lists all of `missingRequiredCapabilities` rather than a single one.
    // Multiple groups can legitimately fail to materialize simultaneously
    // (e.g. both Instructions and Skills reference unreadable `sourceRef`s),
    // and every one of them belongs in the failure reason / `affectedCapabilities`.
    const blockedDeliveries = [instructionsDelivery.blocked, skillsDelivery.blocked, mcpDelivery.blocked].filter(
      (blocked): blocked is { readonly capabilityId: string; readonly reason: string } => blocked !== null,
    );
    if (blockedDeliveries.length > 0) {
      plan = applyFailure(
        plan,
        `content-materialization-blocked: ${blockedDeliveries.map((blocked) => blocked.reason).join('; ')}`,
      );
      await deps.launchPlanRepository.save(plan);
      return outcomeFor(
        plan,
        'planned',
        manifest,
        adapterPlan,
        blockedDeliveries.map((blocked) => blocked.capabilityId),
        '确认对应内容（Instructions/Skills/MCP）的来源路径存在且可读后重试，或改用不引用该内容的配置修订',
      );
    }

    const dynamicContentArgv = [...instructionsDelivery.argv, ...skillsDelivery.argv, ...mcpDelivery.argv];
    const dynamicContentCapabilityIds = [
      ...(instructionsDelivery.argv.length > 0 ? ['claude.append-system-prompt-delivery'] : []),
      ...(skillsDelivery.argv.length > 0 ? ['claude.plugin-dir-delivery'] : []),
      ...(mcpDelivery.argv.length > 0 ? ['claude.mcp-project-scope-control'] : []),
    ];
    const finalArgv = [...adapterPlan.argv, ...dynamicContentArgv];

    const knownDifferences = computeClaudeKnownDifferences(revision, manifest, materialization);
    const applyResult: 'applied' | 'degraded' = knownDifferences.length === 0 && manifest.manifestStatus === 'ready' ? 'applied' : 'degraded';

    await deps.claudeLaunchContextWriter.write({
      version: 1,
      planId: plan.planId,
      operationId: plan.operationId,
      revisionId: plan.revisionId,
      configName: plan.configName,
      client: 'claude-code',
      launchTarget: 'fresh',
      launchedAt: new Date().toISOString(),
      applyResult,
      knownDifferences,
      adapterPlanHash: adapterPlan.planHash,
    });

    let spawnResult: ClaudeSpawnResult;
    try {
      params.onSpawning?.();
      spawnResult = await deps.claudeProcessPort.spawn({
        argv: finalArgv,
        env: { CLAUDE_CONFIG_DIR: invocationDir },
        cwd: invocationDir,
      });
    } catch (error) {
      plan = applyFailure(plan, `spawn-process: ${(error as Error).message}`);
      await deps.launchPlanRepository.save(plan);
      return outcomeFor(
        plan,
        'planned',
        manifest,
        adapterPlan,
        [...argvContributingCapabilityIds(manifest.capabilityPolicy), ...dynamicContentCapabilityIds],
        '确认 claude 二进制已安装并可从 PATH 直接执行后重试',
      );
    }

    const started = transitionLaunchPlan(plan, { type: 'process-started' });
    if (!started.ok) {
      throw new InvalidTransitionError(plan.planId, plan.phase, 'process-started', started.reason);
    }
    plan = started.plan;
    await deps.launchPlanRepository.save(plan);

    const outcome = deriveClaudeObservedOutcome(spawnResult, applyResult);
    const observed = transitionLaunchPlan(plan, { type: 'observed', outcome: outcome.outcome, reason: outcome.reason });
    if (!observed.ok) {
      throw new InvalidTransitionError(plan.planId, plan.phase, 'observed', observed.reason);
    }
    plan = observed.plan;
    await deps.launchPlanRepository.save(plan);

    const isFailureOutcome = outcome.outcome === 'failed' || outcome.outcome === 'incomplete';
    const affectedCapabilities = isFailureOutcome
      ? [...argvContributingCapabilityIds(manifest.capabilityPolicy), ...dynamicContentCapabilityIds]
      : manifest.degradedCapabilities;
    const recoveryAction =
      outcome.outcome === 'failed'
        ? '查看 claude 进程退出码与输出，确认宿主是否拒绝了本次装配的硬控制边界后再重试'
        : outcome.outcome === 'incomplete'
          ? '确认 claude 进程未被信号意外终止（如手动结束进程或系统重启）后重试'
          : null;

    // The process genuinely spawned and its exit was captured (the
    // `process-started` transition above only succeeds once `spawn()` has
    // already resolved) -- this is unambiguously `observed`, regardless of
    // which terminal outcome it landed on.
    return outcomeFor(plan, 'observed', manifest, adapterPlan, affectedCapabilities, recoveryAction);
  } finally {
    await deps.claudeInvocationDirPort.cleanup(invocationDir);
  }
}

/** Re-exported for callers that only need to reason about `LaunchPhase` alongside this file's outcome type. */
export type { LaunchPhase };
