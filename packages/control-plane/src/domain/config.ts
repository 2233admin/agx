/**
 * `domain/` must not import Bun, SQLite, the filesystem, or the process
 * environment. Only pure types and functions live here.
 */

import { type Fact, factsEqual, isUnknown, known } from './facts';

/**
 * The three capability groups required by MVP-FR2. `hook` and `plugin` are
 * carried too (Design Notes: hooks/plugins are out of AC scope but, when
 * present, must not be dropped -- they are surfaced as sibling groupings
 * alongside Skills rather than folded into it).
 */
export type CapabilityKind = 'instruction' | 'skill' | 'mcp' | 'hook' | 'plugin';

/**
 * Where a capability reference is provably sourced from. Never inferred
 * from "file exists" / "installed" -- only from declarations this Story is
 * allowed to read (see Design Notes field mapping).
 */
export type SourceCategory =
  | 'project-capability'
  | 'project-skill-import'
  | 'project-prompt'
  | 'unknown-source';

/**
 * A typed reference to one Instruction/Skill/MCP/Hook/Plugin. Only the
 * identifier, its source category and an allowed-public summary are ever
 * carried -- never private prompt text, credentials, transcripts or tool
 * payloads.
 *
 * `[Story 3.1]` `sourceRef`/`contentFingerprint` are additional Facts of the
 * same shape as `sourceCategory`/`summary` (never a bare value -- always
 * `Known`/`Unknown`); they carry a stronger provenance pointer and a
 * fingerprint of the referenced content, not the content itself. There is
 * deliberately no `evidenceRef` sibling field here -- the trigger/evidence
 * pair for *why a revision was established* lives once on
 * `StableConfigRevision`, not per capability reference.
 */
export interface CapabilityReference {
  readonly kind: CapabilityKind;
  readonly name: string;
  readonly sourceCategory: Fact<SourceCategory>;
  readonly summary: Fact<string>;
  /**
   * `[Story 3.4]` 当它是 `Known` 时，值是一条**库内相对 POSIX 路径**——只能是
   * 这一种。绝不是绝对路径，绝不含反斜杠，绝不带盘符前缀，也绝不是
   * `''`/`'.'`/`..` 这类逃逸形态。位置中属于本机的那一半是供给根
   * （`cli/supply-root.ts` 中全仓共用的 `defaultSupplyRoot()`，可用
   * `CONTROL_PLANE_SUPPLY_ROOT` 覆盖），它刻意永不进入修订：正因如此，一条修订
   * 才能在另一台以不同绝对路径复现了同样第三方字节的机器上被物化（AD-22）。规则
   * 只活在一个地方，即 `cli/supply-root.ts` 的 `validateSupplyRelativeRef`；解析侧
   * （`adapters/clients/claude/content-materializer.ts`）对违反者 fail-closed
   * （AD-10），产出侧则用同一个谓词当场自检，而不是产出一个注定稍后被拒的形态。
   */
  readonly sourceRef: Fact<string>;
  readonly contentFingerprint: Fact<string>;
}

/**
 * `[Story 3.1]` The three trigger categories a new configuration revision
 * can be established from (AD-16/AD-21). Closed enum -- never extended
 * ad hoc; a value outside this set is rejected before anything is
 * persisted (see `application/establish.ts`).
 */
export type TriggerCategory = 'new-scenario' | 'known-insufficiency' | 'bad-case';

/**
 * Whether this revision's configuration could be mechanically resolved
 * against its lock data. `'resolved'` is the only known value; anything
 * else must be represented as `Unknown(reason, observedAt)`.
 */
export type ConfigAvailability = Fact<'resolved'>;

/**
 * An immutable, fully-identified configuration revision. Comparisons,
 * detail views and list rows are always bound to a specific revision --
 * nothing here is mutated in place.
 */
