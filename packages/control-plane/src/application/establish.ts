/**
 * Story 3.1: application-layer validation for `configs establish`. Two
 * concerns live here, both fail-closed (never a partial/silent result):
 *
 * 1. `parseTriggerCategory`/`parseEvidenceRef` -- validate the two flags
 *    that must be checked *before* any candidate is read (see
 *    Boundaries & Constraints: this ordering exists so a missing flag
 *    never leaves a non-interactive invocation blocked on a stdin read).
 * 2. `parseCandidateRevision` -- validates the untrusted candidate JSON
 *    (from `--from <path>` or stdin) field by field. A field that is
 *    entirely *absent* degrades to `Unknown` (AD-8's "never fabricate,
 *    never crash on absence" convention, applied here to freshly-authored
 *    candidates the same way `adapters/sqlite/repository.ts` already
 *    applies it to previously-stored rows); a field that *is present* but
 *    does not match its declared type fails the whole candidate (Boundaries
 *    & Constraints: "候选字段类型不符...类型不符零写入，不静默接受").
 *
 * Both `ConfigRevisionWriter.create()` (the adapter) and `cli/index.ts`
 * call into this file rather than duplicating validation logic.
 */

import { known, unknown } from '../domain/facts';
import type { Fact } from '../domain/facts';
import type { CapabilityKind, CapabilityReference, SourceCategory, TriggerCategory } from '../domain/config';
import {
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
} from './ports';

// Re-exported so `cli/index.ts` and tests can import every establish-time
// concern (validation + the errors it throws) from this one module,
// without needing to know the errors themselves live in `ports.ts`
// (alongside `ConfigRevisionWriter`, the other application-layer port).
export {
  InvalidCandidateError,
  InvalidTriggerCategoryError,
  MissingEvidenceError,
  MissingSupersedesError,
  NoCandidateSourceError,
  SupersedesConfigMismatchError,
  SupersedesConflictError,
  SupersedesNotFoundError,
  // `[Story 3.5]` `configs supply` 的 fail-closed 拒绝走同一条再导出路径
  // ——调用点只认这一个模块，不必知道错误本体住在 `ports.ts`。
  SupplyDuplicateGroupError,
  SupplyDuplicateSkillNameError,
  SupplyGroupEmptyError,
  SupplyGroupNotFoundError,
  SupplyRefInvalidError,
  SupplyRootNotFoundError,
  SupplySourceUnreadableError,
  SupplyUnsupportedEntryError,
};

export const TRIGGER_CATEGORIES: readonly TriggerCategory[] = ['new-scenario', 'known-insufficiency', 'bad-case'];

const SOURCE_CATEGORIES: readonly SourceCategory[] = [
  'project-capability',
  'project-skill-import',
  'project-prompt',
  'unknown-source',
];

export function parseTriggerCategory(raw: string | undefined): TriggerCategory {
  if (raw === undefined || !(TRIGGER_CATEGORIES as readonly string[]).includes(raw)) {
    throw new InvalidTriggerCategoryError(raw);
  }
  return raw as TriggerCategory;
}

export function parseEvidenceRef(raw: string | undefined): string {
  if (raw === undefined || raw.trim().length === 0) {
    throw new MissingEvidenceError();
  }
  return raw;
}

/**
 * `[Story 3.2]` `configs revise`'s `--supersedes <revisionId>` -- trimmed,
 * then required non-empty (same shape as `parseEvidenceRef`). Only
 * validates presence/non-emptiness here; whether the id actually resolves
 * to an existing revision (and whether its `configName` matches the
 * candidate) is checked separately, against the repository, before any
 * write is attempted (see `cli/index.ts`'s `runRevise`).
 */
export function parseSupersedesRevisionId(raw: string | undefined): string {
  if (raw === undefined || raw.trim().length === 0) {
    throw new MissingSupersedesError();
  }
  return raw.trim();
}

