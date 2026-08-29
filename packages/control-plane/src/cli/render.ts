/**
 * All text rendering for the three read-only views (list/detail/compare)
 * plus the shared empty-state and failure paths. Kept as pure
 * string-building functions over domain/application types so list, show
 * and compare can share the exact same formatting for common fields
 * (Code Map: "公共可导出视图共用同一渲染路径").
 *
 * `[DELTA]` Every user-readable string routes through `i18n.t()` (zh
 * default, `CONFIGS_LANG=en`); `LaunchPlan.phase`/`ComparisonStatus`/
 * `SourceCategory` values and `computeKnownDifferences` reason codes are
 * never translated. Only the four functions the Code Map calls out
 * (`renderLaunchStatus`, `renderLaunchFailure`, `renderSwitchAccepted`,
 * `renderConfirmationSummary`) plus `renderHandoffLine` apply `colors.ts`
 * semantic color -- `renderList`/`renderDetail`/`renderComparison`/
 * `renderQueryFailure` stay uncolored, matching the Code Map's scoped
 * color rollout.
 */

import { isKnown } from '../domain/facts';
import type { Fact } from '../domain/facts';
import type {
  CapabilityComparisonEntry,
  CapabilityGroupComparison,
  CapabilityKind,
  CapabilityReference,
  ComparisonResult,
  ScalarFieldComparison,
  StableConfigRevision,
  SupersedesChain,
  SupersedesLink,
} from '../domain/config';
import type { LaunchPlan, LaunchStatus } from '../domain/activation';
import type { CompareConfigRevisionsResult, ConfigQueryError } from '../application/queries';
import type {
  InvalidCandidateError,
  InvalidTriggerCategoryError,
  MissingEvidenceError,
  MissingSupersedesError,
  NoCandidateSourceError,
  SupersedesConfigMismatchError,
  SupersedesConflictError,
  SupersedesNotFoundError,
  SupplyDuplicateGroupError,
  SupplyDuplicateSkillNameError,
  SupplyGroupEmptyError,
  SupplyGroupNotFoundError,
  SupplyRefInvalidError,
  SupplyRootNotFoundError,
  SupplySourceUnreadableError,
  SupplyUnsupportedEntryError,
} from '../application/ports';
import type { SupplyRefRejection } from './supply-root';
import { attention, colorForPhase, dim } from './colors';
import { t, type TranslationKey } from './i18n';

/**
 * `[DELTA]` Replaces the old static `CAPABILITY_GROUP_LABELS` constant --
 * labels are now language-dependent (`i18n.t()` reads `CONFIGS_LANG` fresh
 * on every call), so this must be a function rather than a value computed
 * once at import time. Exported for the TUI (Code Map: "既有私有 helper 供
 * TUI 复用（避免重复格式化逻辑）").
 */
export function capabilityGroupLabel(kind: CapabilityKind): string {
  switch (kind) {
    case 'instruction':
      return t('capabilityGroup.instruction');
    case 'skill':
      return t('capabilityGroup.skill');
    case 'mcp':
      return t('capabilityGroup.mcp');
    case 'hook':
      return t('capabilityGroup.hook');
    case 'plugin':
      return t('capabilityGroup.plugin');
  }
}

export function formatFact<T>(fact: Fact<T>, format: (value: T) => string = String): string {
  return isKnown(fact) ? format(fact.value) : t('fact.unknown', { reason: fact.reason, observedAt: fact.observedAt });
}

export function formatAvailability(revision: StableConfigRevision): string {
  return isKnown(revision.availability) ? t('fact.available') : formatFact(revision.availability);
}

export function formatDefaultMarker(revision: StableConfigRevision): string {
  if (!isKnown(revision.defaultMarker)) {
    return formatFact(revision.defaultMarker);
  }
  return revision.defaultMarker.value ? t('marker.default') : t('marker.generic');
}

/**
 * `[Story 3.3]` Appends the assembly-provenance pair (`sourceRef`/
 * `contentFingerprint`) after the existing source-category/summary
 * fields -- never inferred, always the `Fact` persisted on the reference
 * itself (Unknown renders via `formatFact`, same as every other field
 * here).
 */
