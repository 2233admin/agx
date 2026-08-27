import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { SqliteOperationJournal } from '../../src/adapters/sqlite/operation-journal';
import { prepareDeploymentOperationPlan } from '../../src/application/operation-plan';

const INPUT = {
  deploymentId: 'dep-sqlite', operationId: 'op-sqlite', steps: [
    { kind: 'github-repository', resource: 'agent-control' },
    { kind: 'github-project', resource: 'agent-system' },
    { kind: 'provider-activation', resource: 'codex' },
  ] as const,
};

let roots: string[] = [];
afterEach(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); roots = []; });
function journal(): { root: string; value: SqliteOperationJournal } {
  const root = mkdtempSync(path.join(tmpdir(), 'operation-journal-'));
  roots.push(root);
  return { root, value: new SqliteOperationJournal(path.join(root, 'state.sqlite3'), () => '2026-08-27T00:00:00.000Z') };
}

describe('SqliteOperationJournal', () => {
  test('persists a prepared plan across close and reopen', async () => {
    const { root, value } = journal();
    const prepared = await prepareDeploymentOperationPlan(value, INPUT);
    value.close();
    const reopened = new SqliteOperationJournal(path.join(root, 'state.sqlite3'), () => '2026-08-27T00:00:01.000Z');
    expect(await reopened.find('op-sqlite')).toEqual(prepared);
    reopened.close();
  });

  test('appends ordered transitions without changing planned identity', async () => {
    const { value } = journal();
    await prepareDeploymentOperationPlan(value, INPUT);
    const succeeded = await value.appendStep('op-sqlite', { sequence: 1, kind: 'github-repository', resource: 'agent-control', phase: 'succeeded' });
    expect(succeeded.steps[0]?.phase).toBe('succeeded');
    await expect(value.appendStep('op-sqlite', { sequence: 3, kind: 'provider-activation', resource: 'codex', phase: 'succeeded' })).rejects.toThrow('operation step sequence is not append-only');
    await expect(value.appendStep('op-sqlite', { sequence: 2, kind: 'github-repository', resource: 'wrong', phase: 'succeeded' })).rejects.toThrow('operation step does not match plan');
    await expect(value.appendStep('op-sqlite', { sequence: 1, kind: 'github-repository', resource: 'agent-control', phase: 'succeeded' })).rejects.toThrow('operation step sequence is not append-only');
    value.close();
  });

  test('migration is idempotent and duplicate prepare cannot overwrite the plan', async () => {
    const { root, value } = journal();
    await prepareDeploymentOperationPlan(value, INPUT);
    value.close();
    const reopened = new SqliteOperationJournal(path.join(root, 'state.sqlite3'), () => '2026-08-27T00:00:02.000Z');
    await expect(prepareDeploymentOperationPlan(reopened, { ...INPUT, steps: [{ kind: 'github-repository', resource: 'other' }] })).rejects.toThrow('operation already prepared');
    expect((await reopened.find('op-sqlite'))?.steps[0]?.resource).toBe('agent-control');
    reopened.close();
  });
  test('replay binds operation identity to deployment and reads every persisted operation phase', async () => {
    const { root, value } = journal();
    await prepareDeploymentOperationPlan(value, INPUT);
    await expect(prepareDeploymentOperationPlan(value, { ...INPUT, deploymentId: 'dep-other' })).rejects.toThrow('operation belongs to another deployment');
    const db = new Database(path.join(root, 'state.sqlite3'));
    db.query('UPDATE operation_status SET phase = ?, next_action = ? WHERE operation_id = ?').run('succeeded', 'none', 'op-sqlite');
    db.close();
    expect((await value.find('op-sqlite'))?.phase).toBe('succeeded');
    value.close();
  });

  test('rejects a new operation when the deployment is already applying', async () => {
    const { root, value } = journal();
    await prepareDeploymentOperationPlan(value, INPUT);
    value.close();
    const db = new Database(path.join(root, 'state.sqlite3'));
    db.query('UPDATE deployment_status SET phase = ? WHERE deployment_id = ?').run('applying', 'dep-sqlite');
    db.close();
    const reopened = new SqliteOperationJournal(path.join(root, 'state.sqlite3'), () => '2026-08-27T00:00:03.000Z');
    await expect(prepareDeploymentOperationPlan(reopened, { ...INPUT, operationId: 'op-new' })).rejects.toThrow('deployment is not plan-ready');
    reopened.close();
  });
  test('atomically persists a matched resolution with the resolved step reset to pending', async () => {
    const { root, value } = journal();
    await prepareDeploymentOperationPlan(value, INPUT);
    await value.start('op-sqlite');
    await value.appendStep('op-sqlite', { sequence: 1, kind: 'github-repository', resource: 'agent-control', phase: 'inconclusive', reason: 'readback-timeout' });
    const resolved = await value.resolveInconclusive('op-sqlite', { operationId: 'op-sqlite', deploymentId: 'dep-sqlite', sequence: 1, kind: 'github-repository', resource: 'agent-control', outcome: 'matched', fingerprint: 'a'.repeat(64), observedAt: '2026-08-27T00:00:00.000Z' });
    expect(resolved.steps[0]?.phase).toBe('pending');
    value.close();
    const reopened = new SqliteOperationJournal(path.join(root, 'state.sqlite3'), () => '2026-08-27T00:00:01.000Z');
    expect((await reopened.find('op-sqlite'))?.steps[0]?.phase).toBe('pending');
    reopened.close();
  });
});