export interface StableConfigRevision {
  readonly configName: string;
  readonly revisionId: string;
  readonly defaultMarker: Fact<boolean>;
  readonly scopeBoundary: Fact<string>;
  readonly availability: ConfigAvailability;
  readonly instructions: readonly CapabilityReference[];
  readonly skills: readonly CapabilityReference[];
  readonly mcp: readonly CapabilityReference[];
  readonly hooks: readonly CapabilityReference[];
  readonly plugins: readonly CapabilityReference[];
  /**
   * `[Story 3.1]` Persisted, not just validated-and-discarded (AD-16/
   * AD-21): the trigger category and evidence reference this revision was
   * established from. Always a plain, always-known value -- never a
   * `Fact` -- because `configs establish` refuses to persist anything
   * (zero writes) unless both were already validated non-empty/in-enum
   * before the write; there is no "this revision exists but its trigger is
   * Unknown" state to represent.
   */
  readonly triggerCategory: TriggerCategory;
  readonly evidenceRef: string;
  /**
   * `[Story 3.1]`/`[Story 3.2]` The revision this one replaces, or `null`
   * if it has no predecessor. `configs establish` always writes `null`
   * (it never replaces an existing revision); `configs revise` writes the
   * `--supersedes <revisionId>` target once it has been validated to exist
   * and share the same `configName` (`application/establish.ts`'s
   * `parseSupersedesRevisionId` + `cli/index.ts`'s `runRevise`). Plain
   * nullable id, not a `Fact`: "no predecessor" is a real, known
   * structural fact, not an unresolved one. A given revision id can be the
   * `supersedesRevisionId` of at most one other revision -- enforced by
   * `idx_stable_config_revision_supersedes_revision_id`, translated to
   * `SupersedesConflictError` on conflict.
   */
  readonly supersedesRevisionId: string | null;
}

export type ScalarFieldName =
  | 'configName'
  | 'revisionId'
  | 'defaultMarker'
  | 'scopeBoundary'
  | 'availability';

export type ComparisonStatus = 'same' | 'different' | 'unknown';

export interface ScalarFieldEntry {
  readonly revisionId: string;
  readonly value: Fact<string | boolean>;
}

/** One field, laid out side by side across every compared revision. */
export interface ScalarFieldComparison {
  readonly field: ScalarFieldName;
  readonly entries: readonly ScalarFieldEntry[];
  readonly status: ComparisonStatus;
}

export interface CapabilitySourceEntry {
  readonly revisionId: string;
  /** `null` when the capability is absent from this revision. */
  readonly sourceCategory: Fact<SourceCategory> | null;
}

export interface CapabilityComparisonEntry {
  readonly name: string;
  readonly presentIn: readonly string[];
  readonly missingIn: readonly string[];
  readonly sourceCategoryStatus: ComparisonStatus;
  readonly sourceCategoryByRevision: readonly CapabilitySourceEntry[];
}

/** Mechanical composition/source comparison for one capability kind. */
export interface CapabilityGroupComparison {
  readonly kind: CapabilityKind;
  readonly entries: readonly CapabilityComparisonEntry[];
}

/**
 * Pure, mechanical side-by-side comparison. Never produces a score,
 * ranking, recommendation or automatic candidate -- only same/different/
 * unknown per field, and presence/absence per capability.
 */
export interface ComparisonResult {
  readonly revisionIds: readonly string[];
  readonly scalarFields: readonly ScalarFieldComparison[];
  readonly capabilities: readonly CapabilityGroupComparison[];
}

/**
 * `[Story 3.3]` One step in a supersede chain -- deliberately a struct
 * (not a bare `string`) so a future caller can attach more per-step data
 * (e.g. `configName`) without changing `SupersedesChain`'s shape, matching
 * this file's existing convention of wrapping a `revisionId` in a typed
 * entry (`ScalarFieldEntry`, `CapabilitySourceEntry`) rather than passing
 * ids around unadorned.
 */
export interface SupersedesLink {
  readonly revisionId: string;
}

/**
 * `[Story 3.3]` The bidirectional supersede chain for one revision, built
 * from an already-loaded revision set (see `buildSupersedesChain`).
 * `predecessors` is ordered oldest -> newest (the revision this one most
 * directly supersedes comes last); `successors` is ordered nearest ->
 * farthest (the revision that most directly supersedes this one comes
 * first). Neither array includes the queried revision itself.
 *
 * `danglingPredecessorId`/`danglingSuccessorId` hold the id traversal
 * could not resolve within `revisions` (AD-8: never thrown as an error --
 * that direction's traversal simply stops there); `null` means that
 * direction's traversal completed cleanly (reached a revision whose
 * `supersedesRevisionId` is `null`, found no successor, or the chain is
 * empty).
 */
