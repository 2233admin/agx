import { type Database } from 'bun:sqlite';
import STATUS_SQL from '../../../migrations/0004_deployment_operation.sql' with { type: 'text' };

import { unknown, known } from '../../domain/facts';
import type { DeploymentPhase, DeploymentStatus } from '../../domain/deployment';
import type { OperationPhase, OperationStatus } from '../../domain/operation';
import { openSqliteDatabase } from './connection';
import { runConfigRevisionMigrations } from './repository';

interface DeploymentStatusRow {
  deployment_id: string;
  phase: string;
  last_operation_reason: string | null;
  last_operation_observed_at: string | null;
  last_operation_id: string | null;
  reason: string | null;
  next_action: string;
  created_at: string;
  updated_at: string;
}

interface OperationStatusRow {
  operation_id: string;
  deployment_id: string;
  phase: string;
  reason: string | null;
  next_action: string;
  created_at: string;
  updated_at: string;
}

const DEPLOYMENT_PHASES: readonly DeploymentPhase[] = ['planned', 'applying', 'configured', 'awaiting', 'drifted', 'inconclusive', 'failed', 'verified'];
const OPERATION_PHASES: readonly OperationPhase[] = ['prepared', 'applying', 'observing', 'succeeded', 'degraded', 'failed', 'cancelled', 'inconclusive', 'needs-resume', 'needs-manual-cleanup', 'verified'];
const DEPLOYMENT_COLUMNS = 'deployment_id, phase, last_operation_id, last_operation_reason, last_operation_observed_at, reason, next_action, created_at, updated_at';
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SAFE_SUMMARY = /^[^\u0000-\u001f\u007f]{0,256}$/;
const OPERATION_COLUMNS = 'operation_id, deployment_id, phase, reason, next_action, created_at, updated_at';

type Clock = () => string;

function validIdentifier(value: string): boolean {
  return IDENTIFIER.test(value);
}

function validPhase<T extends string>(value: string, phases: readonly T[]): value is T {
  return phases.includes(value as T);
}

function validSummary(value: string | null): boolean {
  return value === null || SAFE_SUMMARY.test(value);
}

function validateDeploymentStatus(status: DeploymentStatus): void {
  if (!validIdentifier(status.deploymentId) || !validPhase(status.phase, DEPLOYMENT_PHASES) || !validSummary(status.reason) || status.nextAction.trim() === '' || !SAFE_SUMMARY.test(status.nextAction)) {
    throw new Error('invalid deployment status');
  }
  if (status.lastOperationId.kind === 'known' && !validIdentifier(status.lastOperationId.value)) {
    throw new Error('invalid deployment status');
  }
}

function validateOperationStatus(status: OperationStatus): void {
  if (!validIdentifier(status.operationId) || !validIdentifier(status.deploymentId) || !validPhase(status.phase, OPERATION_PHASES) || !validSummary(status.reason) || status.nextAction.trim() === '' || !SAFE_SUMMARY.test(status.nextAction)) {
    throw new Error('invalid operation status');
  }
}
function mapDeployment(row: DeploymentStatusRow): DeploymentStatus {
  if (!validIdentifier(row.deployment_id) || !validPhase(row.phase, DEPLOYMENT_PHASES) ||
      !validSummary(row.reason) || !SAFE_SUMMARY.test(row.next_action) || row.next_action.trim() === '' ||
      !row.created_at || !row.updated_at) {
    throw new Error('invalid deployment status row');
  }
  if (row.last_operation_id !== null && !validIdentifier(row.last_operation_id)) throw new Error('invalid deployment status row');
  if (row.last_operation_id !== null && (row.last_operation_reason !== null || row.last_operation_observed_at !== null)) throw new Error('invalid deployment status row');
  if (!validSummary(row.last_operation_reason) || (row.last_operation_observed_at !== null && row.last_operation_observed_at.trim() === '')) throw new Error('invalid deployment status row');
  return {
    deploymentId: row.deployment_id,
    phase: row.phase,
    lastOperationId: row.last_operation_id === null
      ? unknown(row.last_operation_reason ?? 'not-recorded', row.last_operation_observed_at ?? row.updated_at)
      : known(row.last_operation_id),
    reason: row.reason,
    nextAction: row.next_action,
  };
}

