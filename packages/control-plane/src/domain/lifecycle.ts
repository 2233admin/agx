export const LIFECYCLE_SCHEMA_VERSION = 'configs.lifecycle/v1' as const;
export const LOCAL_STATE_DIGEST_ALGORITHM = 'sha256' as const;
export type LocalOwnership = 'created-by-configs' | 'pre-existing' | 'unknown';
export type LocalEntryKind = 'file' | 'directory' | 'symlink';
export interface LocalOwnershipRecord { readonly path: string; readonly digest: string; readonly ownership: LocalOwnership; readonly kind: LocalEntryKind; }
export interface LocalState { readonly digest: string; readonly records: readonly LocalOwnershipRecord[]; }
export interface ReleaseDescriptor { readonly version: string; readonly tag: string; readonly assetName: string; readonly assetSHA256: string; readonly provenance: { readonly repository: string; readonly commitSHA: string }; readonly platform: { readonly os: string; readonly arch: string }; }
export interface UpgradeCheckpoint { readonly schemaVersion: typeof LIFECYCLE_SCHEMA_VERSION; readonly checkpointId: string; readonly installationId: string; readonly deploymentId: string; readonly revisionId: string; readonly fromVersion: string; readonly toVersion: string; readonly release: ReleaseDescriptor; readonly preUpgradeStateDigest: string; readonly postUpgradeStateDigest: string; readonly preUpgradeState: readonly LocalOwnershipRecord[]; readonly remoteRetention: 'retain'; }
export interface UpgradeInput { readonly checkpoint: UpgradeCheckpoint; readonly release: ReleaseDescriptor; readonly platform: { readonly os: string; readonly arch: string }; readonly currentState: LocalState; readonly smoke: 'passed' | 'failed'; }
export interface RollbackInput { readonly checkpoint: UpgradeCheckpoint; readonly currentState: LocalState; readonly smoke: 'passed' | 'failed'; }
export interface UninstallInput { readonly localState: LocalState; readonly remoteResources: readonly string[]; }
export type CheckpointDecision = { readonly kind: 'valid'; readonly checkpoint: UpgradeCheckpoint } | { readonly kind: 'rejected'; readonly reason: 'malformed-checkpoint' | 'secret-field' | 'identity-mismatch' | 'release-mismatch' | 'state-invalid' };
export type UpgradeDecision = { readonly kind: 'ready'; readonly action: 'upgrade-locally-atomically'; readonly checkpoint: UpgradeCheckpoint; readonly remoteRetention: 'retain' } | { readonly kind: 'rejected'; readonly reason: 'checkpoint-invalid' | 'release-mismatch' | 'platform-mismatch' | 'state-modified' | 'unknown-local-state' | 'unsafe-local-state' | 'smoke-failed' };
export type RollbackDecision = { readonly kind: 'ready'; readonly action: 'restore-local-atomically'; readonly restore: readonly LocalOwnershipRecord[]; readonly remoteRetention: 'retain' } | { readonly kind: 'rejected'; readonly reason: 'checkpoint-invalid' | 'state-modified' | 'unknown-local-state' | 'unsafe-local-state' | 'smoke-failed' };
export type UninstallDecision = { readonly kind: 'ready'; readonly action: 'delete-owned-local-only'; readonly deletePaths: readonly string[]; readonly retainRemote: readonly ['repositories', 'projects', 'provider-client'] } | { readonly kind: 'rejected'; readonly reason: 'unknown-local-state' | 'unsafe-local-state' | 'malformed-local-state' };

const SHA256 = /^[a-f0-9]{64}$/;
const SHA1 = /^[a-f0-9]{40}$/;
const INSTALLATION = /^install-[a-f0-9]{16}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const REPOSITORY = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?\/[A-Za-z0-9_.-]{1,100}$/;
const VERSION = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const SAFE_TEXT = /^[^\u0000-\u001f\u007f]{1,256}$/;
const FORBIDDEN = new Set(['prompt', 'transcript', 'token', 'credential', 'password', 'secret', 'private_content', 'tool_payload']);
const REMOTE_RESOURCES = ['repositories', 'projects', 'provider-client'] as const;

