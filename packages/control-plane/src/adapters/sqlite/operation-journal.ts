import { Database } from 'bun:sqlite';
import OPERATION_SQL from '../../../migrations/0004_deployment_operation.sql' with { type: 'text' };
import STEPS_SQL from '../../../migrations/0006_operation_steps.sql' with { type: 'text' };
import RESOLUTION_SQL from '../../../migrations/0007_operation_resolutions.sql' with { type: 'text' };
import type { OperationJournalPort } from '../../application/ports';
import { appendOperationStep, createOperationJournal, finishOperationJournal, resolveInconclusiveOperation, startOperationJournal, type OperationJournalPhase, type OperationJournalRecord, type OperationPlanInput, type OperationResolution, type OperationStep } from '../../domain/operation-journal';
import { openSqliteDatabase } from './connection';

interface StatusRow { readonly operation_id: string; readonly deployment_id: string; readonly phase: string; readonly reason: string | null; readonly next_action: string }
interface ResolutionRow { readonly operation_id: string; readonly deployment_id: string; readonly sequence: number; readonly kind: OperationResolution['kind']; readonly resource: string; readonly outcome: OperationResolution['outcome']; readonly fingerprint: string; readonly observed_at: string }
interface StepRow { readonly sequence: number; readonly revision: number; readonly kind: OperationStep['kind']; readonly resource: string; readonly phase: OperationStep['phase']; readonly reason: string | null }
type Clock = () => string;

const JOURNAL_PHASES = new Set<OperationJournalPhase>(['prepared', 'applying', 'observing', 'succeeded', 'degraded', 'failed', 'cancelled', 'inconclusive', 'needs-resume', 'needs-manual-cleanup']);

function mapPhase(value: string): OperationJournalPhase {
  if (value === 'verified') throw new Error('verified requires evaluator-approved evidence');
  if (!JOURNAL_PHASES.has(value as OperationJournalPhase)) throw new Error('invalid operation phase');
  return value as OperationJournalPhase;
}

export class SqliteOperationJournal implements OperationJournalPort {
  private readonly db: Database;
  private readonly now: Clock;

  constructor(dbPath: string, now: Clock = () => new Date().toISOString()) {
    this.db = openSqliteDatabase(dbPath);
    this.now = now;
    this.db.transaction(() => {
      this.db.exec(OPERATION_SQL);
      this.db.exec(STEPS_SQL);
      this.db.exec(RESOLUTION_SQL);
    })();
  }

  async prepare(input: OperationPlanInput): Promise<OperationJournalRecord> {
    const planned = createOperationJournal(input);
    const existing = this.read(input.operationId);
    if (existing !== null) {
      if (existing.deploymentId !== input.deploymentId) throw new Error('operation belongs to another deployment');
      if (JSON.stringify(existing.steps.map(({ sequence, kind, resource }) => ({ sequence, kind, resource }))) !==
          JSON.stringify(planned.steps.map(({ sequence, kind, resource }) => ({ sequence, kind, resource })))) {
        throw new Error('operation already prepared');
      }
      return existing;
    }
    const timestamp = this.now();
    this.db.transaction(() => {
      const deployment = this.db.query<{ phase: string }, [string]>(`SELECT phase FROM deployment_status WHERE deployment_id = ?`).get(input.deploymentId);
      if (deployment !== null && deployment !== undefined && deployment.phase !== 'planned') throw new Error('deployment is not plan-ready');
      this.db.query(`INSERT INTO deployment_status (deployment_id, phase, last_operation_id, reason, next_action, created_at, updated_at) VALUES (?, 'planned', NULL, NULL, 'prepare-plan', ?, ?) ON CONFLICT(deployment_id) DO NOTHING`).run(input.deploymentId, timestamp, timestamp);
      this.db.query(`INSERT INTO operation_status (operation_id, deployment_id, phase, reason, next_action, created_at, updated_at) VALUES (?, ?, 'prepared', NULL, 'start-operation', ?, ?)`).run(input.operationId, input.deploymentId, timestamp, timestamp);
      for (const step of planned.steps) {
        this.db.query(`INSERT INTO operation_step (operation_id, sequence, revision, kind, resource, phase, reason, created_at) VALUES (?, ?, 0, ?, ?, 'pending', NULL, ?)`).run(input.operationId, step.sequence, step.kind, step.resource, timestamp);
      }
    })();
    return this.readOrThrow(input.operationId);
  }
  async start(operationId: string): Promise<OperationJournalRecord> {
    const current = this.readOrThrow(operationId);
    const updated = startOperationJournal(current);
    const result = this.db.query(`UPDATE operation_status SET phase = 'applying', next_action = 'observe-operation', updated_at = ? WHERE operation_id = ? AND phase IN ('prepared', 'needs-resume')`).run(this.now(), operationId);
    if (result.changes !== 1) throw new Error('operation start rejected: stale operation state');
    return updated;
  }

