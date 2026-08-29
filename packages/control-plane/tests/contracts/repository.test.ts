import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import INIT_SQL from '../../migrations/0001_init.sql' with { type: 'text' };

import { SqliteConfigRevisionRepository, runConfigRevisionMigrations } from '../../src/adapters/sqlite/repository';
import type { RevisionRow } from '../../src/adapters/sqlite/repository';
import { ConfigUnsupportedError } from '../../src/application/queries';
import { isKnown, isUnknown, known, unknown } from '../../src/domain/facts';
import type { StableConfigRevision } from '../../src/domain/config';

/** Same convention as `tests/contracts/config-revision-writer.test.ts` -- a real temp file so two separate `Database` connections observe the same on-disk file (`:memory:` gives each connection its own isolated database). */
function withTempDbPath<T>(fn: (dbPath: string) => T): T {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'control-plane-migration-'));
  const dbPath = path.join(tmpDir, 'db.sqlite3');
  try {
    return fn(dbPath);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

function tableColumnNames(dbPath: string, table: string): string[] {
  const db = new Database(dbPath);
  try {
    return db
      .query<{ name: string }, []>(`SELECT name FROM pragma_table_info('${table}')`)
      .all()
      .map((row) => row.name);
  } finally {
    db.close();
  }
}

function tableIndexNames(dbPath: string, table: string): string[] {
  const db = new Database(dbPath);
  try {
    return db
      .query<{ name: string }, []>(`SELECT name FROM pragma_index_list('${table}')`)
      .all()
      .map((row) => row.name);
  } finally {
    db.close();
  }
}

function sampleRevision(overrides: Partial<StableConfigRevision> & { configName: string; revisionId: string }): StableConfigRevision {
  return {
    configName: overrides.configName,
    revisionId: overrides.revisionId,
    defaultMarker: overrides.defaultMarker ?? known(false),
    scopeBoundary: overrides.scopeBoundary ?? known('a scope boundary'),
    availability: overrides.availability ?? known('resolved'),
    instructions: overrides.instructions ?? [],
    skills: overrides.skills ?? [],
    mcp: overrides.mcp ?? [],
    hooks: overrides.hooks ?? [],
    plugins: overrides.plugins ?? [],
    triggerCategory: overrides.triggerCategory ?? 'new-scenario',
    evidenceRef: overrides.evidenceRef ?? 'test-evidence',
    supersedesRevisionId: overrides.supersedesRevisionId ?? null,
  };
}

function revisionRowFixture(overrides: Partial<RevisionRow> & Pick<RevisionRow, 'revision_id' | 'config_name'>): RevisionRow {
  return {
    schema_version: 1,
    default_marker_status: 'known',
    default_marker_value: 'false',
    default_marker_reason: null,
    default_marker_observed_at: null,
    scope_boundary_status: 'known',
    scope_boundary_value: 'boundary',
    scope_boundary_reason: null,
    scope_boundary_observed_at: null,
    availability_status: 'known',
    availability_value: 'resolved',
    availability_reason: null,
    availability_observed_at: null,
    instructions_json: '[]',
    skills_json: '[]',
    mcp_json: '[]',
    hooks_json: '[]',
    plugins_json: '[]',
    trigger_category: 'new-scenario',
    evidence_ref: 'test-evidence',
    supersedes_revision_id: null,
    ...overrides,
  };
}

describe('SqliteConfigRevisionRepository (:memory:, STRICT)', () => {
  test('creates STRICT tables via a transactional migration and starts empty', async () => {
    const repo = new SqliteConfigRevisionRepository(':memory:');
    try {
      const revisions = await repo.listAll();
      expect(revisions).toEqual([]);
    } finally {
      repo.close();
    }
  });

  test('findById on an empty store returns null (not an exception)', async () => {
    const repo = new SqliteConfigRevisionRepository(':memory:');
    try {
      const result = await repo.findById('does-not-exist');
      expect(result).toBeNull();
    } finally {
      repo.close();
    }
  });

  test('seed() + listAll() round-trips known and unknown facts faithfully', async () => {
    const repo = new SqliteConfigRevisionRepository(':memory:');
    try {
      const revision = sampleRevision({
        configName: 'general',
        revisionId: 'rev-1',
        defaultMarker: known(true),
        scopeBoundary: known('Role `general`; prompt: .cap/prompts/general.md'),
        availability: unknown('not-resolved', '2026-08-22T00:00:00.000Z'),
        skills: [
          {
            kind: 'skill',
            name: 'openspec-explore',
            sourceCategory: known('project-capability'),
            summary: known('skill reference: openspec-explore'),
            sourceRef: known('ref/openspec-explore'),
            contentFingerprint: known('fingerprint/openspec-explore'),
          },
        ],
      });
      repo.seed([revision]);

      const all = await repo.listAll();
      expect(all).toHaveLength(1);
      const [got] = all;
      expect(got!.configName).toBe('general');
      expect(got!.revisionId).toBe('rev-1');
      expect(isKnown(got!.defaultMarker) && got!.defaultMarker.value).toBe(true);
      expect(isKnown(got!.scopeBoundary)).toBe(true);
      expect(isUnknown(got!.availability)).toBe(true);
      if (isUnknown(got!.availability)) {
        expect(got!.availability.reason).toBe('not-resolved');
      }
      expect(got!.skills).toHaveLength(1);
      expect(got!.skills[0]!.name).toBe('openspec-explore');
    } finally {
      repo.close();
    }
  });

  test('findById round-trips a seeded revision', async () => {
    const repo = new SqliteConfigRevisionRepository(':memory:');
    try {
      repo.seed([sampleRevision({ configName: 'general', revisionId: 'rev-1' })]);
      const found = await repo.findById('rev-1');
      expect(found?.revisionId).toBe('rev-1');
      const notFound = await repo.findById('missing');
      expect(notFound).toBeNull();
    } finally {
      repo.close();
    }
  });

  test('findById throws ConfigUnsupportedError for a row with an unsupported schema_version', async () => {
    const repo = new SqliteConfigRevisionRepository(':memory:');
    try {
      const row: RevisionRow = revisionRowFixture({
        revision_id: 'rev-bad-version',
        config_name: 'general',
        schema_version: 99,
      });
      repo.insertRawRow(row);

      await expect(repo.findById('rev-bad-version')).rejects.toBeInstanceOf(ConfigUnsupportedError);
    } finally {
      repo.close();
    }
  });

  test('listAll degrades an unsupported-version row to Unknown instead of hiding or crashing the whole list', async () => {
    const repo = new SqliteConfigRevisionRepository(':memory:');
    try {
      repo.seed([sampleRevision({ configName: 'general', revisionId: 'rev-good' })]);
      const row: RevisionRow = revisionRowFixture({
        revision_id: 'rev-bad-version',
        config_name: 'general',
        schema_version: 99,
      });
      repo.insertRawRow(row);

      const all = await repo.listAll();
      expect(all).toHaveLength(2);
      const bad = all.find((r) => r.revisionId === 'rev-bad-version')!;
      expect(isUnknown(bad.availability)).toBe(true);
      const good = all.find((r) => r.revisionId === 'rev-good')!;
      expect(isKnown(good.availability)).toBe(true);
    } finally {
      repo.close();
    }
  });

  test('findById throws ConfigUnsupportedError when stored capability JSON cannot be parsed', async () => {
    const repo = new SqliteConfigRevisionRepository(':memory:');
    try {
      const row: RevisionRow = revisionRowFixture({
        revision_id: 'rev-corrupt-json',
        config_name: 'general',
        schema_version: 1,
        instructions_json: 'not-json',
      });
      repo.insertRawRow(row);

      await expect(repo.findById('rev-corrupt-json')).rejects.toBeInstanceOf(ConfigUnsupportedError);
    } finally {
      repo.close();
    }
  });

  test('a pre-Story-3.1-style stored capability entry (kind/name/sourceCategory/summary, but no sourceRef/contentFingerprint keys) degrades those two fields to Unknown (not undefined) on both findById and listAll', async () => {
    const repo = new SqliteConfigRevisionRepository(':memory:');
    try {
      const preStory31Skill = {
        kind: 'skill',
        name: 'legacy-skill',
        sourceCategory: { kind: 'known', value: 'project-capability' },
        summary: { kind: 'known', value: 'skill reference: legacy-skill' },
        // Deliberately no `sourceRef`/`contentFingerprint` keys at all --
        // this is the exact shape rows written before Story 3.1 have.
      };
      const row: RevisionRow = revisionRowFixture({
        revision_id: 'rev-pre-3-1',
        config_name: 'general',
        skills_json: JSON.stringify([preStory31Skill]),
      });
      repo.insertRawRow(row);

      const found = await repo.findById('rev-pre-3-1');
      expect(found).not.toBeNull();
      const skillFromFindById = found!.skills[0]!;
      expect(skillFromFindById.sourceRef).not.toBeUndefined();
      expect(isUnknown(skillFromFindById.sourceRef)).toBe(true);
      expect(isUnknown(skillFromFindById.contentFingerprint)).toBe(true);
      if (isUnknown(skillFromFindById.sourceRef)) {
        expect(typeof skillFromFindById.sourceRef.reason).toBe('string');
        expect(skillFromFindById.sourceRef.reason.length).toBeGreaterThan(0);
      }
      if (isUnknown(skillFromFindById.contentFingerprint)) {
        expect(typeof skillFromFindById.contentFingerprint.reason).toBe('string');
        expect(skillFromFindById.contentFingerprint.reason.length).toBeGreaterThan(0);
      }
      // sourceCategory/summary, which *were* present, must still round-trip as Known.
      expect(isKnown(skillFromFindById.sourceCategory)).toBe(true);
      expect(isKnown(skillFromFindById.summary)).toBe(true);

      const all = await repo.listAll();
      const skillFromListAll = all.find((r) => r.revisionId === 'rev-pre-3-1')!.skills[0]!;
      expect(skillFromListAll.sourceRef).not.toBeUndefined();
      expect(isUnknown(skillFromListAll.sourceRef)).toBe(true);
      expect(isUnknown(skillFromListAll.contentFingerprint)).toBe(true);
    } finally {
      repo.close();
    }
  });

  // `[Review fix]` `runConfigRevisionMigrations` used to gate all three
  // `0003_supply.sql` `ALTER TABLE`s on a single `trigger_category`
  // existence check, batched inside one transaction -- a database that
  // already had `supersedes_revision_id` (from an earlier partial run) but
  // not `trigger_category`/`evidence_ref` would hit "duplicate column
  // name" partway through that batch, rolling the *whole* transaction
  // back and silently swallowing the failure, leaving
  // `trigger_category`/`evidence_ref` permanently missing.
  test('a half-migrated database (only supersedes_revision_id present) gets trigger_category/evidence_ref backfilled, not silently left missing', () => {
    withTempDbPath((dbPath) => {
      const seed = new Database(dbPath, { create: true });
      try {
        seed.exec(INIT_SQL);
        seed.exec('ALTER TABLE stable_config_revision ADD COLUMN supersedes_revision_id TEXT');
      } finally {
        seed.close();
      }
      expect(tableColumnNames(dbPath, 'stable_config_revision')).not.toContain('trigger_category');
      expect(tableColumnNames(dbPath, 'stable_config_revision')).not.toContain('evidence_ref');

      // Opening a real repository against this half-migrated file must not
      // throw, and must actually finish the migration rather than treating
      // the pre-existing `supersedes_revision_id` column as "fully done".
      const repo = new SqliteConfigRevisionRepository(dbPath);
      try {
        const columns = tableColumnNames(dbPath, 'stable_config_revision');
        expect(columns).toContain('trigger_category');
        expect(columns).toContain('evidence_ref');
        expect(columns).toContain('supersedes_revision_id');
        // `[Review fix]` No prior test asserted the two `0003_supply.sql`
        // indexes actually get created (they're the non-`ADD COLUMN`
        // statements in the same per-statement loop).
        const indexes = tableIndexNames(dbPath, 'stable_config_revision');
        expect(indexes).toContain('idx_stable_config_revision_config_name_revision_id');
        expect(indexes).toContain('idx_stable_config_revision_supersedes_revision_id');
      } finally {
        repo.close();
      }
    });
  });

  // `[Review fix]` The other half-migrated test above only exercises one
  // partial-state shape (only `supersedes_revision_id` present). Per-column
  // gating needs coverage of a different partial shape too -- here,
  // `trigger_category` present but `evidence_ref`/`supersedes_revision_id`
  // still missing -- to actually exercise more than one column's gate.
  test('a half-migrated database (only trigger_category present) gets evidence_ref/supersedes_revision_id and both indexes backfilled', () => {
    withTempDbPath((dbPath) => {
      const seed = new Database(dbPath, { create: true });
      try {
        seed.exec(INIT_SQL);
        seed.exec(
          "ALTER TABLE stable_config_revision ADD COLUMN trigger_category TEXT NOT NULL DEFAULT 'new-scenario' CHECK (trigger_category IN ('new-scenario', 'known-insufficiency', 'bad-case'))",
        );
      } finally {
        seed.close();
      }
      expect(tableColumnNames(dbPath, 'stable_config_revision')).toContain('trigger_category');
      expect(tableColumnNames(dbPath, 'stable_config_revision')).not.toContain('evidence_ref');
      expect(tableColumnNames(dbPath, 'stable_config_revision')).not.toContain('supersedes_revision_id');

      const repo = new SqliteConfigRevisionRepository(dbPath);
      try {
        const columns = tableColumnNames(dbPath, 'stable_config_revision');
        expect(columns).toContain('trigger_category');
        expect(columns).toContain('evidence_ref');
        expect(columns).toContain('supersedes_revision_id');
        const indexes = tableIndexNames(dbPath, 'stable_config_revision');
        expect(indexes).toContain('idx_stable_config_revision_config_name_revision_id');
        expect(indexes).toContain('idx_stable_config_revision_supersedes_revision_id');
      } finally {
        repo.close();
      }
    });
  });

  // `[Review fix]` Reproduces real lock contention on the `ALTER TABLE`
  // step specifically (not `0001_init.sql`'s `CREATE TABLE`/`CREATE INDEX
  // IF NOT EXISTS`, which is naturally re-entrant and out of this fix's
  // scope) between two live connections on the same on-disk file -- one
  // holds a write lock (`BEGIN IMMEDIATE`) once the table already exists,
  // forcing the other's `ALTER TABLE` specifically to fail with
  // `SQLITE_BUSY`/"database is locked". That must be tolerated the same
  // way `"duplicate column name"` already is, not propagate and crash the
  // caller. (The full two-real-process race, including `0001_init.sql`'s
  // own re-entrant `CREATE TABLE`, is covered end-to-end by
  // `tests/integration/cli-establish.test.ts`'s subprocess test.)
  test('a concurrent connection holding the write lock during the ALTER TABLE step causes SQLITE_BUSY/"database is locked", which is tolerated rather than thrown', () => {
    withTempDbPath((dbPath) => {
      const seed = new Database(dbPath, { create: true });
      try {
        seed.exec(INIT_SQL);
      } finally {
        seed.close();
      }

      const holder = new Database(dbPath);
      try {
        holder.exec('BEGIN IMMEDIATE');
        try {
          const racer = new Database(dbPath);
          racer.exec('PRAGMA busy_timeout = 200;');
          try {
            expect(() => racer.exec("ALTER TABLE stable_config_revision ADD COLUMN trigger_category TEXT NOT NULL DEFAULT 'new-scenario'"))
              .toThrow(/database is locked|SQLITE_BUSY/i);
          } finally {
            racer.close();
          }
        } finally {
          holder.exec('COMMIT');
        }
      } finally {
        holder.close();
      }

      // The lock-contention error reproduced above is exactly what
      // `isConcurrentMigrationRace` (via `runConfigRevisionMigrations`)
      // must swallow instead of propagating -- verified end-to-end: once
      // the lock is released, opening a real repository against this
      // still-unmigrated file completes the migration without throwing.
      const repo = new SqliteConfigRevisionRepository(dbPath);
      try {
        const columns = tableColumnNames(dbPath, 'stable_config_revision');
        expect(columns).toContain('trigger_category');
        expect(columns).toContain('evidence_ref');
        expect(columns).toContain('supersedes_revision_id');
      } finally {
        repo.close();
      }
    });
  });
});
