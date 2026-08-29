import { Database } from 'bun:sqlite';
import type { MigrationCheckpoint } from '../../domain/migration';
import { decideRollback, decideUninstall, decideUpgrade, validateUpgradeCheckpoint, type LocalState, type ReleaseDescriptor, type RollbackDecision, type UninstallDecision, type UpgradeCheckpoint, type UpgradeDecision } from '../../domain/lifecycle';
import { openSqliteDatabase, openSqliteDatabaseReadOnly } from '../sqlite/connection';

export const LIFECYCLE_STATE_SCHEMA = 'configs.state/v1' as const;
export const MAX_LIFECYCLE_STATE_BYTES = 1_048_576;
const SECRET_KEYS = new Set(['password', 'passwd', 'secret', 'token', 'credential', 'credentials', 'authorization', 'privatekey', 'private_key', 'prompt', 'transcript', 'session', 'api_key', 'private_content', 'tool_payload']);
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SHA256 = /^[a-f0-9]{64}$/i;

export interface MigrationRunMetadata { readonly migrationId: string; readonly operationId: string; readonly status: 'imported'; readonly sourceReceiptSHA256: string; }
export interface ResourceBindingMetadata { readonly installationId: string; readonly bundleId: string; readonly sourceReceiptSHA256: string; }
export interface LifecycleStateMetadata {
  readonly migrationRun: MigrationRunMetadata | null;
  readonly resourceBindings: readonly ResourceBindingMetadata[];
  readonly operationId: string | null;
}
export interface PersistedLifecycleState {
  readonly schemaVersion: typeof LIFECYCLE_STATE_SCHEMA;
  readonly migration?: MigrationCheckpoint;
  readonly lifecycle?: {
    readonly checkpoint?: UpgradeCheckpoint;
    readonly release?: ReleaseDescriptor;
    readonly platform?: { readonly os: string; readonly arch: string };
    readonly currentState?: LocalState;
    readonly smoke?: 'passed' | 'failed';
    readonly remoteResources?: readonly string[];
  };
}
export type LifecycleStateReadResult =
  | { readonly kind: 'available'; readonly state: PersistedLifecycleState; readonly metadata: LifecycleStateMetadata }
  | { readonly kind: 'unavailable'; readonly reason: 'missing' | 'invalid' | 'io-failure' };
export interface LifecycleStateStore {
  read(): Promise<LifecycleStateReadResult>;
  writeMigration(checkpoint: MigrationCheckpoint, operationId: string): Promise<{ readonly kind: 'written' } | { readonly kind: 'rejected'; readonly reason: 'invalid' | 'io-failure' | 'already-present' }>;
  close(): void;
}