function fail(reason: string): never {
  throw new InvalidCandidateError(reason);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const MISSING_FIELD_OBSERVED_AT = new Date(0).toISOString();

/**
 * Parses one `Fact<T>`-shaped candidate field. Absent (`undefined`)
 * degrades to `Unknown` rather than failing the whole candidate; present
 * but wrong-shaped/wrong-typed fails the whole candidate (zero writes).
 */
function parseFact<T>(
  raw: unknown,
  fieldPath: string,
  validateKnownValue: (value: unknown) => boolean,
  expectedTypeLabel: string,
): Fact<T> {
  if (raw === undefined) {
    return unknown(`not-provided: ${fieldPath}`, MISSING_FIELD_OBSERVED_AT);
  }
  if (!isPlainObject(raw)) {
    fail(`${fieldPath} must be a Fact object ({"kind":"known","value":...} or {"kind":"unknown","reason":...,"observedAt":...})`);
  }
  const factObj = raw as Record<string, unknown>;
  if (factObj.kind !== 'known' && factObj.kind !== 'unknown') {
    fail(`${fieldPath}.kind must be "known" or "unknown"`);
  }
  if (factObj.kind === 'unknown') {
    // `[Review fix]` Mirrors the `known` branch below: a field that is
    // *absent* degrades to the default (AD-8), but a field that *is
    // present* with the wrong type fails the whole candidate -- it must
    // never be silently overwritten with a fabricated default.
    if (factObj.reason !== undefined && typeof factObj.reason !== 'string') {
      fail(`${fieldPath}.reason must be a string`);
    }
    if (factObj.observedAt !== undefined && typeof factObj.observedAt !== 'string') {
      fail(`${fieldPath}.observedAt must be a string`);
    }
    const reason = typeof factObj.reason === 'string' ? factObj.reason : 'unspecified';
    const observedAt = typeof factObj.observedAt === 'string' ? factObj.observedAt : MISSING_FIELD_OBSERVED_AT;
    return unknown(reason, observedAt);
  }
  if (!validateKnownValue(factObj.value)) {
    fail(`${fieldPath}.value must be ${expectedTypeLabel}`);
  }
  return known(factObj.value as T);
}

const isBoolean = (value: unknown): boolean => typeof value === 'boolean';
const isString = (value: unknown): boolean => typeof value === 'string';
const isResolvedLiteral = (value: unknown): boolean => value === 'resolved';
const isSourceCategory = (value: unknown): boolean =>
  typeof value === 'string' && (SOURCE_CATEGORIES as readonly string[]).includes(value);

function parseCapabilityReference(raw: unknown, expectedKind: CapabilityKind, fieldPath: string): CapabilityReference {
  if (!isPlainObject(raw)) {
    fail(`${fieldPath} must be an object`);
  }
  const entry = raw as Record<string, unknown>;
  if (entry.kind !== expectedKind) {
    fail(`${fieldPath}.kind must be "${expectedKind}"`);
  }
  if (typeof entry.name !== 'string' || entry.name.trim().length === 0) {
    fail(`${fieldPath}.name must be a non-empty string`);
  }
  return {
    kind: expectedKind,
    name: entry.name,
    sourceCategory: parseFact<SourceCategory>(entry.sourceCategory, `${fieldPath}.sourceCategory`, isSourceCategory, `one of ${SOURCE_CATEGORIES.join(', ')}`),
    summary: parseFact<string>(entry.summary, `${fieldPath}.summary`, isString, 'a string'),
    sourceRef: parseFact<string>(entry.sourceRef, `${fieldPath}.sourceRef`, isString, 'a string'),
    contentFingerprint: parseFact<string>(entry.contentFingerprint, `${fieldPath}.contentFingerprint`, isString, 'a string'),
  };
}

function parseCapabilityArray(raw: unknown, expectedKind: CapabilityKind, fieldPath: string): CapabilityReference[] {
  if (raw === undefined) {
    return [];
  }
  if (!Array.isArray(raw)) {
    fail(`${fieldPath} must be an array`);
  }
  return raw.map((entry, index) => parseCapabilityReference(entry, expectedKind, `${fieldPath}[${index}]`));
}

/** The candidate's shape once every field has been validated -- everything `ConfigRevisionWriter.create` needs except the flag-supplied trigger/evidence and the internally-generated id. */
export interface CandidateConfigRevision {
  readonly configName: string;
  readonly defaultMarker: Fact<boolean>;
  readonly scopeBoundary: Fact<string>;
  readonly availability: Fact<'resolved'>;
  readonly instructions: readonly CapabilityReference[];
  readonly skills: readonly CapabilityReference[];
  readonly mcp: readonly CapabilityReference[];
  readonly hooks: readonly CapabilityReference[];
  readonly plugins: readonly CapabilityReference[];
}

/**
 * Validates a raw, untrusted, already-JSON-parsed candidate value.
 * Throws `InvalidCandidateError` on the first mismatch (shape, missing
 * `configName`, or a `known` Fact whose `value` doesn't match its
 * declared type) -- never silently accepts or coerces.
 */
export function parseCandidateRevision(raw: unknown): CandidateConfigRevision {
  if (!isPlainObject(raw)) {
    fail('candidate must be a JSON object');
  }
  const obj = raw as Record<string, unknown>;
  // `[Review fix]` Trim *before* validating non-emptiness and before using
  // the value -- otherwise `"foo"` and `"foo "` (or `" "`, which would
  // wrongly pass the untrimmed non-empty check) are treated as two
  // different `configName`s, each getting its own `stable_config` row.
  const trimmedConfigName = typeof obj.configName === 'string' ? obj.configName.trim() : undefined;
  if (trimmedConfigName === undefined || trimmedConfigName.length === 0) {
    fail('configName must be a non-empty string');
  }

  return {
    configName: trimmedConfigName,
    defaultMarker: parseFact<boolean>(obj.defaultMarker, 'defaultMarker', isBoolean, 'a boolean'),
    scopeBoundary: parseFact<string>(obj.scopeBoundary, 'scopeBoundary', isString, 'a string'),
    availability: parseFact<'resolved'>(obj.availability, 'availability', isResolvedLiteral, '"resolved"'),
    instructions: parseCapabilityArray(obj.instructions, 'instruction', 'instructions'),
    skills: parseCapabilityArray(obj.skills, 'skill', 'skills'),
    mcp: parseCapabilityArray(obj.mcp, 'mcp', 'mcp'),
    hooks: parseCapabilityArray(obj.hooks, 'hook', 'hooks'),
    plugins: parseCapabilityArray(obj.plugins, 'plugin', 'plugins'),
  };
}