function formatCapabilityRef(ref: CapabilityReference): string {
  const source = formatFact(ref.sourceCategory);
  const summary = formatFact(ref.summary);
  const sourceRef = formatFact(ref.sourceRef);
  const contentFingerprint = formatFact(ref.contentFingerprint);
  return `    - ${ref.name} [${t('capabilityRef.source')}: ${source}] ${summary} [${t('capabilityRef.sourceRef')}: ${sourceRef}] [${t('capabilityRef.contentFingerprint')}: ${contentFingerprint}]`;
}

export function formatCapabilityGroup(kind: CapabilityKind, refs: readonly CapabilityReference[]): string {
  const label = capabilityGroupLabel(kind);
  if (refs.length === 0) {
    return `  ${label} ${t('capabilityGroup.emptySingle')}`;
  }
  return [`  ${label}`, ...refs.map(formatCapabilityRef)].join('\n');
}

/** MVP-FR1 empty state: honest, not a product failure. */
export function renderEmptyList(): string {
  return [t('emptyList.line1'), t('emptyList.line2'), t('emptyList.line3')].join('\n');
}

export function renderList(revisions: readonly StableConfigRevision[]): string {
  if (revisions.length === 0) {
    return renderEmptyList();
  }
  const lines = revisions.map((revision) => {
    const marker = formatDefaultMarker(revision);
    const boundary = formatFact(revision.scopeBoundary);
    return `- ${revision.configName}  ${t('list.revisionLabel')}=${revision.revisionId}  [${marker}]  ${t('list.statusLabel')}=${formatAvailability(revision)}\n    ${t('list.boundaryLabel')}: ${boundary}`;
  });
  return lines.join('\n');
}

export function renderDetail(revision: StableConfigRevision): string {
  const marker = formatDefaultMarker(revision);
  const lines = [
    `${t('detail.configuration')} ${revision.configName}`,
    `${t('detail.revision')} ${revision.revisionId}  [${marker}]`,
    `${t('detail.status')} ${formatAvailability(revision)}`,
    `${t('detail.boundary')} ${formatFact(revision.scopeBoundary)}`,
    // `[Story 3.3]` `triggerCategory` is a closed enum value (like
    // `ComparisonStatus`/`SourceCategory`) -- never translated, only the
    // label preceding it is. `evidenceRef` is an opaque reference string,
    // printed as-is.
    `${t('detail.triggerCategory')} ${revision.triggerCategory}`,
    `${t('detail.evidenceRef')} ${revision.evidenceRef}`,
    '',
    formatCapabilityGroup('instruction', revision.instructions),
    formatCapabilityGroup('skill', revision.skills),
    formatCapabilityGroup('mcp', revision.mcp),
  ];
  if (revision.hooks.length > 0) {
    lines.push(formatCapabilityGroup('hook', revision.hooks));
  }
  if (revision.plugins.length > 0) {
    lines.push(formatCapabilityGroup('plugin', revision.plugins));
  }
  return lines.join('\n');
}

/**
 * `[Story 3.1]` Widened beyond `ConfigQueryError` (`show`/`compare`'s two
 * read-path rejections) to also cover `configs establish`'s four
 * write-path rejections, so `renderQueryFailure` stays the one shared
 * failure-rendering path for every typed rejection in this CLI instead of
 * `establish` inventing a parallel one.
 *
 * `[Story 3.2]` Widened again to also cover `configs revise`'s four
 * additional supersedes-specific rejections -- same reasoning: one shared
 * failure-rendering path, not a parallel one for `revise`.
 *
 * `[Story 3.5]` 再次加宽，纳入 `configs supply` 的 fail-closed 拒绝。注意唯一的
 * 差别不在渲染，而在**写到哪条流**：`supply` 的正常产出是要被管道喂给
 * `configs establish` 的候选 JSON，所以它的失败块由调用点打到 stderr，stdout
 * 保持零输出（见 `cli/index.ts` 的 `runSupply`）——渲染本身仍是这一条共用路径。
 */
export type QueryOrEstablishError =
  | ConfigQueryError
  | InvalidTriggerCategoryError
  | MissingEvidenceError
  | NoCandidateSourceError
  | InvalidCandidateError
  | MissingSupersedesError
  | SupersedesNotFoundError
  | SupersedesConfigMismatchError
  | SupersedesConflictError
  | SupplyRootNotFoundError
  | SupplyGroupNotFoundError
  | SupplyGroupEmptyError
  | SupplyRefInvalidError
  | SupplyDuplicateGroupError
  | SupplyDuplicateSkillNameError
  | SupplySourceUnreadableError
  | SupplyUnsupportedEntryError;