function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function hasSecret(value: unknown): boolean { if (Array.isArray(value)) return value.some(hasSecret); if (!record(value)) return false; return Object.entries(value).some(([key, child]) => FORBIDDEN.has(key.toLowerCase()) || hasSecret(child)); }
function validLocalRecord(value: unknown): value is LocalOwnershipRecord {
  if (!record(value) || Object.keys(value).some((key) => !['path', 'digest', 'ownership', 'kind'].includes(key)) || typeof value.path !== 'string' || value.path === '' || value.path.startsWith('/') || value.path.includes('\\') || value.path.includes(':') || value.path.split('/').some((part) => part === '' || part === '.' || part === '..') || value.path === '.git' || value.path.startsWith('.git/') || !SHA256.test(String(value.digest)) || !['created-by-configs', 'pre-existing', 'unknown'].includes(String(value.ownership)) || !['file', 'directory', 'symlink'].includes(String(value.kind))) return false;
  return true;
}
function validLocalState(value: unknown): value is LocalState {
  if (!record(value) || Object.keys(value).some((key) => !['digest', 'records'].includes(key)) || !SHA256.test(String(value.digest)) || !Array.isArray(value.records) || !value.records.every(validLocalRecord)) return false;
  const paths = value.records.map((entry) => entry.path);
  return new Set(paths).size === paths.length;
}
function canonicalRecords(records: readonly LocalOwnershipRecord[]): string { return JSON.stringify([...records].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)); }
function sameState(actual: LocalState, expectedDigest: string, expectedRecords: readonly LocalOwnershipRecord[]): boolean { return actual.digest === expectedDigest && canonicalRecords(actual.records) === canonicalRecords(expectedRecords); }
function classifyLocalState(state: unknown): 'ok' | 'unknown-local-state' | 'unsafe-local-state' | 'malformed-local-state' {
  if (!validLocalState(state)) return 'malformed-local-state';
  if (state.records.some((entry) => entry.ownership === 'unknown')) return 'unknown-local-state';
  if (state.records.some((entry) => entry.kind === 'symlink')) return 'unsafe-local-state';
  return 'ok';
}
function validRelease(value: unknown): value is ReleaseDescriptor {
  if (!record(value) || Object.keys(value).some((key) => !['version', 'tag', 'assetName', 'assetSHA256', 'provenance', 'platform'].includes(key)) || typeof value.assetName !== 'string' || typeof value.assetSHA256 !== 'string' || !VERSION.test(String(value.version)) || value.tag !== `v${value.version}` || !SAFE_TEXT.test(value.assetName) || value.assetName.includes('/') || !SHA256.test(value.assetSHA256) || !record(value.provenance) || Object.keys(value.provenance).some((key) => !['repository', 'commitSHA'].includes(key)) || !REPOSITORY.test(String(value.provenance.repository)) || !SHA1.test(String(value.provenance.commitSHA)) || !record(value.platform) || Object.keys(value.platform).some((key) => !['os', 'arch'].includes(key)) || typeof value.platform.os !== 'string' || typeof value.platform.arch !== 'string' || !SAFE_TEXT.test(value.platform.os) || !SAFE_TEXT.test(value.platform.arch)) return false;
  return true;
}

