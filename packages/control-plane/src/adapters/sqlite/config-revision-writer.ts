/**
 * `[Story 3.1]` Insert-only write adapter for `stable_config_revision`.
 * Deliberately its own class/file rather than a method bolted onto
 * `SqliteConfigRevisionRepository` -- that class implements the read-only
 * `ConfigRevisionRepository` port; this one implements the separate
 * `ConfigRevisionWriter` port and exposes only `create` (Boundaries &
 * Constraints: "写端口只暴露 create，无 update/delete；不复用
 * seed()/insertRawRow()").
 *
 * `create` validates the whole candidate (via `parseCandidateRevision`)
 * *before* ever touching the database -- a type mismatch anywhere in the
 * candidate throws `InvalidCandidateError` with zero writes, never a
 * partial insert.
 *
 * `[Story 3.2]` `create` also backs `configs revise` -- when
 * `params.supersedesRevisionId` is non-null, the insert transaction below
 * translates an `idx_stable_config_revision_supersedes_revision_id` unique
 * index conflict (the target was already superseded, including by a
 * concurrent writer) into a typed `SupersedesConflictError`; the raw
 * SQLite error never escapes.
 */

import { Database } from 'bun:sqlite';

import { parseCandidateRevision, parseEvidenceRef, parseSupersedesRevisionId, parseTriggerCategory } from '../../application/establish';
import { SupersedesConflictError } from '../../application/ports';
import type { EstablishConfigRevisionParams, ConfigRevisionWriter } from '../../application/ports';
import type { StableConfigRevision } from '../../domain/config';
import { runConfigRevisionMigrations } from './repository';
import { factColumns } from './fact-columns';
import { openSqliteDatabase } from './connection';

/**
 * `[Story 3.2]` The exact substring SQLite's error message contains when
 * `idx_stable_config_revision_supersedes_revision_id` rejects a duplicate
 * non-null `supersedes_revision_id` -- checked against `Error.message`
 * (`bun:sqlite` throws a plain `Error`, not a typed subclass) so this
 * adapter can translate it into `SupersedesConflictError` before it ever
 * reaches `cli/index.ts`.
 */
const SUPERSEDES_UNIQUE_CONSTRAINT_MESSAGE = 'UNIQUE constraint failed: stable_config_revision.supersedes_revision_id';

/** The only `stable_config_revision.schema_version` this writer ever produces. */
const SUPPORTED_SCHEMA_VERSION = 1;

export class SqliteConfigRevisionWriter implements ConfigRevisionWriter {
  private readonly db: Database;

  constructor(dbPath: string) {
    this.db = openSqliteDatabase(dbPath);
    runConfigRevisionMigrations(this.db);
  }