function mapOperation(row: OperationStatusRow): OperationStatus {
  if (!validIdentifier(row.operation_id) || !validIdentifier(row.deployment_id) || !validPhase(row.phase, OPERATION_PHASES) || !validSummary(row.reason) || !SAFE_SUMMARY.test(row.next_action) || !row.created_at || !row.updated_at) {
    throw new Error('invalid operation status row');
  }
  return {
    operationId: row.operation_id,
    deploymentId: row.deployment_id,
    phase: row.phase,
    reason: row.reason,
    nextAction: row.next_action,
  };
}

export class SqliteDeploymentOperationRepository {
  private readonly db: Database;
  private readonly now: Clock;

  constructor(dbPath: string, now: Clock = () => new Date().toISOString()) {
    this.db = openSqliteDatabase(dbPath);
    runConfigRevisionMigrations(this.db);
    this.db.transaction(() => {
      this.db.exec(STATUS_SQL);
    })();
    this.now = now;
  }
  async saveDeployment(status: DeploymentStatus): Promise<void> {
    validateDeploymentStatus(status);
    const lastOperationId = status.lastOperationId.kind === 'known' ? status.lastOperationId.value : null;
    const lastOperationReason = status.lastOperationId.kind === 'unknown' ? status.lastOperationId.reason : null;
    const lastOperationObservedAt = status.lastOperationId.kind === 'unknown' ? status.lastOperationId.observedAt : null;
    const timestamp = this.now();
    this.db.query<unknown, [string, string, string | null, string | null, string | null, string | null, string, string, string]>(
      `INSERT INTO deployment_status (${DEPLOYMENT_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(deployment_id) DO UPDATE SET
         phase = excluded.phase,
         last_operation_id = excluded.last_operation_id,
         last_operation_reason = excluded.last_operation_reason,
         last_operation_observed_at = excluded.last_operation_observed_at,
         reason = excluded.reason,
         next_action = excluded.next_action,
         updated_at = excluded.updated_at`,
    ).run(status.deploymentId, status.phase, lastOperationId, lastOperationReason, lastOperationObservedAt, status.reason, status.nextAction, timestamp, timestamp);
  }

  async findDeployment(deploymentId: string): Promise<DeploymentStatus | null> {
    if (!validIdentifier(deploymentId)) throw new Error('invalid deployment id');
    const row = this.db.query<DeploymentStatusRow, [string]>(`SELECT ${DEPLOYMENT_COLUMNS} FROM deployment_status WHERE deployment_id = ?`).get(deploymentId);
    return row === null ? null : mapDeployment(row);
  }

  async saveOperation(status: OperationStatus): Promise<void> {
    validateOperationStatus(status);
    const timestamp = this.now();
    this.db.query<unknown, [string, string, string, string | null, string, string, string]>(
      `INSERT INTO operation_status (${OPERATION_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(operation_id) DO UPDATE SET
         deployment_id = excluded.deployment_id,
         phase = excluded.phase,
         reason = excluded.reason,
         next_action = excluded.next_action,
         updated_at = excluded.updated_at`,
    ).run(status.operationId, status.deploymentId, status.phase, status.reason, status.nextAction, timestamp, timestamp);
  }

  async findOperation(operationId: string): Promise<OperationStatus | null> {
    if (!validIdentifier(operationId)) throw new Error('invalid operation id');
    const row = this.db.query<OperationStatusRow, [string]>(`SELECT ${OPERATION_COLUMNS} FROM operation_status WHERE operation_id = ?`).get(operationId);
    return row === null ? null : mapOperation(row);
  }

  close(): void {
    this.db.close();
  }
}
