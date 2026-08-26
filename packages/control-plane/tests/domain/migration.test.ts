import { describe, expect, test } from 'bun:test';
import * as migration from '../../src/domain/migration';
import {
  assessLegacyReceipt,
  type LegacyReceipt,
} from '../../src/domain/migration';
const validReceipt = (): LegacyReceipt => ({
  schema_version: 'agx.receipt/v2',
  installation_id: 'install-1',
  bundle_id: 'bundle-1',
  bundle_sha256: 'a'.repeat(64),
  template_version: 'bootstrap-20260819.1',
  template_content_sha256: 'b'.repeat(64),
  phase: 'configured',
  components: [{
    name: 'agent-plugins',
    repository: 'zaurakworks/agent-plugins',
    distribution_repository: '2233admin/agent-plugins',
    commit_sha: 'c'.repeat(40),
    asset_sha256: 'd'.repeat(64),
    path: 'components/agent-plugins',
  }],
  owned_files: ['components/agent-plugins/README.md'],
  owned_file_sha256: { 'components/agent-plugins/README.md': 'e'.repeat(64) },
});
const fakeOwnershipProof = {
  kind: 'filesystem-readback-v1',
  verified: true,
  proofId: 'proof-1',
  verifiedAt: '2026-08-27T00:00:00.000Z',
};

describe('legacy AGX Receipt migration input', () => {
  test('requires importer ownership proof before any import decision', () => {
    const decision = assessLegacyReceipt(validReceipt());
    expect(decision).toEqual({ kind: 'requires-manual-review', reason: 'requires-ownership-verification' });
  });

  test('rejects malformed schema, ownership, paths, and sensitive fields', () => {
    const cases: Array<[string, Partial<Record<string, unknown>>, string]> = [
      ['missing schema', { schema_version: undefined }, 'missing-schema-version'],
      ['malformed digest', { bundle_sha256: 'not-a-digest' }, 'malformed-digest'],
      ['unknown ownership', { components: [{ ...validReceipt().components[0], repository: 'example/unknown' }] }, 'unknown-ownership'],
      ['path traversal', { owned_files: ['components/agent-plugins/../outside'] }, 'unsafe-owned-path'],
      ['absolute path', { owned_files: ['/components/agent-plugins/file'] }, 'unsafe-owned-path'],
      ['symlink-like path', { owned_files: ['components/agent-plugins/junction/file'] }, 'unsafe-owned-path'],
      ['control character path', { owned_files: ['components/agent-plugins/file\u0000'] }, 'unsafe-owned-path'],
      ['reserved device path', { owned_files: ['components/agent-plugins/CON'] }, 'unsafe-owned-path'],
      ['reserved device extension', { owned_files: ['components/agent-plugins/aux.txt'] }, 'unsafe-owned-path'],
      ['reserved COM device extension', { owned_files: ['components/agent-plugins/COM1.log'] }, 'unsafe-owned-path'],
      ['reserved LPT device', { owned_files: ['components/agent-plugins/LPT1'] }, 'unsafe-owned-path'],
    ];
    for (const [name, changes, reason] of cases) {
      const input = { ...validReceipt(), ...changes } as Record<string, unknown>;
      if (name === 'missing schema') delete input.schema_version;
      if (Array.isArray(input.owned_files)) input.owned_file_sha256 = Object.fromEntries(input.owned_files.map((path) => [path, 'e'.repeat(64)]));
      const decision = assessLegacyReceipt(input);
      expect(decision).toEqual({ kind: 'rejected', reason });
    }
  });

  test('does not adopt a sidecar runtime as configs authority', () => {
    const decision = assessLegacyReceipt({ ...validReceipt(), configs_runtime: { path: 'components/configs-runtime/configs.exe' } });
    expect(decision).toEqual({ kind: 'requires-manual-review', reason: 'sidecar-runtime-not-authoritative' });
  });

  test('no pure API creates a checkpoint from forged input', () => {
    const structural = assessLegacyReceipt(validReceipt());
    expect(structural).toEqual({ kind: 'requires-manual-review', reason: 'requires-ownership-verification' });
    expect('createMigrationCheckpoint' in migration).toBe(false);
    const fakeProof = assessLegacyReceipt({ ...validReceipt(), ownership_proof: fakeOwnershipProof });
    expect(fakeProof).toEqual({ kind: 'rejected', reason: 'unsupported-field' });
  });
  test('requires ownership verification before import', () => {
    expect(assessLegacyReceipt(validReceipt())).toEqual({ kind: 'requires-manual-review', reason: 'requires-ownership-verification' });
  });

  test('rejects unsafe identifiers', () => {
    for (const field of ['installation_id', 'bundle_id', 'template_version'] as const) {
      for (const value of ['bad\nvalue', 'bad/value', 'x'.repeat(129)]) {
        const decision = assessLegacyReceipt({ ...validReceipt(), [field]: value });
        expect(decision).toEqual({ kind: 'rejected', reason: 'malformed-identifier' });
      }
    }
  });
});
