import { buildSupersedesChain, compareRevisions } from '../domain/config';
import type { ComparisonResult, StableConfigRevision, SupersedesChain } from '../domain/config';
import type { ConfigRevisionRepository } from './ports';

/** The requested configuration revision id does not exist in storage. */
export class ConfigNotFoundError extends Error {
  readonly kind = 'config-not-found' as const;

  constructor(readonly revisionId: string) {
    super(`configuration revision not found: ${revisionId}`);
    this.name = 'ConfigNotFoundError';
  }
}

/**
 * The requested configuration revision exists but could not be resolved
 * into a complete detail view -- unsupported schema version, an
 * unreachable reference, or a parse failure on stored data.
 */
export class ConfigUnsupportedError extends Error {
  readonly kind = 'config-unsupported' as const;

  constructor(
    readonly revisionId: string,
    readonly reason: string,
  ) {
    super(`configuration revision unsupported: ${revisionId} (${reason})`);
    this.name = 'ConfigUnsupportedError';
  }
}

export type ConfigQueryError = ConfigNotFoundError | ConfigUnsupportedError;

/** MVP-FR1: list every saved configuration revision, unfiltered. */
export async function listConfigRevisions(
  repository: ConfigRevisionRepository,
): Promise<readonly StableConfigRevision[]> {
  return repository.listAll();
}

/**
 * MVP-FR2: full detail view for one revision. Throws a typed
 * `ConfigNotFoundError`/`ConfigUnsupportedError` on failure -- never
 * silently falls back to a default configuration.
 */
export async function getConfigRevisionDetail(
  repository: ConfigRevisionRepository,
  revisionId: string,
): Promise<StableConfigRevision> {
  const revision = await repository.findById(revisionId);
  if (revision === null) {
    throw new ConfigNotFoundError(revisionId);
  }
  return revision;
}

/**
 * `[Story 3.3]` MVP-FR2 extension ("查看装配来源与替代链"): the bidirectional
 * supersede chain for one revision. Throws the same typed
 * `ConfigNotFoundError` as `getConfigRevisionDetail` when `revisionId`
 * itself does not exist -- `show`'s existing `isConfigQueryError`/
 * `renderQueryFailure` failure path handles it without change. The chain
 * traversal itself (`buildSupersedesChain`) never throws; a dangling
 * pointer within the chain is represented in the result, not as a thrown
 * error.
 */
export async function getSupersedesChain(repository: ConfigRevisionRepository, revisionId: string): Promise<SupersedesChain> {
  const revision = await repository.findById(revisionId);
  if (revision === null) {
    throw new ConfigNotFoundError(revisionId);
  }
  const allRevisions = await repository.listAll();
  return buildSupersedesChain(allRevisions, revisionId);
}

export interface CompareFailure {
  readonly revisionId: string;
  readonly error: ConfigQueryError;
}

export interface CompareConfigRevisionsResult {
  readonly resolved: readonly StableConfigRevision[];
  readonly failed: readonly CompareFailure[];
  /** `null` when fewer than one revision resolved -- nothing to lay out. */
  readonly comparison: ComparisonResult | null;
}

/**
 * MVP-FR3: mechanical side-by-side comparison of the requested ids.
 * Invalid/unresolvable ids never abort the whole comparison -- they are
 * collected into `failed` and reported alongside the resolved revisions.
 */
export async function compareConfigRevisions(
  repository: ConfigRevisionRepository,
  revisionIds: readonly string[],
): Promise<CompareConfigRevisionsResult> {
  const resolved: StableConfigRevision[] = [];
  const failed: CompareFailure[] = [];

  // Repeated ids are de-duplicated (first occurrence wins) before resolving
  // -- otherwise a repeated id would appear twice in the comparison output,
  // which is not a meaningful mechanical comparison of distinct revisions.
  const uniqueIds = [...new Set(revisionIds)];

  for (const revisionId of uniqueIds) {
    try {
      const revision = await repository.findById(revisionId);
      if (revision === null) {
        failed.push({ revisionId, error: new ConfigNotFoundError(revisionId) });
      } else {
        resolved.push(revision);
      }
    } catch (error) {
      if (error instanceof ConfigUnsupportedError) {
        failed.push({ revisionId, error });
      } else {
        throw error;
      }
    }
  }

  const comparison = resolved.length > 0 ? compareRevisions(resolved) : null;
  return { resolved, failed, comparison };
}
