import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { SqliteConfigRevisionWriter } from '../../src/adapters/sqlite/config-revision-writer';
import { SqliteConfigRevisionRepository } from '../../src/adapters/sqlite/repository';
import {
  InvalidCandidateError,
  InvalidTriggerCategoryError,
  MissingEvidenceError,
  MissingSupersedesError,
  parseSupersedesRevisionId,
} from '../../src/application/establish';
import { SupersedesConflictError } from '../../src/application/ports';
import type { ConfigRevisionWriter, EstablishConfigRevisionParams } from '../../src/application/ports';

/**
 * `bun:sqlite`'s `:memory:` gives every `new Database(':memory:')` call its
 * own isolated database -- unlike a real file path, two separate
 * connections never see the same data. A writer -> reader round trip
 * therefore needs a real temp file, matching the convention already used
 * by `tests/integration/cli*.test.ts`.
 */
function withTempDb<T>(fn: (dbPath: string) => Promise<T>): Promise<T> {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'control-plane-writer-'));
  const dbPath = path.join(tmpDir, 'db.sqlite3');
  return fn(dbPath).finally(() => rmSync(tmpDir, { recursive: true, force: true }));
}

const VALID_CANDIDATE = {
  configName: 'general',
  defaultMarker: { kind: 'known', value: true },
  scopeBoundary: { kind: 'known', value: 'a boundary' },
  availability: { kind: 'known', value: 'resolved' },
  skills: [
    {
      kind: 'skill',
      name: 'openspec-explore',
      sourceCategory: { kind: 'known', value: 'project-capability' },
      summary: { kind: 'known', value: 'skill reference: openspec-explore' },
    },
  ],
};