  async create(params: EstablishConfigRevisionParams): Promise<StableConfigRevision> {
    // `[Review fix]` `EstablishConfigRevisionParams.triggerCategory`/
    // `.evidenceRef` are typed, but TypeScript types are erased at runtime
    // -- a caller that reaches this port directly (bypassing
    // `cli/index.ts`'s `parseTriggerCategory`/`parseEvidenceRef` calls)
    // could still pass an out-of-enum category or empty evidence. Reuse
    // the exact same validators the CLI already uses, before the
    // transaction below (or the candidate parse) ever runs, so an invalid
    // value here fails with zero writes just like an invalid candidate.
    parseTriggerCategory(params.triggerCategory);
    parseEvidenceRef(params.evidenceRef);
    // `[Review fix]` `[Story 3.2]` Same reasoning, extended to
    // `supersedesRevisionId`: a direct caller could pass `''`/whitespace
    // (non-null, so not covered by "establish always passes null")
    // and it would otherwise be persisted verbatim. `null` itself means
    // "no supersedes" and must not be passed to `parseSupersedesRevisionId`
    // (which requires non-empty) -- only a non-null value is checked here.
    if (params.supersedesRevisionId !== null) {
      parseSupersedesRevisionId(params.supersedesRevisionId);
    }

    // Validate the whole candidate before touching the database at all --
    // a type mismatch anywhere throws `InvalidCandidateError` here, before
    // any `INSERT` is even prepared, so a rejected candidate can never
    // produce a partial write.
    const candidate = parseCandidateRevision(params.candidate);

    const revision: StableConfigRevision = {
      configName: candidate.configName,
      revisionId: crypto.randomUUID(),
      defaultMarker: candidate.defaultMarker,
      scopeBoundary: candidate.scopeBoundary,
      availability: candidate.availability,
      instructions: candidate.instructions,
      skills: candidate.skills,
      mcp: candidate.mcp,
      hooks: candidate.hooks,
      plugins: candidate.plugins,
      triggerCategory: params.triggerCategory,
      evidenceRef: params.evidenceRef,
      // `[Story 3.2]` `establish` still always passes `null` here; `revise`
      // passes the already-validated target revision id it supersedes.
      supersedesRevisionId: params.supersedesRevisionId,
    };

    const defaultMarker = factColumns(revision.defaultMarker);
    const scopeBoundary = factColumns(revision.scopeBoundary);
    const availability = factColumns(revision.availability);

    try {
      this.db.transaction(() => {
        this.db.query<unknown, [string]>('INSERT OR IGNORE INTO stable_config (config_name) VALUES (?)').run(revision.configName);

        this.db
          .query<
            unknown,
            [
              string,
              string,
              number,
              string,
              string | null,
              string | null,
              string | null,
              string,
              string | null,
              string | null,
              string | null,
              string,
              string | null,
              string | null,
              string | null,
              string,
              string,
              string,
              string,
              string,
              string,
              string,
              string,
              string | null,
            ]
          >(
            `INSERT INTO stable_config_revision (
               revision_id, config_name, schema_version,
               default_marker_status, default_marker_value, default_marker_reason, default_marker_observed_at,
               scope_boundary_status, scope_boundary_value, scope_boundary_reason, scope_boundary_observed_at,
               availability_status, availability_value, availability_reason, availability_observed_at,
               instructions_json, skills_json, mcp_json, hooks_json, plugins_json,
               created_at, trigger_category, evidence_ref, supersedes_revision_id
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            revision.revisionId,
            revision.configName,
            SUPPORTED_SCHEMA_VERSION,
            defaultMarker.status,
            defaultMarker.value,
            defaultMarker.reason,
            defaultMarker.observedAt,
            scopeBoundary.status,
            scopeBoundary.value,
            scopeBoundary.reason,
            scopeBoundary.observedAt,
            availability.status,
            availability.value,
            availability.reason,
            availability.observedAt,
            JSON.stringify(revision.instructions),
            JSON.stringify(revision.skills),
            JSON.stringify(revision.mcp),
            JSON.stringify(revision.hooks),
            JSON.stringify(revision.plugins),
            new Date().toISOString(),
            revision.triggerCategory,
            revision.evidenceRef,
            revision.supersedesRevisionId,
          );
      })();
    } catch (error) {
      // `[Story 3.2]` Only a non-null `supersedesRevisionId` can ever
      // collide with `idx_stable_config_revision_supersedes_revision_id`
      // (SQLite's unique index never treats two `NULL`s as duplicates), so
      // `establish` (always `null`) can never reach this branch -- only
      // `revise` can. Any other insert failure (e.g. an unrelated
      // constraint, a disk error) rethrows untouched.
      if (
        revision.supersedesRevisionId !== null &&
        error instanceof Error &&
        error.message.includes(SUPERSEDES_UNIQUE_CONSTRAINT_MESSAGE)
      ) {
        throw new SupersedesConflictError(revision.supersedesRevisionId);
      }
      throw error;
    }

    return revision;
  }

  close(): void {
    this.db.close();
  }
}
