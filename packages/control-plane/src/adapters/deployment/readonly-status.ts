import type { OperationJournalPhase, OperationJournalRecord, OperationStep } from '../../domain/operation-journal';
import type { DeploymentStatus } from '../../domain/deployment';
import { known, unknown } from '../../domain/facts';
import type { StatusProjectionInput } from '../../domain/status';
import type { DurableStatusSelectors } from '../../application/status';
import { SqliteConfigRevisionRepository } from '../sqlite/repository';
import { openSqliteDatabaseReadOnly } from '../sqlite/connection';

export interface ReadonlyStatusDependencies {
  readonly load: (selectors: DurableStatusSelectors) => Promise<StatusProjectionInput | null>;
}

export function createReadonlyStatusDependencies(dbPath: string): ReadonlyStatusDependencies {
  return { load: (selectors) => loadReadonlyStatusProjection(dbPath, selectors) };
}

async function loadReadonlyStatusProjection(dbPath: string, selectors: DurableStatusSelectors): Promise<StatusProjectionInput | null> {
  if (selectors.deploymentId.trim() === '' || selectors.operationId.trim() === '') return null;
  let db: ReturnType<typeof openSqliteDatabaseReadOnly> | undefined;
  let configRepository: SqliteConfigRevisionRepository | undefined;
  try {
    db = openSqliteDatabaseReadOnly(dbPath);
    const deployment = db.query(`SELECT deployment_id, phase, last_operation_id, reason, next_action, updated_at FROM deployment_status WHERE deployment_id = ?`).get(selectors.deploymentId) as { deployment_id: string; phase: DeploymentStatus['phase']; last_operation_id: string | null; reason: string | null; next_action: string; updated_at: string } | null;
    const operation = db.query(`SELECT operation_id, deployment_id, revision_id, phase, next_action, updated_at FROM operation_status WHERE operation_id = ?`).get(selectors.operationId) as { operation_id: string; deployment_id: string; revision_id: string | null; phase: OperationJournalPhase; next_action: string; updated_at: string } | null;
    if (deployment === null || operation === null || operation.deployment_id !== deployment.deployment_id) return null;
    const rows = db.query(`SELECT sequence, kind, resource, phase, reason FROM operation_step AS current WHERE operation_id = ? AND revision = (SELECT MAX(revision) FROM operation_step AS latest WHERE latest.operation_id = current.operation_id AND latest.sequence = current.sequence) ORDER BY sequence`).all(selectors.operationId) as Array<{ sequence: number; kind: OperationStep['kind']; resource: string; phase: OperationStep['phase']; reason: string | null }>;
    const journal: OperationJournalRecord = { operationId: operation.operation_id, deploymentId: operation.deployment_id, ...(operation.revision_id === null ? {} : { revisionId: operation.revision_id }), phase: operation.phase, steps: rows.map((row) => ({ sequence: row.sequence, kind: row.kind, resource: row.resource, phase: row.phase, ...(row.reason === null ? {} : { reason: row.reason }) })), remoteRetention: 'retain', nextAction: operation.next_action };
    const status: DeploymentStatus = { deploymentId: deployment.deployment_id, phase: deployment.phase, lastOperationId: deployment.last_operation_id === null ? unknown('operation-id-unavailable', deployment.updated_at) : known(deployment.last_operation_id), reason: deployment.reason, nextAction: deployment.next_action };
    const activeRevision = operation.revision_id === null ? null : (configRepository = new SqliteConfigRevisionRepository(dbPath, { readonly: true }), await configRepository.findById(operation.revision_id));
    return { activeRevision: activeRevision === null ? unknown('active-revision-missing', deployment.updated_at) : known(activeRevision), deployment: status, operation: journal, launchPlans: [], readbacks: [], evidence: { phase: 'awaiting_verification', profile: 'github-delivery/v1', installationId: '', deploymentDigest: '', subjectDigest: '', evaluatedAt: deployment.updated_at, satisfied: [], missing: [], diagnostics: [], nextSteps: [], evidence: [] } };
  } catch {
    return null;
  } finally {
    configRepository?.close();
    db?.close();
  }
}