export interface SupersedesChain {
  readonly revisionId: string;
  readonly predecessors: readonly SupersedesLink[];
  readonly successors: readonly SupersedesLink[];
  readonly danglingPredecessorId: string | null;
  readonly danglingSuccessorId: string | null;
}

/**
 * `[Story 3.3]` Pure, zero-IO bidirectional traversal of `supersedesRevisionId`
 * pointers over an already-loaded revision set -- mirrors this file's
 * `compareRevisions` convention (pure function; `application/queries.ts`'s
 * `getSupersedesChain` is the IO-fetching wrapper around it).
 *
 * Predecessor traversal walks `current.supersedesRevisionId` backwards.
 * Successor traversal walks a reverse index (`supersedesRevisionId ->
 * revisionId`) forward -- the unique index on `supersedes_revision_id`
 * (Story 3.1 migration) means this direction has at most one edge per
 * revision in healthy data, so no fan-out/branching handling is needed
 * (see Design Notes).
 *
 * Both directions carry a `visited` set: if a pointer would revisit an id
 * already walked in that direction, traversal stops immediately instead of
 * looping forever on cyclic data. A pointer to an id absent from
 * `revisions` stops that direction's traversal and records the missing id
 * in `danglingPredecessorId`/`danglingSuccessorId` -- it never throws, and
 * never affects the other direction or any other revision's traversal.
 */
export function buildSupersedesChain(revisions: readonly StableConfigRevision[], revisionId: string): SupersedesChain {
  const byId = new Map(revisions.map((revision) => [revision.revisionId, revision]));

  // Reverse index: `supersedesRevisionId -> revisionId` of the revision
  // that supersedes it. Built from the loaded set itself, so a value found
  // here always corresponds to a revision actually present in `revisions`.
  const successorOf = new Map<string, string>();
  for (const revision of revisions) {
    if (revision.supersedesRevisionId !== null) {
      successorOf.set(revision.supersedesRevisionId, revision.revisionId);
    }
  }

  const predecessors: SupersedesLink[] = [];
  let danglingPredecessorId: string | null = null;
  {
    const visited = new Set<string>([revisionId]);
    let current = byId.get(revisionId) ?? null;
    while (current !== null && current.supersedesRevisionId !== null) {
      const nextId = current.supersedesRevisionId;
      if (visited.has(nextId)) {
        break; // cycle -- stop rather than loop forever
      }
      const next = byId.get(nextId);
      if (next === undefined) {
        danglingPredecessorId = nextId;
        break;
      }
      // Walking backwards but presenting oldest -> newest: prepend.
      predecessors.unshift({ revisionId: nextId });
      visited.add(nextId);
      current = next;
    }
  }

  const successors: SupersedesLink[] = [];
  let danglingSuccessorId: string | null = null;
  {
    const visited = new Set<string>([revisionId]);
    let currentId = revisionId;
    for (;;) {
      const nextId = successorOf.get(currentId);
      if (nextId === undefined) {
        break; // no revision supersedes `currentId`
      }
      if (visited.has(nextId)) {
        break; // cycle -- stop rather than loop forever
      }
      const next = byId.get(nextId);
      if (next === undefined) {
        // Defensive only -- `successorOf`'s values come from `revisions`
        // itself, so this should be unreachable in practice.
        danglingSuccessorId = nextId;
        break;
      }
      successors.push({ revisionId: nextId });
      visited.add(nextId);
      currentId = nextId;
    }
  }

  return { revisionId, predecessors, successors, danglingPredecessorId, danglingSuccessorId };
}

const CAPABILITY_KINDS: readonly CapabilityKind[] = ['instruction', 'skill', 'mcp', 'hook', 'plugin'];

