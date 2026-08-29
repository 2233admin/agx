import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createLifecycleStateStore } from '../../src/adapters/state/lifecycle-state-store';
import type { MigrationCheckpoint } from '../../src/domain/migration';

const CHECKPOINT: MigrationCheckpoint = {
  schemaVersion: 'configs.migration/v1', sourceReceiptSchema: 'agx.receipt/v2', migrationId: 'migration-1234', installationId: 'install-1234567890abcdef', bundleId: 'bundle-1', sourceReceiptSHA256: 'a'.repeat(64), ownershipProof: { scheme: 'filesystem-readback/v1', proofSHA256: 'b'.repeat(64), verifiedAt: '2026-08-30T00:00:00.000Z' },
};

describe('lifecycle state store', () => {
  test('writes and reads a bounded migration checkpoint in SQLite', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'configs-state-')); const file = path.join(root, 'lifecycle.sqlite3');
    try {
      const store = createLifecycleStateStore(file);
      expect(await store.read()).toEqual({ kind: 'unavailable', reason: 'missing' });
      expect(await store.writeMigration(CHECKPOINT, 'op-migration')).toEqual({ kind: 'written' });
      const result = await store.read();
      expect(result.kind).toBe('available');
      if (result.kind === 'available') expect(result.metadata).toEqual({ migrationRun: { migrationId: 'migration-1234', operationId: 'op-migration', status: 'imported', sourceReceiptSHA256: 'a'.repeat(64) }, resourceBindings: [{ installationId: 'install-1234567890abcdef', bundleId: 'bundle-1', sourceReceiptSHA256: 'a'.repeat(64) }], operationId: 'op-migration' });
      store.close();
    } finally { try { rmSync(root, { recursive: true, force: true }); } catch { /* SQLite may release Windows handles after the test process exits. */ } }
  });
  test('rejects a second migration deterministically without clobbering the first', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'configs-state-cas-')); const file = path.join(root, 'lifecycle.sqlite3');
    try {
      const store = createLifecycleStateStore(file);
      expect(await store.writeMigration(CHECKPOINT, 'migration-1234')).toEqual({ kind: 'written' });
      expect(await store.writeMigration({ ...CHECKPOINT, migrationId: 'migration-second' }, 'migration-second')).toEqual({ kind: 'rejected', reason: 'already-present' });
      const result = await store.read();
      if (result.kind === 'available') expect(result.state.migration?.migrationId).toBe('migration-1234');
      store.close();
    } finally { try { rmSync(root, { recursive: true, force: true }); } catch { /* SQLite may release Windows handles after the test process exits. */ } }
  });
  test('preserves existing lifecycle JSON when adding migration fields', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'configs-state-preserve-')); const file = path.join(root, 'lifecycle.sqlite3');
    try {
      const initial = createLifecycleStateStore(file); initial.close();
      const db = new Database(file);
      db.query(`INSERT INTO control_plane_lifecycle_state (state_id, schema_version, lifecycle_json) VALUES (1, 'configs.state/v1', ?)`).run(JSON.stringify({ remoteResources: [] }));
      db.close();
      const store = createLifecycleStateStore(file);
      expect(await store.writeMigration(CHECKPOINT, 'migration-1234')).toEqual({ kind: 'written' });
      const result = await store.read();
      expect(result.kind).toBe('available');
      if (result.kind === 'available') expect(result.state.lifecycle).toEqual({ remoteResources: [] });
      store.close();
    } finally { try { rmSync(root, { recursive: true, force: true }); } catch { /* SQLite may release Windows handles after the test process exits. */ } }
  });
});
