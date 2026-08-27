import { expect, test } from 'bun:test';
import { main } from '../../src/cli/index';
import type { MigrationImportResult } from '../../src/adapters/migration/receipt-importer';
import type { LifecycleStateStore } from '../../src/adapters/state/lifecycle-state-store';
import type { MigrationCheckpoint } from '../../src/domain/migration';

const checkpoint: MigrationCheckpoint = {
  schemaVersion: 'configs.migration/v1', sourceReceiptSchema: 'agx.receipt/v2', migrationId: 'migration-1234', installationId: 'install-1234567890abcdef', bundleId: 'bundle-1', sourceReceiptSHA256: 'a'.repeat(64), ownershipProof: { scheme: 'filesystem-readback/v1', proofSHA256: 'b'.repeat(64), verifiedAt: '2026-08-30T00:00:00.000Z' },
};

test('migrate persists only an actually imported checkpoint', async () => {
  const writes: MigrationCheckpoint[] = [];
  const store: LifecycleStateStore = { read: async () => ({ kind: 'unavailable', reason: 'missing' }), writeMigration: async (value) => { writes.push(value); return { kind: 'written' }; }, close: () => undefined };
  const imported: MigrationImportResult = { kind: 'imported', checkpoint };
  const rejected: MigrationImportResult = { kind: 'rejected', reason: 'receipt-invalid' };
  expect(await main(['migrate-agx', '--root', 'C:/legacy'], { migrationImporter: async () => imported, migrationStateStore: store })).toBe(0);
  expect(await main(['migrate-agx', '--root', 'C:/legacy'], { migrationImporter: async () => rejected, migrationStateStore: store })).toBe(1);
  expect(writes).toEqual([checkpoint]);
});

test('migrate returns typed retain failure when checkpoint persistence fails', async () => {
  const store: LifecycleStateStore = { read: async () => ({ kind: 'unavailable', reason: 'missing' }), writeMigration: async () => ({ kind: 'rejected', reason: 'io-failure' }), close: () => undefined };
  const output: string[] = []; const old = console.log; console.log = (...args: unknown[]) => output.push(args.map(String).join(' '));
  try { expect(await main(['migrate-agx', '--root', 'C:/legacy'], { migrationImporter: async () => ({ kind: 'imported', checkpoint }), migrationStateStore: store })).toBe(1); } finally { console.log = old; }
  expect(output.join('\n')).toContain('io-failure'); expect(output.join('\n')).toContain('retain');
});
