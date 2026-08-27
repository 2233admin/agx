import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { importLegacyReceipt } from '../../src/adapters/migration/receipt-importer';
const fileContent = 'owned component\n';
const receipt = (overrides: Record<string, unknown> = {}) => ({ schema_version: 'agx.receipt/v2', installation_id: 'install-1', bundle_id: 'bundle-1', bundle_sha256: 'a'.repeat(64), template_version: 'bootstrap-20260819.1', template_content_sha256: 'b'.repeat(64), phase: 'configured', components: [{ name: 'agent-plugins', repository: 'zaurakworks/agent-plugins', distribution_repository: '2233admin/agent-plugins', commit_sha: 'c'.repeat(40), asset_sha256: 'd'.repeat(64), path: 'components/agent-plugins' }], owned_files: ['components/agent-plugins/README.md'], owned_file_sha256: undefined, ...overrides });
let roots: string[] = [];
afterEach(async () => { await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true }))); roots = []; });
async function fixture(value = receipt()) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'configs-migration-')); roots.push(root);
  await mkdir(path.join(root, '.agx'), { recursive: true }); await mkdir(path.join(root, 'components', 'agent-plugins'), { recursive: true });
  await writeFile(path.join(root, 'components', 'agent-plugins', 'README.md'), fileContent);
  const digest = createHash('sha256').update(fileContent).digest('hex'); const source = { ...value, owned_file_sha256: value.owned_file_sha256 ?? { 'components/agent-plugins/README.md': digest } };
  await writeFile(path.join(root, '.agx', 'receipt.json'), JSON.stringify(source));
  return root;
}

describe('legacy receipt importer', () => {
  test('imports a real receipt after no-follow ownership and digest verification', async () => {
    const root = await fixture();
    const result = await importLegacyReceipt(root, { now: '2026-08-27T00:00:00.000Z' });
    expect(result.kind).toBe('imported');
    if (result.kind === 'imported') expect(result.checkpoint).toEqual(expect.objectContaining({ schemaVersion: 'configs.migration/v1', installationId: 'install-1', sourceReceiptSHA256: expect.stringMatching(/^[a-f0-9]{64}$/) }));
  });
  test('rejects malformed fields and declared digest mismatches without returning receipt content', async () => {
    const malformed = await fixture(receipt({ owned_files: ['components/agent-plugins/../outside'] }));
    expect((await importLegacyReceipt(malformed)).kind).toBe('rejected');
    const digestMismatch = await fixture(receipt({ owned_file_sha256: { 'components/agent-plugins/README.md': 'f'.repeat(64) } }));
    expect((await importLegacyReceipt(digestMismatch)).kind).toBe('rejected');
    expect(JSON.stringify(await importLegacyReceipt(digestMismatch))).not.toContain(fileContent);
  });
  test('fails closed for receipt/component symlinks and no-follow path escapes', async () => {
    const root = await fixture();
    await rm(path.join(root, '.agx', 'receipt.json'));
    await symlink(path.join(root, 'components', 'agent-plugins', 'README.md'), path.join(root, '.agx', 'receipt.json'));
    expect((await importLegacyReceipt(root)).kind).toBe('rejected');
    const componentLinkRoot = await fixture();
    await rm(path.join(componentLinkRoot, 'components', 'agent-plugins'), { recursive: true, force: true });
    await symlink(await mkdtemp(path.join(os.tmpdir(), 'outside-components-')), path.join(componentLinkRoot, 'components', 'agent-plugins'));
    expect((await importLegacyReceipt(componentLinkRoot)).kind).toBe('rejected');
  });
  test('returns manual review for sidecar runtime and never mutates remote or local files', async () => {
    const root = await fixture(receipt({ configs_runtime: { path: 'components/configs-runtime/configs.exe' } }));
    const before = await importLegacyReceipt(root);
    expect(before).toEqual({ kind: 'requires-manual-review', reason: 'sidecar-runtime-not-authoritative' });
  });
});
