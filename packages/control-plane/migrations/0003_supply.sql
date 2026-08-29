-- Story 3.1: adds the write path's persisted trigger/evidence facts to the
-- existing STRICT `stable_config_revision` table from 0001_init.sql, plus
-- the supersedes-chain column/indexes Story 3.2 will populate and enforce
-- (this Story only ever writes `supersedes_revision_id = NULL`; conflict
-- translation and tests for it are explicitly out of scope here).
--
-- Forward-only, additive: never rewrites or drops an existing column.
-- `repository.ts`'s migration runner guards this file so it only executes
-- once per database (SQLite's `ALTER TABLE ... ADD COLUMN` has no
-- `IF NOT EXISTS` form, unlike `CREATE TABLE`/`CREATE INDEX`).

ALTER TABLE stable_config_revision
  ADD COLUMN trigger_category TEXT NOT NULL DEFAULT 'new-scenario'
  CHECK (trigger_category IN ('new-scenario', 'known-insufficiency', 'bad-case'));

ALTER TABLE stable_config_revision
  ADD COLUMN evidence_ref TEXT NOT NULL DEFAULT '';

-- Nullable: this Story always writes NULL. Story 3.2 populates it when a
-- new revision explicitly supersedes an older one.
ALTER TABLE stable_config_revision
  ADD COLUMN supersedes_revision_id TEXT;

-- Story 3.2 reuses both indexes (supersede-conflict detection); created now
-- so the schema only changes once.
CREATE UNIQUE INDEX IF NOT EXISTS idx_stable_config_revision_config_name_revision_id
  ON stable_config_revision (config_name, revision_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_stable_config_revision_supersedes_revision_id
  ON stable_config_revision (supersedes_revision_id);