function scalarStatus(entries: readonly ScalarFieldEntry[]): ComparisonStatus {
  if (entries.some((entry) => isUnknown(entry.value))) {
    return 'unknown';
  }
  const first = entries[0];
  if (first === undefined) {
    return 'same';
  }
  const allEqual = entries.every((entry) => factsEqual(entry.value, first.value));
  return allEqual ? 'same' : 'different';
}

function compareScalarField(
  field: ScalarFieldName,
  revisions: readonly StableConfigRevision[],
  select: (revision: StableConfigRevision) => Fact<string | boolean>,
): ScalarFieldComparison {
  const entries = revisions.map((revision) => ({
    revisionId: revision.revisionId,
    value: select(revision),
  }));
  return { field, entries, status: scalarStatus(entries) };
}

function capabilitiesOfKind(
  revision: StableConfigRevision,
  kind: CapabilityKind,
): readonly CapabilityReference[] {
  switch (kind) {
    case 'instruction':
      return revision.instructions;
    case 'skill':
      return revision.skills;
    case 'mcp':
      return revision.mcp;
    case 'hook':
      return revision.hooks;
    case 'plugin':
      return revision.plugins;
    default:
      return [];
  }
}

function compareCapabilityGroup(
  kind: CapabilityKind,
  revisions: readonly StableConfigRevision[],
): CapabilityGroupComparison {
  const byRevision = revisions.map((revision) => ({
    revisionId: revision.revisionId,
    refs: new Map(capabilitiesOfKind(revision, kind).map((ref) => [ref.name, ref])),
  }));

  const allNames = new Set<string>();
  for (const { refs } of byRevision) {
    for (const name of refs.keys()) {
      allNames.add(name);
    }
  }

  const entries: CapabilityComparisonEntry[] = [...allNames].sort().map((name) => {
    const presentIn: string[] = [];
    const missingIn: string[] = [];
    const sourceCategoryByRevision: CapabilitySourceEntry[] = [];

    for (const { revisionId, refs } of byRevision) {
      const ref = refs.get(name);
      if (ref === undefined) {
        missingIn.push(revisionId);
        sourceCategoryByRevision.push({ revisionId, sourceCategory: null });
      } else {
        presentIn.push(revisionId);
        sourceCategoryByRevision.push({ revisionId, sourceCategory: ref.sourceCategory });
      }
    }

    const knownCategories = sourceCategoryByRevision
      .map((entry) => entry.sourceCategory)
      .filter((fact): fact is Fact<SourceCategory> => fact !== null);
    let sourceCategoryStatus: ComparisonStatus;
    if (knownCategories.some((fact) => isUnknown(fact))) {
      sourceCategoryStatus = 'unknown';
    } else if (knownCategories.length === 0) {
      sourceCategoryStatus = 'same';
    } else {
      const first = knownCategories[0]!;
      sourceCategoryStatus = knownCategories.every((fact) => factsEqual(fact, first)) ? 'same' : 'different';
    }

    return { name, presentIn, missingIn, sourceCategoryStatus, sourceCategoryByRevision };
  });

  return { kind, entries };
}

/**
 * Mechanically lays the same fields side by side for every revision.
 * `differences` = a field whose comparable values are not all equal.
 * `Unknown` on either side makes the whole field `unknown` -- it is never
 * guessed to be equal or different (Design Notes: 比较的"差异"定义).
 */
export function compareRevisions(revisions: readonly StableConfigRevision[]): ComparisonResult {
  const revisionIds = revisions.map((revision) => revision.revisionId);

  const scalarFields: ScalarFieldComparison[] = [
    compareScalarField('configName', revisions, (r) => known(r.configName)),
    compareScalarField('revisionId', revisions, (r) => known(r.revisionId)),
    compareScalarField('defaultMarker', revisions, (r) => r.defaultMarker),
    compareScalarField('scopeBoundary', revisions, (r) => r.scopeBoundary),
    compareScalarField('availability', revisions, (r) => r.availability),
  ];

  const capabilities = CAPABILITY_KINDS.map((kind) => compareCapabilityGroup(kind, revisions));

  return { revisionIds, scalarFields, capabilities };
}
