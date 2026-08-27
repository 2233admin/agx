import { describe, expect, test } from 'bun:test';

import { prepareDeploymentPlan, type DeploymentPreflightInput, type DeploymentPreflightPorts } from '../../src/application/deployment-preflight';
import type { ConfigRevisionRepository, GithubProjectPort, GithubRepositoryPort, MulticaRuntimePort, ProviderInventoryPort } from '../../src/application/ports';
import type { StableConfigRevision } from '../../src/domain/config';
import type { GithubProjectTarget } from '../../src/domain/github-project';
import type { GithubRepositoryTarget } from '../../src/domain/github-repository';
import type { MulticaSubject } from '../../src/domain/multica';
import type { ProviderInventoryResult } from '../../src/domain/provider';
import { InMemoryOperationJournal } from '../../src/adapters/operation/in-memory-journal';

const REVISION_ID = 'rev-1';
const REPOSITORIES: GithubRepositoryTarget[] = [
  { owner: 'octocat', name: 'z-repo', visibility: 'private', description: '', sourcePath: 'C:/z', initialRevision: { commit: 'a'.repeat(40), templateVersion: 'v1', templateDigest: 'b'.repeat(64), requiredPaths: ['README.md'] } },
  { owner: 'octocat', name: 'a-repo', visibility: 'private', description: '', sourcePath: 'C:/a', initialRevision: { commit: 'c'.repeat(40), templateVersion: 'v1', templateDigest: 'd'.repeat(64), requiredPaths: ['README.md'] } },
];
const PROJECT: GithubProjectTarget = { owner: 'octocat', title: 'Agent System', visibility: 'private', linkedRepository: 'octocat/a-repo', installationId: 'install-0123456789abcdef' };
const PROVIDERS = [
  { provider: 'claude', marketplaceSource: 'C:/agent-plugins', plugins: [{ name: 'review', version: '1.0.0', enabled: true }] },
  { provider: 'codex', marketplaceSource: 'C:/agent-plugins', plugins: [{ name: 'grill', version: '1.0.0', enabled: true }] },
] as const;
const RUNTIME: MulticaSubject = { kind: 'runtime', id: 'd3baaa7b-1111-4111-8111-111111111111' };

function input(overrides: Partial<DeploymentPreflightInput> = {}): DeploymentPreflightInput {
  return { deploymentId: 'dep-1', operationId: 'op-1', revisionId: REVISION_ID, repositories: REPOSITORIES, project: PROJECT, providers: PROVIDERS, multicaSubjects: [RUNTIME], ...overrides };
}
function readyPorts(calls: string[] = []): DeploymentPreflightPorts {
  const revision: ConfigRevisionRepository = { listAll: async () => [], findById: async () => ({ configName: 'general' } as unknown as StableConfigRevision) };
  const repositories: GithubRepositoryPort = { preflight: async (target) => { calls.push(`repo:${target.name}`); return { kind: 'ready' }; }, readback: async () => ({ kind: 'absent' }), provision: async () => { throw new Error('mutation must not run'); } };
  const project: GithubProjectPort = { preflight: async () => { calls.push('project'); return { kind: 'ready' }; }, readback: async () => ({ kind: 'absent' }), provision: async () => { throw new Error('mutation must not run'); } };
  const providers: ProviderInventoryPort = { inspect: async (provider) => { calls.push('provider'); return { kind: 'observed', inventory: { provider: provider ?? 'codex', marketplace: { present: false, sourceType: null, source: null }, plugins: [] } }; } };
  const multica: MulticaRuntimePort = { readback: async () => ({ kind: 'observed', subject: RUNTIME, runtime: { id: RUNTIME.id, name: 'runtime', status: 'online' } }) };
  return { revision, repositories, project, providers, multica };
}

describe('prepareDeploymentPlan preflight', () => {
  test('runs all read-only preflights before persisting a ready deterministic plan', async () => {
    const calls: string[] = [];
    const result = await prepareDeploymentPlan(new InMemoryOperationJournal(), input(), readyPorts(calls));
    expect(result.kind).toBe('ready');
    expect(result.remoteRetention).toBe('retain');
    expect(result.plan.steps.map((step) => `${step.kind}:${step.resource}`)).toEqual([
      'github-repository:a-repo', 'github-repository:z-repo', 'github-project:Agent-System', 'provider-activation:claude', 'provider-activation:codex',
    ]);
    expect(calls).toEqual(['repo:a-repo', 'repo:z-repo', 'project', 'provider', 'provider']);
  });

  test('collision blocks without invoking any mutation port', async () => {
    const calls: string[] = [];
    const ports = { ...readyPorts(calls) };
    ports.repositories = { ...ports.repositories, preflight: async () => ({ kind: 'collision', ownership: 'pre-existing', repository: {} as never }) };
    const result = await prepareDeploymentPlan(new InMemoryOperationJournal(), input(), ports);
    expect(result.kind).toBe('blocked');
    expect(result.blockers[0]?.reason).toBe('repository-collision');
    expect(result.plan.phase).toBe('prepared');
    expect(calls).toEqual(['project', 'provider', 'provider']);
  });

  test('inconclusive provider and missing config remain blocked with retained remote state', async () => {
    const calls: string[] = [];
    const ports = { ...readyPorts(calls) };
    ports.revision = { listAll: async () => [], findById: async () => null };
    ports.providers = { inspect: async (): Promise<ProviderInventoryResult> => ({ kind: 'inconclusive', reason: 'provider-timeout' }) };
    const result = await prepareDeploymentPlan(new InMemoryOperationJournal(), input(), ports);
    expect(result.kind).toBe('blocked');
    expect(result.remoteRetention).toBe('retain');
    expect(result.blockers.map((blocker) => blocker.reason)).toEqual(['configuration-revision-missing', 'provider-inconclusive', 'provider-inconclusive']);
    expect(calls).toEqual(['repo:a-repo', 'repo:z-repo', 'project']);
  });

  test('same inputs produce byte-stable plans and Multica failures are read-only blockers', async () => {
    const ports = { ...readyPorts() };
    ports.multica = { readback: async () => ({ kind: 'offline', subject: RUNTIME, status: 'offline' }) };
    const first = await prepareDeploymentPlan(new InMemoryOperationJournal(), input(), ports);
    const second = await prepareDeploymentPlan(new InMemoryOperationJournal(), input(), ports);
    expect(JSON.stringify(first.plan)).toBe(JSON.stringify(second.plan));
    expect(first.kind).toBe('blocked');
    expect(first.blockers.some((blocker) => blocker.reason === 'multica-offline')).toBe(true);
  });
});