/**
 * `[Review fix]` Exhaustiveness guard: if `QueryOrEstablishError` ever
 * gains a new member without a matching `case` below, TypeScript fails
 * `bun run typecheck` right here (the call site passes a non-`never`
 * value) -- and if that guarantee is ever bypassed at runtime (an
 * `as any`, a value from outside the closed union), this throws instead
 * of the switch silently falling through and rendering the literal string
 * `"undefined"`.
 */
/**
 * `[Story 3.5 / P9]` 把 `SupplyRefInvalidError` 的结构化三元组成句。
 *
 * 为什么不直接透传 `cli/supply-root.ts` 的 `describeSupplyRefRejection`：那句文案
 * 硬编码中文，`CONFIGS_LANG=en` 下会渲染出一句中英混排。这里按语言各自成句，而
 * **zh 侧的结果与 `describeSupplyRefRejection` 逐字相同**——`tests/integration/
 * cli-supply.test.ts` 有一条用例直接拿它做等值断言，所以两处措辞一旦漂移会当场红。
 * 「产出侧与解析侧对同一条引用说同一句话」这条性质因此保住了，只是不再靠共用一个
 * 硬编码字符串来保证。
 *
 * `SupplyRefRejection` 是闭合枚举，`Record` 写全才编译得过：将来加一条判定枝而
 * 忘了补文案，会在这里编译失败，而不是在用户面前退化成一个原始 key。
 */
const SUPPLY_REF_REJECTION_KEYS: Record<SupplyRefRejection, TranslationKey> = {
  为空: 'supplyRef.why.empty',
  含反斜杠: 'supplyRef.why.backslash',
  带盘符前缀: 'supplyRef.why.driveLetter',
  是绝对路径: 'supplyRef.why.absolute',
  解析后未落在供给根之内: 'supplyRef.why.outsideRoot',
};

function formatSupplyRefRejection(value: string, supplyRoot: string, why: SupplyRefRejection): string {
  return t('supplyRef.rejection', { why: t(SUPPLY_REF_REJECTION_KEYS[why]), value, supplyRoot });
}

function assertNeverErrorKind(kind: never): never {
  throw new Error(`unhandled QueryOrEstablishError kind: ${String(kind)}`);
}

function formatErrorReason(error: QueryOrEstablishError): string {
  switch (error.kind) {
    case 'config-not-found':
      return t('queryFailure.notFound');
    case 'config-unsupported':
      return t('queryFailure.unsupported', { reason: error.reason });
    case 'invalid-trigger-category':
      return t('establish.missingTriggerCategory');
    case 'missing-evidence':
      return t('establish.missingEvidence');
    case 'no-candidate-source':
      return t('establish.noCandidateSource');
    case 'invalid-candidate':
      return t('establish.invalidCandidate', { reason: error.reason });
    case 'missing-supersedes':
      return t('revise.missingSupersedes');
    case 'supersedes-not-found':
      return t('revise.supersedesNotFound', { revisionId: error.revisionId });
    case 'supersedes-config-mismatch':
      return t('revise.supersedesConfigMismatch', {
        revisionId: error.revisionId,
        expected: error.expectedConfigName,
        actual: error.actualConfigName,
      });
    case 'supersedes-conflict':
      return t('revise.supersedesConflict', { revisionId: error.revisionId });
    case 'supply-root-not-found':
      return t('supply.rootNotFound', { supplyRoot: error.supplyRoot });
    case 'supply-group-not-found':
      return t('supply.groupNotFound', { group: error.group, supplyRoot: error.supplyRoot });
    case 'supply-group-empty':
      return t('supply.groupEmpty', { group: error.group, supplyRoot: error.supplyRoot });
    case 'supply-ref-invalid':
      return t('supply.refInvalid', { reason: formatSupplyRefRejection(error.value, error.supplyRoot, error.why) });
    case 'supply-duplicate-group':
      return t('supply.duplicateGroup', {
        group: error.groupRef,
        first: error.firstDeclared,
        second: error.secondDeclared,
      });
    case 'supply-duplicate-skill-name':
      return t('supply.duplicateSkillName', {
        skill: error.skillName,
        first: error.firstSourceRef,
        second: error.secondSourceRef,
      });
    case 'supply-source-unreadable':
      return t('supply.sourceUnreadable', { where: error.where, supplyRoot: error.supplyRoot, reason: error.reason });
    case 'supply-unsupported-entry':
      return t('supply.unsupportedEntry', {
        sourceRef: error.sourceRef,
        entryPath: error.entryPath,
        entryKind: error.entryKind,
      });
    default:
      return assertNeverErrorKind(error);
  }
}

