import { expect, test } from 'bun:test';
import { loadStatusProjection } from '../../src/application/status';
import { known } from '../../src/domain/facts';
import type { StableConfigRevision } from '../../src/domain/config';

const revision = { configName: 'default', revisionId: 'rev-bound', defaultMarker: known(true), scopeBoundary: known('project'), availability: known('resolved'), instructions: [], skills: [], mcp: [], hooks: [], plugins: [], triggerCategory: 'new-scenario' as const, evidenceRef: 'fixture', supersedesRevisionId: null } as unknown as StableConfigRevision;
const deployment = { deploymentId: 'dep-bound', phase: 'configured' as const, lastOperationId: known('op-bound'), reason: null, nextAction: 'none' };

test('loadStatusProjection reads the exact operation-bound revision and rejects a missing binding', async () => {
  const calls: string[] = [];
  const deps = { configRepository: { listAll: async () => [], findById: async (id: string) => { calls.push(id); return id === 'rev-bound' ? revision : null; } }, deploymentRepository: { findDeployment: async () => deployment }, operationJournal: { find: async () => ({ operationId: 'op-bound', deploymentId: 'dep-bound', revisionId: 'rev-bound', phase: 'succeeded' as const, steps: [], remoteRetention: 'retain' as const, nextAction: 'none' }) }, launchPlanRepository: {} as never };
  const bound = await loadStatusProjection(deps, { deploymentId: 'dep-bound', operationId: 'op-bound' });
  expect(bound?.activeRevision).toEqual({ kind: 'known', value: revision }); expect(calls).toEqual(['rev-bound']);
  const missing = await loadStatusProjection({ ...deps, operationJournal: { find: async () => ({ operationId: 'op-bound', deploymentId: 'dep-bound', revisionId: 'missing', phase: 'succeeded' as const, steps: [], remoteRetention: 'retain' as const, nextAction: 'none' }) } }, { deploymentId: 'dep-bound', operationId: 'op-bound' });
  expect(missing?.activeRevision.kind).toBe('unknown');
});
