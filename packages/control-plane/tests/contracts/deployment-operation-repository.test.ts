import { describe, expect, test } from 'bun:test';
import { known, unknown } from '../../src/domain/facts';
import type { DeploymentStatus } from '../../src/domain/deployment';
import type { OperationStatus } from '../../src/domain/operation';
import { SqliteDeploymentOperationRepository } from '../../src/adapters/sqlite/deployment-operation-repository';

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

  test('rejects empty ids, unknown phases, and unknown last-operation facts', async () => {
    const repository = new SqliteDeploymentOperationRepository(':memory:');
    await expect(repository.saveDeployment({ ...deployment(''), deploymentId: '' })).rejects.toThrow('invalid deployment status');
    await expect(repository.saveDeployment({ ...deployment('dep-1'), phase: 'not-a-phase' as DeploymentStatus['phase'] })).rejects.toThrow('invalid deployment status');
    await expect(repository.saveDeployment({ ...deployment('dep-1'), lastOperationId: unknown('not-recorded', 'now') })).resolves.toBeUndefined();
    repository.close();
  });
});