/**
 * Shared failure rendering for every typed rejection in this CLI: a label
 * + typed reason + recovery entry.
 *
 * `[Story 3.5 / P10]` 标签的来历按命令而不同，此前这段文档串只列了
 * `show`/`compare`/`establish`，漏了 `revise` 也漏了 `supply`，现补全：
 * - `show`/`compare`：修订 id；
 * - `establish`：候选解析成功后用它的 `configName`，在那之前用固定的 `'establish'`；
 * - `revise`：同上，固定回落值是 `'revise'`；
 * - `supply`：**恒为**固定的 `'supply'`。它没有「解析成功后换成 configName」这一
 *   步，而且刻意不用 `--config-name` 的值——供给库根不存在之类的失败与任何一份配置
 *   都无关（那份配置甚至还不存在），拿它当标签会渲染出「配置 "general"：供给库根
 *   …… 不存在」这种误报主体的句子。
 */
export function renderQueryFailure(label: string, error: QueryOrEstablishError): string {
  return t('queryFailure.prefix', { revisionId: label, reason: formatErrorReason(error) });
}

/**
 * `[Story 3.1]` The one-line success prefix printed before `configs
 * establish` reuses `renderDetail` for the new revision's detail block --
 * the same view `configs show <new id>` would render.
 */
export function renderEstablishSuccess(revision: StableConfigRevision): string {
  return [t('establish.successPrefix'), renderDetail(revision)].join('\n');
}

/**
 * `[Story 3.2]` Same shape as `renderEstablishSuccess` (reuses
 * `renderDetail` verbatim -- no "替代自：" line yet, that's Story 3.3's
 * `renderDetail` change), just a different success prefix so `revise`'s
 * output is distinguishable from `establish`'s.
 */
export function renderReviseSuccess(revision: StableConfigRevision): string {
  return [t('revise.successPrefix'), renderDetail(revision)].join('\n');
}

/**
 * `[Story 3.3]` Renders a chain direction (`predecessors`/`successors`) as
 * a single comma-joined line: the resolved links in their given order,
 * followed by an "unresolvable" marker naming the dangling id if that
 * direction's traversal stopped on one (Boundaries & Constraints: a
 * dangling `supersedesRevisionId` never aborts rendering -- it is reported
 * inline and the rest of the output is unaffected). An empty direction
 * with no dangling id renders the explicit "(none)" text -- AD-8: never
 * silently omit the line.
 */
function formatChainDirection(links: readonly SupersedesLink[], danglingId: string | null): string {
  const entries = links.map((link) => link.revisionId);
  if (danglingId !== null) {
    entries.push(t('detail.chainUnresolvable', { revisionId: danglingId }));
  }
  return entries.length > 0 ? entries.join(', ') : t('detail.chainNone');
}

/**
 * `[Story 3.3]` Deliberately independent of `renderDetail` (Boundaries &
 * Constraints) rather than folded into it: `configs show` calls it as a
 * second, separate append after `renderDetail`'s output, and the
 * concurrently-developed Story 3.2 (`configs revise`, which will produce
 * non-null `supersedesRevisionId`s) is expected to reuse this same
 * function verbatim in its own success output instead of reimplementing
 * chain rendering.
 */
export function renderSupersedesChainSection(chain: SupersedesChain): string {
  return [
    `${t('detail.supersededFrom')} ${formatChainDirection(chain.predecessors, chain.danglingPredecessorId)}`,
    `${t('detail.supersededBy')} ${formatChainDirection(chain.successors, chain.danglingSuccessorId)}`,
  ].join('\n');
}

