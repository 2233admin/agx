import { describe, expect, test } from 'bun:test';

import { InMemoryOperationJournal } from '../../src/adapters/operation/in-memory-journal';
import { prepareDeploymentOperationPlan } from '../../src/application/operation-plan';
import { applyDeploymentPlan, type DeploymentApplyTargets } from '../../src/application/deployment-apply';
import type { GithubProjectPort, GithubRepositoryPort, OperationJournalPort, ProviderActivationPort } from '../../src/application/ports';
import type { OperationPlanInput } from '../../src/domain/operation-journal';

const REPO = { owner: 'octocat', name: 'agent-control', visibility: 'private', description: '', sourcePath: 'C:/source', initialRevision: { commit: 'a'.repeat(40), templateVersion: 'v1', templateDigest: 'b'.repeat(64), requiredPaths: ['README.md'] } } as const;
const PROJECT = { owner: 'octocat', title: 'Agent System', visibility: 'private', linkedRepository: 'octocat/agent-control', installationId: 'install-0123456789abcdef' } as const;
const PROVIDER = { provider: 'codex', marketplaceSource: 'C:/agent-plugins', plugins: [{ name: 'grilling', version: '1.2.3', enabled: true }] } as const;
const PLAN: OperationPlanInput = { deploymentId: 'dep-apply', operationId: 'op-apply', revisionId: 'rev-apply', steps: [
  { kind: 'github-repository', resource: 'octocat/agent-control' },
  { kind: 'github-project', resource: PROJECT.installationId },
  { kind: 'provider-activation', resource: 'codex' },
] };

function targets(): DeploymentApplyTargets {
  return { repositories: new Map([[`${REPO.owner}/${REPO.name}`, REPO]]), project: PROJECT, providers: new Map([[PROVIDER.provider, PROVIDER]]) };
}
function repoCreated() { return { kind: 'created' as const, repository: { nameWithOwner: 'octocat/agent-control', url: 'https://github.com/octocat/agent-control', visibility: 'private' as const, hasIssues: true, defaultBranch: 'main', headCommit: REPO.initialRevision.commit, initialCommit: REPO.initialRevision.commit }, ownership: 'created-by-configs' as const, initialRevision: REPO.initialRevision, binding: { kind: 'github-repository' as const, resourceId: 'octocat/agent-control', ownership: 'unknown' as const, remoteIdentity: 'https://github.com/octocat/agent-control', destructiveActions: 'denied' as const } }; }
function projectCreated() { return { kind: 'created' as const, identity: { owner: 'octocat', number: 7, nodeId: 'PVT_1', url: 'https://github.com/users/octocat/projects/7', title: PROJECT.title, visibility: 'private' as const }, ownership: 'created-by-configs' as const, linked: true as const, binding: { kind: 'github-project' as const, resourceId: 'PVT_1', ownership: 'unknown' as const, remoteIdentity: 'https://github.com/users/octocat/projects/7', destructiveActions: 'denied' as const } }; }
function providerCreated() { return { kind: 'activated' as const, inventory: { provider: 'codex' as const, marketplace: { present: true, sourceType: 'local', source: PROVIDER.marketplaceSource }, plugins: [{ name: 'grilling', version: '1.2.3', enabled: true }] }, ownership: { marketplace: 'created-by-configs' as const, marketplaceSource: PROVIDER.marketplaceSource, plugins: [{ name: 'grilling', version: '1.2.3', source: PROVIDER.marketplaceSource }] } }; }
function readyDeps(order: string[] = []) {
  const repositories: GithubRepositoryPort = { preflight: async () => ({ kind: 'ready' }), provision: async () => { order.push('repo-provision'); return repoCreated(); }, readback: async () => { order.push('repo-readback'); return { kind: 'present', repository: repoCreated().repository }; } };
  const project: GithubProjectPort = { preflight: async () => ({ kind: 'ready' }), provision: async () => { order.push('project-provision'); return projectCreated(); }, readback: async () => { order.push('project-readback'); return { kind: 'present', identity: projectCreated().identity, hasIssues: true, linked: true }; } };
  const provider: ProviderActivationPort = { activate: async () => { order.push('provider'); return providerCreated(); }, revoke: async () => ({ kind: 'preserved', reason: 'marketplace-pre-existing' }) };
  return { repositories, project, provider };
}

async function prepared(journal: OperationJournalPort): Promise<void> { await prepareDeploymentOperationPlan(journal, PLAN); }

describe('applyDeploymentPlan', () => {
  test('starts prepared operation, applies repo/readback then Project/readback then Provider, and finishes succeeded', async () => {
    const journal = new InMemoryOperationJournal(); await prepared(journal); const order: string[] = [];
    const result = await applyDeploymentPlan(journal, 'op-apply', targets(), readyDeps(order));
    expect(order).toEqual(['repo-provision', 'repo-readback', 'project-provision', 'project-readback', 'provider']);
    expect(result.operation?.phase).toBe('succeeded');
    expect(result.operation?.phase).not.toBe('verified');
    expect(result.remoteRetention).toBe('retain');
  });

  test('collision or inconclusive stops later steps and retains remote resources', async () => {
    const journal = new InMemoryOperationJournal(); await prepared(journal); const order: string[] = [];
    const deps = readyDeps(order); deps.repositories = { ...deps.repositories, provision: async () => { order.push('repo-provision'); return { kind: 'collision', ownership: 'pre-existing', repository: repoCreated().repository }; } };
    const collision = await applyDeploymentPlan(journal, 'op-apply', targets(), deps);
    expect(collision.operation?.phase).toBe('needs-manual-cleanup');

    const second = new InMemoryOperationJournal(); await prepared(second); const order2: string[] = []; const deps2 = readyDeps(order2);
    deps2.repositories = { ...deps2.repositories, provision: async () => { order2.push('repo-provision'); return { kind: 'inconclusive', stage: 'readback', reason: 'timeout', remoteRetention: 'retain' }; } };
    const uncertain = await applyDeploymentPlan(second, 'op-apply', targets(), deps2);
    expect(uncertain.operation?.phase).toBe('inconclusive');
  });

  test('resumes an already applying operation by identity and does not repeat completed steps', async () => {
    const journal = new InMemoryOperationJournal(); await prepared(journal); await journal.start('op-apply');
    await journal.appendStep('op-apply', { sequence: 1, kind: 'github-repository', resource: 'octocat/agent-control', phase: 'succeeded' });
    const order: string[] = []; const result = await applyDeploymentPlan(journal, 'op-apply', targets(), readyDeps(order));
    expect(order).toEqual(['project-provision', 'project-readback', 'provider']); expect(result.operation?.phase).toBe('succeeded');
  });

  test('readback mismatch becomes inconclusive before Provider activation', async () => {
    const journal = new InMemoryOperationJournal(); await prepared(journal); const order: string[] = []; const deps = readyDeps(order);
    deps.project = { ...deps.project, readback: async () => { order.push('project-readback'); return { kind: 'inconclusive', reason: 'link-missing', remoteRetention: 'retain' }; } };
    const result = await applyDeploymentPlan(journal, 'op-apply', targets(), deps);
    expect(result.operation?.phase).toBe('inconclusive');
  });
});
