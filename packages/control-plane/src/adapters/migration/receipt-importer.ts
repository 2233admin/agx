import { createHash } from 'node:crypto';
import { lstat, open, readFile } from 'node:fs/promises';
import path from 'node:path';
import { assessLegacyReceipt, type ImportedLegacyBinding, type LegacyReceipt, type MigrationCheckpoint } from '../../domain/migration';

export type MigrationImportResult =
  | { readonly kind: 'imported'; readonly checkpoint: MigrationCheckpoint }
  | { readonly kind: 'requires-manual-review'; readonly reason: 'sidecar-runtime-not-authoritative' | 'requires-ownership-verification' }
  | { readonly kind: 'rejected'; readonly reason: 'invalid-root' | 'receipt-missing' | 'receipt-invalid-json' | 'receipt-invalid' | 'io-failure' | 'unsafe-path' | 'symlink-or-reparse' | 'owned-file-missing' | 'owned-file-not-regular' | 'owned-file-digest-mismatch' | 'source-digest-mismatch' | 'invalid-checkpoint-time' };

export interface MigrationImportOptions { readonly now?: string; }

function sha256(data: Uint8Array): string { return createHash('sha256').update(data).digest('hex'); }
function error(reason: Extract<MigrationImportResult, { readonly kind: 'rejected' }>['reason']): MigrationImportResult { return { kind: 'rejected', reason }; }
function isAbsoluteRoot(root: string): boolean { return typeof root === 'string' && root.trim() !== '' && path.isAbsolute(root); }
async function safeStat(target: string): Promise<{ readonly ok: true; readonly value: Awaited<ReturnType<typeof lstat>> } | { readonly ok: false; readonly reason: Extract<MigrationImportResult, { readonly kind: 'rejected' }>['reason'] }> {
  try { return { ok: true, value: await lstat(target) }; } catch (cause) { return { ok: false, reason: (cause as NodeJS.ErrnoException).code === 'ENOENT' ? 'receipt-missing' : 'io-failure' }; }
}
async function ensureDirectory(target: string): Promise<MigrationImportResult | null> {
  const stat = await safeStat(target);
  if (!stat.ok) return error(stat.reason);
  if (stat.value.isSymbolicLink()) return error('symlink-or-reparse');
  if (!stat.value.isDirectory()) return error('unsafe-path');
  return null;
}
async function ensureNoFollowPath(root: string, relative: string, finalKind: 'file' | 'directory'): Promise<MigrationImportResult | null> {
  const parts = relative.split('/');
  let current = root;
  for (const [index, part] of parts.entries()) {
    current = path.join(current, part);
    const stat = await safeStat(current);
    if (!stat.ok) return error(index === parts.length - 1 && finalKind === 'file' ? 'owned-file-missing' : stat.reason);
    if (stat.value.isSymbolicLink()) return error('symlink-or-reparse');
    if (index === parts.length - 1) {
      if (finalKind === 'file' && !stat.value.isFile()) return error('owned-file-not-regular');
      if (finalKind === 'directory' && !stat.value.isDirectory()) return error('unsafe-path');
    } else if (!stat.value.isDirectory()) return error('unsafe-path');
  }
  return null;
}
function parseReceipt(bytes: Uint8Array): LegacyReceipt | MigrationImportResult {
  let value: unknown;
  try { value = JSON.parse(new TextDecoder().decode(bytes)); } catch { return error('receipt-invalid-json'); }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return error('receipt-invalid');
  const decision = assessLegacyReceipt(value);
  if (decision.kind === 'rejected') return error('receipt-invalid');
  if (decision.kind === 'requires-manual-review' && decision.reason === 'sidecar-runtime-not-authoritative') return decision;
  return value as LegacyReceipt;
}
function proofDigest(files: readonly string[], digests: Readonly<Record<string, string>>): string {
  const hash = createHash('sha256');
  for (const file of [...files].sort()) { hash.update(file); hash.update('\0'); hash.update(digests[file] ?? ''); hash.update('\0'); }
  return hash.digest('hex');
}

export async function importLegacyReceipt(root: string, options: MigrationImportOptions = {}): Promise<MigrationImportResult> {
  if (!isAbsoluteRoot(root)) return error('invalid-root');
  const rootResult = await ensureDirectory(root);
  if (rootResult !== null) return rootResult;
  const receiptPath = path.join(root, '.agx', 'receipt.json');
  const agxResult = await ensureDirectory(path.join(root, '.agx'));
  if (agxResult !== null) return agxResult.kind === 'rejected' && agxResult.reason === 'receipt-missing' ? error('receipt-missing') : agxResult;
  const receiptStat = await ensureNoFollowPath(root, '.agx/receipt.json', 'file');
  if (receiptStat !== null) return receiptStat;
  let bytes: Uint8Array;
  try { bytes = await readFile(receiptPath); } catch { return error('io-failure'); }
  const receiptDigest = sha256(bytes);
  const parsed = parseReceipt(bytes);
  if ('kind' in parsed && parsed.kind !== undefined) return parsed as MigrationImportResult;
  const receipt = parsed as LegacyReceipt;
  const component = receipt.components[0];
  if (component === undefined || !receipt.owned_files.every((owned) => owned === component.path || owned.startsWith(component.path + '/'))) return error('unsafe-path');
  const componentResult = await ensureNoFollowPath(root, component.path, 'directory');
  if (componentResult !== null) return componentResult;
  for (const ownedPath of receipt.owned_files) {
    const pathResult = await ensureNoFollowPath(root, ownedPath, 'file');
    if (pathResult !== null) return pathResult;
    let content: Uint8Array;
    try { content = await readFile(path.join(root, ...ownedPath.split('/'))); } catch { return error('io-failure'); }
    if (sha256(content) !== receipt.owned_file_sha256[ownedPath]) return error('owned-file-digest-mismatch');
  }
  const now = options.now ?? new Date().toISOString();
  if (!Number.isFinite(Date.parse(now))) return error('invalid-checkpoint-time');
  const ownedDigests = receipt.owned_file_sha256;
  const binding: ImportedLegacyBinding = { installationId: receipt.installation_id, bundleId: receipt.bundle_id, bundleSHA256: receipt.bundle_sha256, templateVersion: receipt.template_version, templateContentSHA256: receipt.template_content_sha256, component: { name: component.name, repository: component.repository, distributionRepository: component.distribution_repository, commitSHA: component.commit_sha, assetSHA256: component.asset_sha256, path: component.path }, ownedFiles: [...receipt.owned_files].sort(), ownedFileSHA256: ownedDigests };
  const checkpoint: MigrationCheckpoint = { schemaVersion: 'configs.migration/v1', sourceReceiptSchema: 'agx.receipt/v2', migrationId: `migration-${receiptDigest.slice(0, 32)}`, installationId: binding.installationId, bundleId: binding.bundleId, sourceReceiptSHA256: receiptDigest, ownershipProof: { scheme: 'filesystem-readback/v1', proofSHA256: proofDigest(binding.ownedFiles, binding.ownedFileSHA256), verifiedAt: now } };
  return { kind: 'imported', checkpoint };
}