function formatScalarField(field: ScalarFieldComparison): string {
  const header = `${field.field} [${field.status}]`;
  const rows = field.entries.map((entry) => `    ${entry.revisionId}: ${formatFact(entry.value)}`);
  return [header, ...rows].join('\n');
}

/**
 * When a capability's source category is `different`/`unknown` across the
 * compared revisions, print which revision has which value -- the
 * aggregate status alone ("different") does not say what the difference
 * actually is.
 */
function formatSourceCategoryBreakdown(entry: CapabilityComparisonEntry): string[] {
  if (entry.sourceCategoryStatus === 'same') {
    return [];
  }
  return entry.sourceCategoryByRevision
    .filter((byRevision) => byRevision.sourceCategory !== null)
    .map((byRevision) => `      ${byRevision.revisionId}: ${formatFact(byRevision.sourceCategory!)}`);
}

function formatCapabilityGroupComparison(group: CapabilityGroupComparison): string {
  const label = capabilityGroupLabel(group.kind);
  if (group.entries.length === 0) {
    return `${label} ${t('capabilityGroup.emptyCompare')}`;
  }
  const rows = group.entries.flatMap((entry) => {
    const missing = entry.missingIn.length > 0 ? ` ${t('comparison.missingIn', { ids: entry.missingIn.join(', ') })}` : '';
    return [`    - ${entry.name} [${t('capabilityRef.source')}: ${entry.sourceCategoryStatus}]${missing}`, ...formatSourceCategoryBreakdown(entry)];
  });
  return [label, ...rows].join('\n');
}

export function renderComparison(result: ComparisonResult): string {
  const lines = [
    t('comparison.header', { count: result.revisionIds.length, ids: result.revisionIds.join(', ') }),
    '',
    ...result.scalarFields.map(formatScalarField),
    '',
    ...result.capabilities.map(formatCapabilityGroupComparison),
  ];
  return lines.join('\n');
}

export function renderCompareResult(result: CompareConfigRevisionsResult): string {
  const sections: string[] = [];

  if (result.comparison !== null) {
    sections.push(renderComparison(result.comparison));
  } else {
    sections.push(t('comparison.noValid'));
  }

  if (result.failed.length > 0) {
    sections.push('');
    sections.push(t('comparison.unresolvedTitle'));
    for (const failure of result.failed) {
      sections.push(`  ${renderQueryFailure(failure.revisionId, failure.error)}`);
    }
  }

  return sections.join('\n');
}

/**
 * MVP-FR5: the one-time confirmation summary shown before a launch plan is
 * confirmed. Shows configuration name/revision, the client, the client's
 * OMP version (a `Fact` -- may be `Unknown`), the Instructions/Skills/MCP
 * that will be enabled, any known differences/degradations, and any
 * `-- <args>` that will be forwarded verbatim to the real `omp` invocation
 * -- so the user sees exactly what will be appended *before* they confirm,
 * not just after. Forwarded args are echoed opaquely (never parsed or
 * classified, per Boundaries & Constraints) -- nothing about tasks/
 * prompts/conversation content is shown beyond the raw tokens themselves.
 *
 * `[DELTA]` DESIGN.md `{components.confirmation-summary}`: the "Known
 * differences" title is colored `attention`; the closing one-time-
 * confirmation sentence is `dim`; everything else stays neutral.
 */
export function renderConfirmationSummary(
  plan: LaunchPlan,
  revision: StableConfigRevision,
  clientVersion: Fact<string>,
  knownDifferences: readonly string[],
  forwardedArgs: readonly string[],
): string {
  const lines = [
    t('confirmation.lead', { configName: revision.configName, revisionId: revision.revisionId }),
    t('confirmation.client', { client: plan.client, version: formatFact(clientVersion) }),
    '',
    formatCapabilityGroup('instruction', revision.instructions),
    formatCapabilityGroup('skill', revision.skills),
    formatCapabilityGroup('mcp', revision.mcp),
  ];
  if (knownDifferences.length > 0) {
    lines.push('', attention(t('confirmation.knownDifferencesTitle')));
    for (const reason of knownDifferences) {
      lines.push(`  - ${reason}`);
    }
  }
  if (forwardedArgs.length > 0) {
    lines.push('', t('confirmation.forwardedTitle'), `  ${forwardedArgs.join(' ')}`);
  }
  lines.push('', dim(t('confirmation.closing')));
  return lines.join('\n');
}