export function validateUpgradeCheckpoint(input: unknown): CheckpointDecision {
  if (!record(input)) return { kind: 'rejected', reason: 'malformed-checkpoint' };
  if (hasSecret(input)) return { kind: 'rejected', reason: 'secret-field' };
  const value = input as Record<string, unknown>;
  if (Object.keys(value).some((key) => !['schemaVersion', 'checkpointId', 'installationId', 'deploymentId', 'revisionId', 'fromVersion', 'toVersion', 'release', 'preUpgradeStateDigest', 'postUpgradeStateDigest', 'preUpgradeState', 'remoteRetention'].includes(key)) || value.schemaVersion !== LIFECYCLE_SCHEMA_VERSION || typeof value.checkpointId !== 'string' || !ID.test(value.checkpointId) || typeof value.installationId !== 'string' || !INSTALLATION.test(value.installationId) || typeof value.deploymentId !== 'string' || !ID.test(value.deploymentId) || typeof value.revisionId !== 'string' || !ID.test(value.revisionId) || typeof value.fromVersion !== 'string' || !VERSION.test(value.fromVersion) || typeof value.toVersion !== 'string' || !VERSION.test(value.toVersion) || !validRelease(value.release) || value.toVersion !== value.release.version || !SHA256.test(String(value.preUpgradeStateDigest)) || !SHA256.test(String(value.postUpgradeStateDigest)) || !Array.isArray(value.preUpgradeState) || !value.preUpgradeState.every(validLocalRecord) || value.remoteRetention !== 'retain') return { kind: 'rejected', reason: 'malformed-checkpoint' };
  const paths = (value.preUpgradeState as LocalOwnershipRecord[]).map((entry) => entry.path);
  if (new Set(paths).size !== paths.length) return { kind: 'rejected', reason: 'state-invalid' };
  if ((value.preUpgradeState as LocalOwnershipRecord[]).some((entry) => entry.ownership === 'unknown' || entry.kind === 'symlink')) return { kind: 'rejected', reason: 'state-invalid' };
  return { kind: 'valid', checkpoint: value as unknown as UpgradeCheckpoint };
}

export function decideUpgrade(input: UpgradeInput): UpgradeDecision {
  const checkpoint = validateUpgradeCheckpoint(input.checkpoint);
  if (checkpoint.kind !== 'valid') return { kind: 'rejected', reason: 'checkpoint-invalid' };
  if (!validRelease(input.release) || JSON.stringify(input.release) !== JSON.stringify(checkpoint.checkpoint.release)) return { kind: 'rejected', reason: 'release-mismatch' };
  if (input.platform.os !== checkpoint.checkpoint.release.platform.os || input.platform.arch !== checkpoint.checkpoint.release.platform.arch) return { kind: 'rejected', reason: 'platform-mismatch' };
  const stateClass = classifyLocalState(input.currentState);
  if (stateClass === 'unknown-local-state') return { kind: 'rejected', reason: stateClass };
  if (stateClass === 'unsafe-local-state') return { kind: 'rejected', reason: stateClass };
  if (stateClass !== 'ok' || !sameState(input.currentState, checkpoint.checkpoint.preUpgradeStateDigest, checkpoint.checkpoint.preUpgradeState)) return { kind: 'rejected', reason: 'state-modified' };
  if (input.smoke !== 'passed') return { kind: 'rejected', reason: 'smoke-failed' };
  return { kind: 'ready', action: 'upgrade-locally-atomically', checkpoint: checkpoint.checkpoint, remoteRetention: 'retain' };
}

export function decideRollback(input: RollbackInput): RollbackDecision {
  const checkpoint = validateUpgradeCheckpoint(input.checkpoint);
  if (checkpoint.kind !== 'valid') return { kind: 'rejected', reason: 'checkpoint-invalid' };
  const stateClass = classifyLocalState(input.currentState);
  if (stateClass === 'unknown-local-state') return { kind: 'rejected', reason: stateClass };
  if (stateClass === 'unsafe-local-state') return { kind: 'rejected', reason: stateClass };
  if (stateClass !== 'ok' || input.currentState.digest !== checkpoint.checkpoint.postUpgradeStateDigest) return { kind: 'rejected', reason: 'state-modified' };
  if (input.smoke !== 'passed') return { kind: 'rejected', reason: 'smoke-failed' };
  return { kind: 'ready', action: 'restore-local-atomically', restore: checkpoint.checkpoint.preUpgradeState, remoteRetention: 'retain' };
}

export function decideUninstall(input: UninstallInput): UninstallDecision {
  const stateClass = classifyLocalState(input.localState);
  if (stateClass !== 'ok') return { kind: 'rejected', reason: stateClass };
  return { kind: 'ready', action: 'delete-owned-local-only', deletePaths: input.localState.records.filter((entry) => entry.ownership === 'created-by-configs').map((entry) => entry.path).sort(), retainRemote: REMOTE_RESOURCES };
}