  async finish(operationId: string, phase: 'succeeded' | 'failed' | 'cancelled', reason?: string): Promise<OperationJournalRecord> {
    const current = this.readOrThrow(operationId);
    const updated = finishOperationJournal(current, phase, reason);
    const result = this.db.query(`UPDATE operation_status SET phase = ?, next_action = ?, reason = ?, updated_at = ? WHERE operation_id = ? AND phase IN ('applying', 'observing')`).run(phase, updated.nextAction, reason ?? null, this.now(), operationId);
    if (result.changes !== 1) throw new Error('operation finish rejected: stale operation state');
    return updated;
  }
  async resolveInconclusive(operationId: string, resolution: OperationResolution): Promise<OperationJournalRecord> {
    const current = this.readOrThrow(operationId);
    const updated = resolveInconclusiveOperation(current, resolution);
    this.db.transaction(() => {
      this.db.query(`INSERT INTO operation_resolution (operation_id, deployment_id, sequence, kind, resource, outcome, fingerprint, observed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(operationId, resolution.deploymentId, resolution.sequence, resolution.kind, resolution.resource, resolution.outcome, resolution.fingerprint, resolution.observedAt);
      const result = this.db.query(`UPDATE operation_status SET phase = ?, next_action = ?, updated_at = ? WHERE operation_id = ? AND deployment_id = ? AND phase = 'inconclusive'`).run(updated.phase, updated.nextAction, this.now(), operationId, resolution.deploymentId);
      if (result.changes !== 1) throw new Error('operation resolution rejected: stale operation state');
    })();
    return this.readOrThrow(operationId);
  }
  async appendStep(operationId: string, step: OperationStep): Promise<OperationJournalRecord> {
    const current = this.readOrThrow(operationId);
    const updated = appendOperationStep(current, step);
    const pending = current.steps.find((value) => value.phase === 'pending');
    if (pending === undefined) throw new Error('operation step sequence is not append-only');
    const latestRevision = this.db.query<{ revision: number }, [string, number]>(`SELECT MAX(revision) AS revision FROM operation_step WHERE operation_id = ? AND sequence = ?`).get(operationId, step.sequence)?.revision ?? 0;
    const timestamp = this.now();
    try {
      this.db.transaction(() => {
        this.db.query(`INSERT INTO operation_step (operation_id, sequence, revision, kind, resource, phase, reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(operationId, step.sequence, latestRevision + 1, step.kind, step.resource, step.phase, step.reason ?? null, timestamp);
        if (updated.phase !== current.phase) {
          const statusResult = this.db.query(`UPDATE operation_status SET phase = ?, next_action = ?, reason = ?, updated_at = ? WHERE operation_id = ? AND phase = ?`).run(updated.phase, updated.nextAction, step.reason ?? null, timestamp, operationId, current.phase);
          if (statusResult.changes !== 1) throw new Error('operation status changed concurrently');
        }
      })();
    } catch (error) {
      throw new Error(`operation step append rejected: ${(error as Error).message}`);
    }
    return this.readOrThrow(operationId);
  }

  async find(operationId: string): Promise<OperationJournalRecord | null> {
    return this.read(operationId);
  }

  close(): void { this.db.close(); }

  private readOrThrow(operationId: string): OperationJournalRecord {
    const record = this.read(operationId);
    if (record === null) throw new Error('operation not found');
    return record;
  }

  private read(operationId: string): OperationJournalRecord | null {
    const status = this.db.query<StatusRow, [string]>(`SELECT operation_id, deployment_id, phase, reason, next_action FROM operation_status WHERE operation_id = ?`).get(operationId);
    if (status === null) return null;
    const rows = this.db.query<StepRow, [string]>(`SELECT sequence, revision, kind, resource, phase, reason FROM operation_step AS current WHERE operation_id = ? AND revision = (SELECT MAX(revision) FROM operation_step AS latest WHERE latest.operation_id = current.operation_id AND latest.sequence = current.sequence) ORDER BY sequence`).all(operationId);
    const resolutions = this.db.query<ResolutionRow, [string]>(`SELECT operation_id, deployment_id, sequence, kind, resource, outcome, fingerprint, observed_at FROM operation_resolution WHERE operation_id = ? ORDER BY sequence`).all(operationId);
    const phase = mapPhase(status.phase);
    const nextAction = status.next_action;
    return { operationId: status.operation_id, deploymentId: status.deployment_id, phase, steps: rows.map(({ sequence, kind, resource, phase, reason }) => ({ sequence, kind, resource, phase, ...(reason === null ? {} : { reason }) })), resolutions: resolutions.map(({ operation_id, deployment_id, sequence, kind, resource, outcome, fingerprint, observed_at }) => ({ operationId: operation_id, deploymentId: deployment_id, sequence, kind, resource, outcome, fingerprint, observedAt: observed_at })), remoteRetention: 'retain', nextAction, ...(status.reason === null ? {} : { reason: status.reason }) };
  }
}