/**
 * MVP-FR6: launch status view. Only revision/client/version/phase/apply
 * result/known differences -- never task goals, conversation, tool calls,
 * task progress or results (Boundaries & Constraints).
 *
 * `[DELTA]` DESIGN.md `{components.status-line}`: only the phase *value*
 * is colored, and only once the phase has settled (`colorForPhase` returns
 * the text unwrapped for the in-flight phases).
 */
export function renderLaunchStatus(status: LaunchStatus): string {
  const lines = [
    t('launchStatus.revision', { revisionId: status.revisionId }),
    t('launchStatus.client', { client: status.client }),
    t('launchStatus.clientVersion', { version: formatFact(status.clientVersion) }),
    t('launchStatus.phase', { phase: colorForPhase(status.phase, status.phase) }),
    t('launchStatus.applyResult', { result: formatFact(status.applyResult) }),
  ];
  if (status.knownDifferences.length > 0) {
    lines.push(t('launchStatus.knownDifferencesTitle'));
    for (const reason of status.knownDifferences) {
      lines.push(`  - ${reason}`);
    }
  } else {
    lines.push(t('launchStatus.knownDifferencesNone'));
  }
  return lines.join('\n');
}

/** MVP-FR10: immediate, typed "not supported yet" response -- no placeholder, translation or shim. */
export function renderUnsupportedClient(clientId: string, reason: string): string {
  return t('unsupportedClient', { clientId, reason });
}

/**
 * Shared failure/terminal-with-reason rendering for a launch plan --
 * covers both `cancelled` (user rejected the confirmation) and any other
 * failure phase (`failed`/`incomplete`). Never fabricates success and
 * never hides which phase the plan stopped in.
 *
 * `[DELTA]` DESIGN.md `{components.failure-block}`: the first sentence is
 * colored per `colorForPhase` (`failed`/`incomplete` -> failure red,
 * `cancelled` -> attention yellow -- the user's own choice, not a fault);
 * "Phase:"/"Reason:" stay neutral; "Recovery:" is `dim`.
 */
export function renderLaunchFailure(plan: LaunchPlan): string {
  const reason = isKnown(plan.failureReason) ? plan.failureReason.value : formatFact(plan.failureReason);

  if (plan.phase === 'cancelled') {
    const lead = colorForPhase(plan.phase, t('failure.cancelled', { planId: plan.planId, reason }));
    return [lead, t('failure.notStarted')].join('\n');
  }

  // `incomplete` is a domain-distinct terminal state from `failed`
  // (`deriveOutcome` in `application/launch.ts`: the OMP process ended
  // without a determinable exit code, e.g. killed by a signal) -- it must
  // not be reported with the same "failed" wording as an actual non-zero
  // exit.
  const leadingText = plan.phase === 'incomplete' ? t('failure.incomplete', { planId: plan.planId }) : t('failure.failed', { planId: plan.planId });

  return [
    colorForPhase(plan.phase, leadingText),
    t('failure.phase', { phase: plan.phase }),
    t('failure.reason', { reason }),
    dim(t('failure.recovery', { revisionId: plan.revisionId })),
  ].join('\n');
}

/**
 * MVP-FR8: switching never hot-reloads the current process -- it requires a
 * restart and a fresh confirmation.
 *
 * `[DELTA]` DESIGN.md `{components.switch-accepted-block}`: the "requires a
 * restart" sentence is colored `attention`; the rest stays neutral.
 */
export function renderSwitchAccepted(previousPlan: LaunchPlan, newPlan: LaunchPlan): string {
  return [
    attention(t('switchAccepted.requiresRestart', { previousPlanId: previousPlan.planId })),
    t('switchAccepted.newPlan', { planId: newPlan.planId, revisionId: newPlan.revisionId }),
    t('switchAccepted.noAutoResume'),
  ].join('\n');
}

/**
 * `[DELTA]` New in this Story: the terminal-handoff line (DESIGN.md
 * `{components.handoff-line}`). Printed exactly once, by both interfaces,
 * immediately after confirmation and immediately before `omp` takes over
 * stdio -- always `dim`, never anything else.
 */
export function renderHandoffLine(): string {
  return dim(t('handoffLine'));
}
