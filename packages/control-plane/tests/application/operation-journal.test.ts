import { describe, expect, test } from 'bun:test';

import { InMemoryOperationJournal } from '../../src/adapters/operation/in-memory-journal';
import { prepareDeploymentOperationPlan } from '../../src/application/operation-plan';
import type { OperationStep } from '../../src/domain/operation-journal';

const PLAN = {
  deploymentId: 'dep-1', operationId: 'op-1',
  steps: [
    { kind: 'github-repository', resource: 'agent-control' },
    { kind: 'github-project', resource: 'Agent System' },
    { kind: 'provider-activation', resource: 'codex' },
  ] as const,
};

describe('safe operation journal seam', () => {
  test('prepare is deterministic, ordered, append-only, and performs no remote work', async () => {
    const journal = new InMemoryOperationJournal();
    const prepared = await prepareDeploymentOperationPlan(journal, PLAN);

    expect(prepared.phase).toBe('prepared');
    expect(prepared.remoteRetention).toBe('retain');
    expect(prepared.steps).toEqual([
      { sequence: 1, kind: 'github-repository', resource: 'agent-control', phase: 'pending' },
      { sequence: 2, kind: 'github-project', resource: 'Agent System', phase: 'pending' },
      { sequence: 3, kind: 'provider-activation', resource: 'codex', phase: 'pending' },
    ]);
    expect(journal.remoteCalls).toBe(0);
  });

  test('only the next pending step can be appended and previous entries cannot be overwritten', async () => {
    const journal = new InMemoryOperationJournal();
    const prepared = await prepareDeploymentOperationPlan(journal, PLAN);
    const step: OperationStep = { sequence: 1, kind: 'github-repository', resource: 'agent-control', phase: 'succeeded' };
    const updated = await journal.appendStep('op-1', step);

    expect(updated.steps[0]).toEqual(step);
    await expect(journal.appendStep('op-1', step)).rejects.toThrow('operation step sequence is not append-only');
    await expect(journal.appendStep('op-1', { sequence: 3, kind: 'provider-activation', resource: 'codex', phase: 'succeeded' })).rejects.toThrow('operation step sequence is not append-only');
    expect(prepared.steps[0]?.phase).toBe('pending');
  });

  test('inconclusive and manual-cleanup steps remain non-verified and retain remote resources', async () => {
    const journal = new InMemoryOperationJournal();
    await prepareDeploymentOperationPlan(journal, PLAN);
    const inconclusive = await journal.appendStep('op-1', { sequence: 1, kind: 'github-repository', resource: 'agent-control', phase: 'inconclusive', reason: 'readback-timeout' });
    expect(inconclusive.phase).toBe('inconclusive');
    expect(inconclusive.nextAction).toBe('observe-remote-state');
    const cleanup = await journal.appendStep('op-1', { sequence: 2, kind: 'github-project', resource: 'Agent System', phase: 'needs-manual-cleanup', reason: 'collision-after-create' });
    expect(cleanup.phase).toBe('needs-manual-cleanup');
    expect(cleanup.nextAction).toBe('manual-cleanup');
    await expect(journal.appendStep('op-1', { sequence: 3, kind: 'provider-activation', resource: 'codex', phase: 'verified' as never })).rejects.toThrow('verified requires evaluator-approved evidence');
  });
});