describe('SqliteConfigRevisionWriter.create', () => {
  test('inserts exactly one supersedes=null revision with persisted trigger/evidence, readable back via the read-only repository', async () => {
    await withTempDb(async (dbPath) => {
      const writer = new SqliteConfigRevisionWriter(dbPath);
      try {
        const revision = await writer.create({
          triggerCategory: 'new-scenario',
          evidenceRef: 'session-abc',
          candidate: VALID_CANDIDATE,
          supersedesRevisionId: null,
        });
        expect(revision.configName).toBe('general');
        expect(revision.triggerCategory).toBe('new-scenario');
        expect(revision.evidenceRef).toBe('session-abc');
        expect(revision.supersedesRevisionId).toBeNull();
        expect(revision.revisionId.length).toBeGreaterThan(0);
        expect(revision.skills).toHaveLength(1);
      } finally {
        writer.close();
      }

      const repo = new SqliteConfigRevisionRepository(dbPath);
      try {
        const all = await repo.listAll();
        expect(all).toHaveLength(1);
        expect(all[0]!.configName).toBe('general');
        expect(all[0]!.triggerCategory).toBe('new-scenario');
        expect(all[0]!.evidenceRef).toBe('session-abc');
        expect(all[0]!.supersedesRevisionId).toBeNull();
      } finally {
        repo.close();
      }
    });
  });

  test('rejects a candidate whose defaultMarker.value is not a boolean, with zero writes', async () => {
    await withTempDb(async (dbPath) => {
      const writer = new SqliteConfigRevisionWriter(dbPath);
      try {
        await expect(
          writer.create({
            triggerCategory: 'new-scenario',
            evidenceRef: 'session-abc',
            candidate: { ...VALID_CANDIDATE, defaultMarker: { kind: 'known', value: 'not-a-boolean' } },
            supersedesRevisionId: null,
          }),
        ).rejects.toBeInstanceOf(InvalidCandidateError);

        const repo = new SqliteConfigRevisionRepository(dbPath);
        try {
          expect(await repo.listAll()).toEqual([]);
        } finally {
          repo.close();
        }
      } finally {
        writer.close();
      }
    });
  });

  test('rejects a candidate missing configName, with zero writes', async () => {
    await withTempDb(async (dbPath) => {
      const writer = new SqliteConfigRevisionWriter(dbPath);
      try {
        await expect(
          writer.create({
            triggerCategory: 'bad-case',
            evidenceRef: 'session-abc',
            candidate: { skills: [] },
            supersedesRevisionId: null,
          }),
        ).rejects.toBeInstanceOf(InvalidCandidateError);
      } finally {
        writer.close();
      }
    });
  });

  test('two calls to create() generate two distinct revisionIds via crypto.randomUUID()', async () => {
    await withTempDb(async (dbPath) => {
      const writer = new SqliteConfigRevisionWriter(dbPath);
      try {
        const a = await writer.create({ triggerCategory: 'new-scenario', evidenceRef: 'e1', candidate: VALID_CANDIDATE, supersedesRevisionId: null });
        const b = await writer.create({ triggerCategory: 'known-insufficiency', evidenceRef: 'e2', candidate: VALID_CANDIDATE, supersedesRevisionId: null });
        expect(a.revisionId).not.toBe(b.revisionId);
      } finally {
        writer.close();
      }
    });
  });

  test('a capability entry missing sourceRef/contentFingerprint in the candidate degrades those two fields to Unknown rather than being rejected', async () => {
    await withTempDb(async (dbPath) => {
      const writer = new SqliteConfigRevisionWriter(dbPath);
      try {
        const revision = await writer.create({
          triggerCategory: 'new-scenario',
          evidenceRef: 'session-abc',
          candidate: VALID_CANDIDATE,
          supersedesRevisionId: null,
        });
        const skill = revision.skills[0]!;
        expect(skill.sourceRef.kind).toBe('unknown');
        expect(skill.contentFingerprint.kind).toBe('unknown');
      } finally {
        writer.close();
      }
    });
  });

  // `[Review fix]` A caller reaching this port directly (bypassing
  // `cli/index.ts`'s `parseTriggerCategory`/`parseEvidenceRef` calls, which
  // is exactly what a `TriggerCategory`-typed-but-runtime-untyped param
  // allows) must still be rejected -- `create()` cannot trust its own
  // params object.
  test('rejects a triggerCategory not in the known enum, with zero writes', async () => {
    await withTempDb(async (dbPath) => {
      const writer = new SqliteConfigRevisionWriter(dbPath);
      try {
        await expect(
          writer.create({
            triggerCategory: 'bogus' as unknown as EstablishConfigRevisionParams['triggerCategory'],
            evidenceRef: 'session-abc',
            candidate: VALID_CANDIDATE,
            supersedesRevisionId: null,
          }),
        ).rejects.toBeInstanceOf(InvalidTriggerCategoryError);

        const repo = new SqliteConfigRevisionRepository(dbPath);
        try {
          expect(await repo.listAll()).toEqual([]);
        } finally {
          repo.close();
        }
      } finally {
        writer.close();
      }
    });
  });

  test('rejects an empty evidenceRef, with zero writes', async () => {
    await withTempDb(async (dbPath) => {
      const writer = new SqliteConfigRevisionWriter(dbPath);
      try {
        await expect(
          writer.create({
            triggerCategory: 'bad-case',
            evidenceRef: '',
            candidate: VALID_CANDIDATE,
            supersedesRevisionId: null,
          }),
        ).rejects.toBeInstanceOf(MissingEvidenceError);

        const repo = new SqliteConfigRevisionRepository(dbPath);
        try {
          expect(await repo.listAll()).toEqual([]);
        } finally {
          repo.close();
        }
      } finally {
        writer.close();
      }
    });
  });

  // `[Review fix]` `parseEvidenceRef` trims *before* checking non-emptiness
  // -- a whitespace-only value must be rejected the same way as `''`, but
  // that half of the validator had no coverage at this (writer) boundary.
  test('rejects a whitespace-only evidenceRef, with zero writes', async () => {
    await withTempDb(async (dbPath) => {
      const writer = new SqliteConfigRevisionWriter(dbPath);
      try {
        await expect(
          writer.create({
            triggerCategory: 'bad-case',
            evidenceRef: '   ',
            candidate: VALID_CANDIDATE,
            supersedesRevisionId: null,
          }),
        ).rejects.toBeInstanceOf(MissingEvidenceError);

        const repo = new SqliteConfigRevisionRepository(dbPath);
        try {
          expect(await repo.listAll()).toEqual([]);
        } finally {
          repo.close();
        }
      } finally {
        writer.close();
      }
    });
  });

  test('ConfigRevisionWriter port type only exposes `create` -- no update/delete at compile time', () => {
    type Keys = keyof ConfigRevisionWriter;
    const onlyCreate: Keys extends 'create' ? true : false = true;
    expect(onlyCreate).toBe(true);
  });

  // `[Story 3.2]`
  test('create() with a non-null supersedesRevisionId pointing at an existing revision persists the supersede link', async () => {
    await withTempDb(async (dbPath) => {
      const writer = new SqliteConfigRevisionWriter(dbPath);
      try {
        const baseline = await writer.create({
          triggerCategory: 'new-scenario',
          evidenceRef: 'session-baseline',
          candidate: VALID_CANDIDATE,
          supersedesRevisionId: null,
        });

        const revised = await writer.create({
          triggerCategory: 'bad-case',
          evidenceRef: 'session-revise',
          candidate: VALID_CANDIDATE,
          supersedesRevisionId: baseline.revisionId,
        });
        expect(revised.supersedesRevisionId).toBe(baseline.revisionId);

        const repo = new SqliteConfigRevisionRepository(dbPath);
        try {
          const all = await repo.listAll();
          expect(all).toHaveLength(2);
          const persisted = all.find((r) => r.revisionId === revised.revisionId);
          expect(persisted?.supersedesRevisionId).toBe(baseline.revisionId);
        } finally {
          repo.close();
        }
      } finally {
        writer.close();
      }
    });
  });

  // `[Story 3.2]` The unique index `idx_stable_config_revision_supersedes_revision_id`
  // must reject a second revision superseding the same target -- translated
  // to `SupersedesConflictError`, never a raw SQLite `UNIQUE constraint
  // failed` error, and the second (rejected) call must not add a row.
  test('create() rejects a second revision superseding the same target, with the rejected call adding zero rows', async () => {
    await withTempDb(async (dbPath) => {
      const writer = new SqliteConfigRevisionWriter(dbPath);
      try {
        const baseline = await writer.create({
          triggerCategory: 'new-scenario',
          evidenceRef: 'session-baseline',
          candidate: VALID_CANDIDATE,
          supersedesRevisionId: null,
        });

        await writer.create({
          triggerCategory: 'bad-case',
          evidenceRef: 'session-revise-1',
          candidate: VALID_CANDIDATE,
          supersedesRevisionId: baseline.revisionId,
        });

        const repo = new SqliteConfigRevisionRepository(dbPath);
        try {
          expect(await repo.listAll()).toHaveLength(2);
        } finally {
          repo.close();
        }

        await expect(
          writer.create({
            triggerCategory: 'bad-case',
            evidenceRef: 'session-revise-2',
            candidate: VALID_CANDIDATE,
            supersedesRevisionId: baseline.revisionId,
          }),
        ).rejects.toBeInstanceOf(SupersedesConflictError);

        const repoAfter = new SqliteConfigRevisionRepository(dbPath);
        try {
          // Zero writes from the rejected second call -- still only 2, not 3.
          expect(await repoAfter.listAll()).toHaveLength(2);
        } finally {
          repoAfter.close();
        }
      } finally {
        writer.close();
      }
    });
  });

  // `[Review fix]` `parseSupersedesRevisionId` itself (not just through the
  // CLI integration test) -- mirrors the shape of a direct
  // `parseTriggerCategory`/`parseEvidenceRef` unit test, none of which
  // existed as standalone tests either, so this is the first direct
  // coverage of any of the three validators in this file.
  describe('parseSupersedesRevisionId', () => {
    test('accepts a non-empty id, trimmed', () => {
      expect(parseSupersedesRevisionId('  some-revision-id  ')).toBe('some-revision-id');
    });

    test('rejects undefined', () => {
      expect(() => parseSupersedesRevisionId(undefined)).toThrow(MissingSupersedesError);
    });

    test('rejects an empty string', () => {
      expect(() => parseSupersedesRevisionId('')).toThrow(MissingSupersedesError);
    });

    // `[Review fix]` Same trim-before-non-emptiness shape as
    // `parseEvidenceRef` -- a whitespace-only value must be rejected the
    // same way as `''`, not accepted as a literal whitespace id.
    test('rejects a whitespace-only string', () => {
      expect(() => parseSupersedesRevisionId('   ')).toThrow(MissingSupersedesError);
    });
  });

  // `[Review fix]` `SqliteConfigRevisionWriter.create()`'s own defensive
  // re-validation of `supersedesRevisionId` (a direct caller bypassing the
  // CLI's `parseSupersedesRevisionId` call could otherwise persist an
  // empty/whitespace-only value verbatim) -- mirrors the existing
  // whitespace-only `evidenceRef` test above.
  test('rejects a whitespace-only supersedesRevisionId, with zero writes', async () => {
    await withTempDb(async (dbPath) => {
      const writer = new SqliteConfigRevisionWriter(dbPath);
      try {
        await expect(
          writer.create({
            triggerCategory: 'bad-case',
            evidenceRef: 'session-abc',
            candidate: VALID_CANDIDATE,
            supersedesRevisionId: '   ',
          }),
        ).rejects.toBeInstanceOf(MissingSupersedesError);

        const repo = new SqliteConfigRevisionRepository(dbPath);
        try {
          expect(await repo.listAll()).toEqual([]);
        } finally {
          repo.close();
        }
      } finally {
        writer.close();
      }
    });
  });
});