function isRecord(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function hasSecret(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasSecret);
  if (!isRecord(value)) return false;
  return Object.entries(value).some(([key, child]) => SECRET_KEYS.has(key.toLowerCase()) || hasSecret(child));
}
function parseJson(value: string | null): unknown | null { if (value === null) return null; try { return JSON.parse(value); } catch { return null; } }
function validMigration(value: unknown): value is MigrationCheckpoint {
  if (!isRecord(value) || hasSecret(value) || Object.keys(value).some((key) => !['schemaVersion', 'sourceReceiptSchema', 'migrationId', 'installationId', 'bundleId', 'sourceReceiptSHA256', 'ownershipProof'].includes(key))) return false;
  const proof = value.ownershipProof;
  return value.schemaVersion === 'configs.migration/v1' && value.sourceReceiptSchema === 'agx.receipt/v2' && isId(value.migrationId) && isId(value.installationId) && isId(value.bundleId) && typeof value.sourceReceiptSHA256 === 'string' && SHA256.test(value.sourceReceiptSHA256) && isRecord(proof) && Object.keys(proof).every((key) => ['scheme', 'proofSHA256', 'verifiedAt'].includes(key)) && proof.scheme === 'filesystem-readback/v1' && typeof proof.proofSHA256 === 'string' && SHA256.test(proof.proofSHA256) && typeof proof.verifiedAt === 'string' && Number.isFinite(Date.parse(proof.verifiedAt));
}
function isId(value: unknown): value is string { return typeof value === 'string' && ID.test(value); }
function validLocalState(value: unknown): value is LocalState {
  if (!isRecord(value) || typeof value.digest !== 'string' || !SHA256.test(value.digest) || !Array.isArray(value.records)) return false;
  const paths = new Set<string>();
  return value.records.every((entry) => isRecord(entry) && typeof entry.path === 'string' && entry.path.length > 0 && !entry.path.includes('\\') && !entry.path.includes(':') && !entry.path.split('/').some((part) => part === '' || part === '.' || part === '..') && !paths.has(entry.path) && (paths.add(entry.path), typeof entry.digest === 'string') && SHA256.test(entry.digest) && typeof entry.ownership === 'string' && ['created-by-configs', 'pre-existing', 'unknown'].includes(entry.ownership) && typeof entry.kind === 'string' && ['file', 'directory', 'symlink'].includes(entry.kind));
}
function validLifecycle(value: unknown): boolean {
  if (!isRecord(value) || Object.keys(value).some((key) => !['checkpoint', 'release', 'platform', 'currentState', 'smoke', 'remoteResources'].includes(key)) || hasSecret(value)) return false;
  if (value.checkpoint !== undefined && validateUpgradeCheckpoint(value.checkpoint).kind !== 'valid') return false;
  if (value.release !== undefined && !validRelease(value.release)) return false;
  if (value.platform !== undefined && !validPlatform(value.platform)) return false;
  if (value.currentState !== undefined && !validLocalState(value.currentState)) return false;
  if (value.smoke !== undefined && value.smoke !== 'passed' && value.smoke !== 'failed') return false;
  if (value.remoteResources !== undefined && (!Array.isArray(value.remoteResources) || !value.remoteResources.every(isId))) return false;
  return true;
}
const VERSION = /^[0-9]+(?:\.[0-9]+){1,2}$/;
const SAFE_TEXT = /^[^\u0000-\u001f\u007f]{1,256}$/;
const REPOSITORY = /^[A-Za-z0-9][A-Za-z0-9-]{0,37}\/[A-Za-z0-9_.-]{1,100}$/;
function validRelease(value: unknown): value is ReleaseDescriptor {
  if (!isRecord(value) || Object.keys(value).some((key) => !['version', 'tag', 'assetName', 'assetSHA256', 'provenance', 'platform'].includes(key)) || typeof value.version !== 'string' || !VERSION.test(value.version) || value.tag !== `configs-v${value.version}` || typeof value.assetName !== 'string' || !SAFE_TEXT.test(value.assetName) || value.assetName.includes('/') || typeof value.assetSHA256 !== 'string' || !SHA256.test(value.assetSHA256)) return false;
  const provenance = value.provenance; const platform = value.platform;
  return isRecord(provenance) && Object.keys(provenance).every((key) => ['repository', 'commitSHA'].includes(key)) && typeof provenance.repository === 'string' && REPOSITORY.test(provenance.repository) && typeof provenance.commitSHA === 'string' && /^[a-f0-9]{40}$/i.test(provenance.commitSHA) && isRecord(platform) && Object.keys(platform).every((key) => ['os', 'arch'].includes(key)) && typeof platform.os === 'string' && SAFE_TEXT.test(platform.os) && typeof platform.arch === 'string' && SAFE_TEXT.test(platform.arch);
}
function validPlatform(value: unknown): boolean { return isRecord(value) && Object.keys(value).every((key) => ['os', 'arch'].includes(key)) && typeof value.os === 'string' && SAFE_TEXT.test(value.os) && typeof value.arch === 'string' && SAFE_TEXT.test(value.arch); }
function validState(value: unknown): value is PersistedLifecycleState {
  return isRecord(value) && value.schemaVersion === LIFECYCLE_STATE_SCHEMA && Object.keys(value).every((key) => ['schemaVersion', 'migration', 'lifecycle'].includes(key)) && !hasSecret(value) && (value.migration === undefined || validMigration(value.migration)) && (value.lifecycle === undefined || validLifecycle(value.lifecycle));
}
function encodeState(state: PersistedLifecycleState): string | null {
  try { const text = JSON.stringify(state); return new TextEncoder().encode(text).byteLength <= MAX_LIFECYCLE_STATE_BYTES ? text : null; } catch { return null; }
}
function ensureTable(db: Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS control_plane_lifecycle_state (state_id INTEGER PRIMARY KEY CHECK (state_id = 1), schema_version TEXT NOT NULL, migration_json TEXT, lifecycle_json TEXT, migration_run_json TEXT, resource_bindings_json TEXT, operation_id TEXT)`);
  const addColumn = (column: string): void => {
    try { db.exec(`ALTER TABLE control_plane_lifecycle_state ADD COLUMN ${column}`); }
    catch (error) {
      const message = String((error as { message?: unknown }).message ?? error).toLowerCase();
      if (!message.includes('duplicate column') && !message.includes('already exists')) throw error;
    }
  };
  const columns = db.query<{ name: string }, []>(`SELECT name FROM pragma_table_info('control_plane_lifecycle_state')`).all().map((row) => row.name);
  if (!columns.includes('migration_run_json')) addColumn('migration_run_json TEXT');
  if (!columns.includes('resource_bindings_json')) addColumn('resource_bindings_json TEXT');
  if (!columns.includes('operation_id')) addColumn('operation_id TEXT');
}
function validMigrationRun(value: unknown): value is MigrationRunMetadata {
  return isRecord(value) && Object.keys(value).every((key) => ['migrationId', 'operationId', 'status', 'sourceReceiptSHA256'].includes(key)) && isId(value.migrationId) && isId(value.operationId) && value.status === 'imported' && typeof value.sourceReceiptSHA256 === 'string' && SHA256.test(value.sourceReceiptSHA256);
}
function validResourceBindings(value: unknown): value is readonly ResourceBindingMetadata[] {
  return Array.isArray(value) && value.length > 0 && value.every((entry) => isRecord(entry) && Object.keys(entry).every((key) => ['installationId', 'bundleId', 'sourceReceiptSHA256'].includes(key)) && isId(entry.installationId) && isId(entry.bundleId) && typeof entry.sourceReceiptSHA256 === 'string' && SHA256.test(entry.sourceReceiptSHA256));
}
export function createLifecycleStateStore(dbPath: string, options: { readonly?: boolean } = {}): LifecycleStateStore {
  const db = options.readonly ? openSqliteDatabaseReadOnly(dbPath) : openSqliteDatabase(dbPath);
  if (!options.readonly) ensureTable(db);
  return {
    async read(): Promise<LifecycleStateReadResult> {
      try {
        const row = db.query<{ schema_version: string; migration_json: string | null; lifecycle_json: string | null; migration_run_json: string | null; resource_bindings_json: string | null; operation_id: string | null }, []>(`SELECT schema_version, migration_json, lifecycle_json, migration_run_json, resource_bindings_json, operation_id FROM control_plane_lifecycle_state WHERE state_id = 1`).get();
        if (row === null) return { kind: 'unavailable', reason: 'missing' };
        const state: unknown = { schemaVersion: row.schema_version, ...(row.migration_json === null ? {} : { migration: parseJson(row.migration_json) }), ...(row.lifecycle_json === null ? {} : { lifecycle: parseJson(row.lifecycle_json) }) };
        const migrationRun = row.migration_run_json === null ? null : parseJson(row.migration_run_json);
        const resourceBindings = row.resource_bindings_json === null ? [] : parseJson(row.resource_bindings_json);
        const migration = isRecord(state) && isRecord(state.migration) ? state.migration : undefined;
        const metadata = { migrationRun: migrationRun === null ? null : validMigrationRun(migrationRun) ? migrationRun : null, resourceBindings: validResourceBindings(resourceBindings) ? resourceBindings : [], operationId: row.operation_id };
        const metadataMatches = migration === undefined
          ? row.migration_run_json === null && row.resource_bindings_json === null && row.operation_id === null
          : metadata.migrationRun?.migrationId === migration.migrationId && metadata.migrationRun?.operationId === row.operation_id && metadata.migrationRun?.sourceReceiptSHA256 === migration.sourceReceiptSHA256 && metadata.resourceBindings.length === 1 && metadata.resourceBindings[0]?.installationId === migration.installationId && metadata.resourceBindings[0]?.bundleId === migration.bundleId && metadata.resourceBindings[0]?.sourceReceiptSHA256 === migration.sourceReceiptSHA256;
        if (!validState(state) || !metadataMatches || (row.migration_run_json !== null && metadata.migrationRun === null) || (row.resource_bindings_json !== null && metadata.resourceBindings.length === 0 && resourceBindings !== null) || (row.operation_id !== null && !isId(row.operation_id))) return { kind: 'unavailable', reason: 'invalid' };
        return { kind: 'available', state, metadata };
      } catch { return { kind: 'unavailable', reason: 'io-failure' }; }
    },
    async writeMigration(checkpoint: MigrationCheckpoint, operationId: string) {
      if (!validMigration(checkpoint) || !isId(operationId)) return { kind: 'rejected', reason: 'invalid' };
      const current = await this.read();
      if (current.kind === 'unavailable' && current.reason !== 'missing') return { kind: 'rejected', reason: current.reason };
      if (current.kind === 'available' && current.state.migration !== undefined) return { kind: 'rejected', reason: 'already-present' };
      const migrationRun = JSON.stringify({ migrationId: checkpoint.migrationId, operationId, status: 'imported', sourceReceiptSHA256: checkpoint.sourceReceiptSHA256 });
      const resourceBindings = JSON.stringify([{ installationId: checkpoint.installationId, bundleId: checkpoint.bundleId, sourceReceiptSHA256: checkpoint.sourceReceiptSHA256 }]);
      const state: PersistedLifecycleState = current.kind === 'available' ? { ...current.state, migration: checkpoint } : { schemaVersion: LIFECYCLE_STATE_SCHEMA, migration: checkpoint };
      const migrationJson = JSON.stringify(state.migration);
      if (encodeState(state) === null) return { kind: 'rejected', reason: 'invalid' };
      try {
        const result = db.transaction(() => db.query(`INSERT INTO control_plane_lifecycle_state (state_id, schema_version, migration_json, lifecycle_json, migration_run_json, resource_bindings_json, operation_id) VALUES (1, ?, ?, ?, ?, ?, ?) ON CONFLICT(state_id) DO UPDATE SET migration_json = excluded.migration_json, schema_version = excluded.schema_version, migration_run_json = excluded.migration_run_json, resource_bindings_json = excluded.resource_bindings_json, operation_id = excluded.operation_id WHERE control_plane_lifecycle_state.migration_json IS NULL`).run(LIFECYCLE_STATE_SCHEMA, migrationJson, state.lifecycle === undefined ? null : JSON.stringify(state.lifecycle), migrationRun, resourceBindings, operationId ?? null))();
        if (result.changes !== 1) return { kind: 'rejected', reason: 'already-present' };
        const readback = await this.read();
        return readback.kind === 'available' && readback.state.migration !== undefined ? { kind: 'written' } : { kind: 'rejected', reason: 'io-failure' };
      } catch { return { kind: 'rejected', reason: 'io-failure' }; }
    },
    close(): void { db.close(); },
  };
}

export interface DefaultLifecycleDecisionProviders {
  upgrade(checkpointId: string): Promise<UpgradeDecision>;
  rollback(checkpointId: string): Promise<RollbackDecision>;
  uninstall(): Promise<UninstallDecision>;
}
function unavailableUpgrade(): UpgradeDecision { return { kind: 'rejected', reason: 'unknown-local-state' }; }
function unavailableRollback(): RollbackDecision { return { kind: 'rejected', reason: 'unknown-local-state' }; }
function unavailableUninstall(): UninstallDecision { return { kind: 'rejected', reason: 'unknown-local-state' }; }
export function createDefaultLifecycleDecisionProviders(store: LifecycleStateStore, platform: { readonly os: string; readonly arch: string }): DefaultLifecycleDecisionProviders {
  return {
    async upgrade(checkpointId) { const loaded = await store.read(); const lifecycle = loaded.kind === 'available' ? loaded.state.lifecycle : undefined; if (lifecycle?.checkpoint === undefined || lifecycle.release === undefined || lifecycle.currentState === undefined || lifecycle.smoke === undefined || lifecycle.checkpoint.checkpointId !== checkpointId) return unavailableUpgrade(); return decideUpgrade({ checkpoint: lifecycle.checkpoint, release: lifecycle.release, platform, currentState: lifecycle.currentState, smoke: lifecycle.smoke }); },
    async rollback(checkpointId) { const loaded = await store.read(); const lifecycle = loaded.kind === 'available' ? loaded.state.lifecycle : undefined; if (lifecycle?.checkpoint === undefined || lifecycle.currentState === undefined || lifecycle.smoke === undefined || lifecycle.checkpoint.checkpointId !== checkpointId) return unavailableRollback(); return decideRollback({ checkpoint: lifecycle.checkpoint, currentState: lifecycle.currentState, smoke: lifecycle.smoke }); },
    async uninstall() { const loaded = await store.read(); const lifecycle = loaded.kind === 'available' ? loaded.state.lifecycle : undefined; if (lifecycle?.currentState === undefined || lifecycle.remoteResources === undefined) return unavailableUninstall(); return decideUninstall({ localState: lifecycle.currentState, remoteResources: lifecycle.remoteResources }); },
  };
}
