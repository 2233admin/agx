import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { known, unknown } from '../../src/domain/facts';
import type { DeploymentStatus } from '../../src/domain/deployment';
import type { OperationStatus } from '../../src/domain/operation';
import { SqliteDeploymentOperationRepository } from '../../src/adapters/sqlite/deployment-operation-repository';
import { openSqliteDatabase } from '../../src/adapters/sqlite/connection';

const deployment = (deploymentId: string): DeploymentStatus => ({
  deploymentId,
  phase: 'configured',
  lastOperationId: known(`op-${deploymentId}`),
  reason: null,
  nextAction: 'none',
});

const operation = (operationId: string, deploymentId: string): OperationStatus => ({
  operationId,
  deploymentId,
  phase: 'succeeded',
  reason: null,
  nextAction: 'none',
});

describe('SqliteDeploymentOperationRepository', () => {
  test('saves and finds typed deployment and operation status', async () => {
    const repository = new SqliteDeploymentOperationRepository(':memory:');
    await repository.saveDeployment(deployment('dep-1'));
    await repository.saveOperation(operation('op-1', 'dep-1'));

    expect(await repository.findDeployment('dep-1')).toEqual(deployment('dep-1'));
    expect(await repository.findOperation('op-1')).toEqual(operation('op-1', 'dep-1'));
    repository.close();
  });

  test('updates one current row without erasing unrelated rows', async () => {
    const repository = new SqliteDeploymentOperationRepository(':memory:');
    await repository.saveDeployment(deployment('dep-1'));
    await repository.saveDeployment(deployment('dep-2'));
    await repository.saveDeployment({ ...deployment('dep-1'), phase: 'drifted', reason: 'readback-mismatch', nextAction: 'reconcile-resources' });

    expect((await repository.findDeployment('dep-2'))?.phase).toBe('configured');
    expect((await repository.findDeployment('dep-1'))?.phase).toBe('drifted');
    repository.close();
  });

  test('requires an existing deployment for operation status', async () => {
    const repository = new SqliteDeploymentOperationRepository(':memory:');
    await expect(repository.saveOperation(operation('op-1', 'missing'))).rejects.toThrow();
    repository.close();
  });

  test('preserves unknown last-operation Fact metadata on round-trip', async () => {
    const repository = new SqliteDeploymentOperationRepository(':memory:');
    const status: DeploymentStatus = {
      ...deployment('dep-unknown'),
      lastOperationId: unknown('operation-not-recorded', '2026-08-27T01:02:03.000Z'),
    };
    await repository.saveDeployment(status);
    expect(await repository.findDeployment('dep-unknown')).toEqual(status);
    repository.close();
  });
  test('upgrades an existing 0004 database before preserving Fact metadata', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'configs-status-'));
    const dbPath = join(directory, 'state.sqlite3');
    const db = openSqliteDatabase(dbPath);
    db.exec(`CREATE TABLE deployment_status (
      deployment_id TEXT PRIMARY KEY,
      phase TEXT NOT NULL CHECK (phase IN ('planned','applying','configured','awaiting','drifted','inconclusive','failed','verified')),
      last_operation_id TEXT,
      reason TEXT,
      next_action TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE operation_status (
      operation_id TEXT PRIMARY KEY,
      deployment_id TEXT NOT NULL REFERENCES deployment_status (deployment_id),
      phase TEXT NOT NULL CHECK (phase IN ('prepared','applying','observing','succeeded','degraded','failed','cancelled','inconclusive','needs-resume','needs-manual-cleanup','verified')),
      reason TEXT,
      next_action TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT;`);
    db.close();

    const repository = new SqliteDeploymentOperationRepository(dbPath);
    const status: DeploymentStatus = { ...deployment('dep-upgrade'), lastOperationId: unknown('legacy-row', '2026-08-27T03:04:05.000Z') };
    await repository.saveDeployment(status);
    expect(await repository.findDeployment(status.deploymentId)).toEqual(status);
    repository.close();
    rmSync(directory, { recursive: true, force: true });
  });

  test('reopening a migrated database is idempotent', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'configs-status-'));
    const dbPath = join(directory, 'state.sqlite3');
    const first = new SqliteDeploymentOperationRepository(dbPath);
    await first.saveDeployment(deployment('dep-reopen'));
    first.close();
    const second = new SqliteDeploymentOperationRepository(dbPath);
    expect(await second.findDeployment('dep-reopen')).toEqual(deployment('dep-reopen'));
    second.close();
    rmSync(directory, { recursive: true, force: true });
  });
  test('rejects empty ids, unknown phases, and unknown last-operation facts', async () => {
    const repository = new SqliteDeploymentOperationRepository(':memory:');
    await expect(repository.saveDeployment({ ...deployment(''), deploymentId: '' })).rejects.toThrow('invalid deployment status');
    await expect(repository.saveDeployment({ ...deployment('dep-1'), phase: 'not-a-phase' as DeploymentStatus['phase'] })).rejects.toThrow('invalid deployment status');
    await expect(repository.saveDeployment({ ...deployment('dep-1'), lastOperationId: unknown('not-recorded', 'now') })).resolves.toBeUndefined();
    repository.close();
  });
});
