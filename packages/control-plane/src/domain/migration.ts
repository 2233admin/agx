export interface LegacyReceiptComponent {
  readonly name: string;
  readonly repository: string;
  readonly distribution_repository: string;
  readonly commit_sha: string;
  readonly asset_sha256: string;
  readonly path: string;
}

export interface LegacyReceipt {
  readonly schema_version: string;
  readonly installation_id: string;
  readonly bundle_id: string;
  readonly bundle_sha256: string;
  readonly template_version: string;
  readonly template_content_sha256: string;
  readonly phase: string;
  readonly components: readonly LegacyReceiptComponent[];
  readonly configs_runtime?: unknown;
  readonly owned_files: readonly string[];
  readonly owned_file_sha256: Readonly<Record<string, string>>;
  readonly [field: string]: unknown;
}

export interface ImportedLegacyBinding {
  readonly installationId: string;
  readonly bundleId: string;
  readonly bundleSHA256: string;
  readonly templateVersion: string;
  readonly templateContentSHA256: string;
  readonly component: {
    readonly name: string;
    readonly repository: string;
    readonly distributionRepository: string;
    readonly commitSHA: string;
    readonly assetSHA256: string;
    readonly path: string;
  };
  readonly ownedFiles: readonly string[];
  readonly ownedFileSHA256: Readonly<Record<string, string>>;
}


export interface ManualReviewLegacyReceiptDecision {
  readonly kind: 'requires-manual-review';
  readonly reason: 'sidecar-runtime-not-authoritative' | 'requires-ownership-verification';
}

export type RejectedLegacyReceiptReason =
  | 'missing-schema-version'
  | 'malformed-schema'
  | 'malformed-identifier'
  | 'malformed-digest'
  | 'malformed-component'
  | 'unknown-ownership'
  | 'unsafe-owned-path'
  | 'unsupported-owned-path'
  | 'sensitive-field'
  | 'unsupported-field';

export interface RejectedLegacyReceiptDecision {
  readonly kind: 'rejected';
  readonly reason: RejectedLegacyReceiptReason;
}

export type LegacyReceiptDecision =
  | ManualReviewLegacyReceiptDecision
  | RejectedLegacyReceiptDecision;

/**
 * Data shape for a checkpoint constructed by the later I/O importer only.
 * This module intentionally exposes no constructor for it.
 */
export interface MigrationCheckpoint {
  readonly schemaVersion: 'configs.migration/v1';
  readonly sourceReceiptSchema: 'agx.receipt/v2';
  readonly migrationId: string;
  readonly installationId: string;
  readonly bundleId: string;
  readonly sourceReceiptSHA256: string;
  readonly ownershipProof: {
    readonly scheme: 'filesystem-readback/v1';
    readonly proofSHA256: string;
    readonly verifiedAt: string;
  };
}

const LEGACY_FIELDS = new Set([
  'schema_version',
  'installation_id',
  'bundle_id',
  'bundle_sha256',
  'template_version',
  'template_content_sha256',
  'phase',
  'components',
  'configs_runtime',
  'owned_files',
  'owned_file_sha256',
]);
const SENSITIVE_FIELDS = new Set(['credential', 'credentials', 'token', 'api_key', 'authorization', 'prompt', 'transcript', 'session', 'private_content', 'tool_payload']);
const SHA256 = /^[a-f0-9]{64}$/;
const SHA1 = /^[a-f0-9]{40}$/;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const TEMPLATE_VERSION = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SYMLINK_LIKE = /^(symlink|junction|reparse|link)$/i;
const WINDOWS_DEVICE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;


/**
 * Performs structural validation only. This function never returns
 * `importable`: actual filesystem no-follow checks, ownership proof, and
 * content readback belong to a later importer with I/O capabilities.
 */
export function assessLegacyReceipt(input: unknown): LegacyReceiptDecision {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return { kind: 'rejected', reason: 'malformed-schema' };
  }
  const receipt = input as Record<string, unknown>;
  for (const field of Object.keys(receipt)) {
    if (SENSITIVE_FIELDS.has(field.toLowerCase())) return { kind: 'rejected', reason: 'sensitive-field' };
    if (!LEGACY_FIELDS.has(field)) return { kind: 'rejected', reason: 'unsupported-field' };
  }
  if (!Object.prototype.hasOwnProperty.call(receipt, 'schema_version')) {
    return { kind: 'rejected', reason: 'missing-schema-version' };
  }
  if (receipt.schema_version !== 'agx.receipt/v2') return { kind: 'rejected', reason: 'malformed-schema' };
  if (typeof receipt.installation_id !== 'string' || typeof receipt.bundle_id !== 'string' ||
      typeof receipt.template_version !== 'string' || receipt.phase !== 'configured') {
    return { kind: 'rejected', reason: 'malformed-schema' };
  }
  if (!IDENTIFIER.test(receipt.installation_id) || !IDENTIFIER.test(receipt.bundle_id) || !TEMPLATE_VERSION.test(receipt.template_version)) {
    return { kind: 'rejected', reason: 'malformed-identifier' };
  }
  if (typeof receipt.bundle_sha256 !== 'string' || !SHA256.test(receipt.bundle_sha256) ||
      typeof receipt.template_content_sha256 !== 'string' || !SHA256.test(receipt.template_content_sha256)) {
    return { kind: 'rejected', reason: 'malformed-digest' };
  }
  if (!Array.isArray(receipt.components) || receipt.components.length !== 1) {
    return { kind: 'rejected', reason: 'malformed-component' };
  }
  const component = receipt.components[0];
  if (component === null || typeof component !== 'object' || Array.isArray(component)) {
    return { kind: 'rejected', reason: 'malformed-component' };
  }
  const componentRecord = component as Record<string, unknown>;
  const expectedComponentFields = ['name', 'repository', 'distribution_repository', 'commit_sha', 'asset_sha256', 'path'];
  if (Object.keys(componentRecord).some((field) => !expectedComponentFields.includes(field)) ||
      expectedComponentFields.some((field) => typeof componentRecord[field] !== 'string')) {
    return { kind: 'rejected', reason: 'malformed-component' };
  }
  if (componentRecord.name !== 'agent-plugins' || componentRecord.repository !== 'zaurakworks/agent-plugins' ||
      componentRecord.distribution_repository !== '2233admin/agent-plugins') {
    return { kind: 'rejected', reason: 'unknown-ownership' };
  }
  if (!SHA1.test(componentRecord.commit_sha as string) || !SHA256.test(componentRecord.asset_sha256 as string) ||
      componentRecord.path !== 'components/agent-plugins') {
    return { kind: 'rejected', reason: 'malformed-component' };
  }
  if (!Array.isArray(receipt.owned_files) || receipt.owned_files.length === 0 ||
      !receipt.owned_files.every((value): value is string => typeof value === 'string')) {
    return { kind: 'rejected', reason: 'unsafe-owned-path' };
  }
  const ownedFiles = [...receipt.owned_files].sort();
  if (new Set(ownedFiles).size !== ownedFiles.length || ownedFiles.some((value) => !isSafeOwnedPath(value))) {
    return { kind: 'rejected', reason: 'unsafe-owned-path' };
  }
  if (receipt.owned_file_sha256 === null || typeof receipt.owned_file_sha256 !== 'object' || Array.isArray(receipt.owned_file_sha256)) {
    return { kind: 'rejected', reason: 'malformed-digest' };
  }
  const digests = receipt.owned_file_sha256 as Record<string, unknown>;
  const digestKeys = Object.keys(digests).sort();
  if (digestKeys.length !== ownedFiles.length || digestKeys.some((key, index) => key !== ownedFiles[index] || typeof digests[key] !== 'string' || !SHA256.test(digests[key] as string))) {
    return { kind: 'rejected', reason: 'malformed-digest' };
  }
  if (Object.prototype.hasOwnProperty.call(receipt, 'configs_runtime')) {
    return { kind: 'requires-manual-review', reason: 'sidecar-runtime-not-authoritative' };
  }
  return { kind: 'requires-manual-review', reason: 'requires-ownership-verification' };
}
function isSafeOwnedPath(value: string): boolean {
  if (value === '' || value.startsWith('/') || value.includes('\\') || value.includes(':') || CONTROL_CHARACTER.test(value)) return false;
  const parts = value.split('/');
  if (parts.length < 3 || parts[0] !== 'components' || parts[1] !== 'agent-plugins' ||
      parts.some((part) => part === '' || part === '.' || part === '..' || SYMLINK_LIKE.test(part) || WINDOWS_DEVICE.test(part))) return false;
  return true;
}
