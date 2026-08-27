import { describe, expect, test } from 'bun:test';
import { InMemoryOperationJournal } from '../../src/adapters/operation/in-memory-journal';
import { prepareDeploymentOperationPlan } from '../../src/application/operation-plan';
import { applyDeploymentPlan, recoverDeploymentOperation, resolveDeploymentOperation, type DeploymentApplyTargets } from '../../src/application/deployment-apply';
import type { OperationPlanInput } from '../../src/domain/operation-journal';
import type { GithubProjectPort, GithubRepositoryPort, OperationJournalPort, ProviderActivationPort } from '../../src/application/ports';

const repo = { owner: 'octocat', name: 'agent-control', visibility: 'private', description: '', sourcePath: 'C:/source', initialRevision: { commit: 'a'.repeat(40), templateVersion: 'v1', templateDigest: 'b'.repeat(64), requiredPaths: ['README.md'] } } as const;
const project = { owner: 'octocat', title: 'Agent System', visibility: 'private', linkedRepository: 'octocat/agent-control', installationId: 'install-0123456789abcdef' } as const;
const provider = { provider: 'codex', marketplaceSource: 'C:/agent-plugins', plugins: [{ name: 'grilling', version: '1.2.3', enabled: true }] } as const;
const plan: OperationPlanInput = { deploymentId: 'dep-recovery', operationId: 'op-recovery', steps: [{ kind: 'github-repository', resource: 'octocat/agent-control' }, { kind: 'github-project', resource: project.installationId }, { kind: 'provider-activation', resource: provider.provider }] };
const targets: DeploymentApplyTargets = { repositories: new Map([['octocat/agent-control', repo]]), project, providers: new Map([['codex', provider]]) };
const repoResult = { kind: 'created' as const, repository: { nameWithOwner: 'octocat/agent-control', url: 'https://github.com/octocat/agent-control', visibility: 'private' as const, hasIssues: true, defaultBranch: 'main', headCommit: repo.initialRevision.commit, initialCommit: repo.initialRevision.commit }, ownership: 'created-by-configs' as const, initialRevision: repo.initialRevision, binding: { kind: 'github-repository' as const, resourceId: 'octocat/agent-control', ownership: 'unknown' as const, remoteIdentity: 'https://github.com/octocat/agent-control', destructiveActions: 'denied' as const } };
const projectResult = { kind: 'created' as const, identity: { owner: 'octocat', number: 7, nodeId: 'PVT_1', url: 'https://github.com/users/octocat/projects/7', title: project.title, visibility: 'private' as const }, ownership: 'created-by-configs' as const, linked: true as const, binding: { kind: 'github-project' as const, resourceId: 'PVT_1', ownership: 'unknown' as const, remoteIdentity: 'https://github.com/users/octocat/projects/7', destructiveActions: 'denied' as const } };
function deps(order: string[]) {
  const repositories: GithubRepositoryPort = { preflight: async () => ({ kind: 'ready' }), provision: async () => { order.push('repo'); return repoResult; }, readback: async () => { order.push('repo-readback'); return { kind: 'present', repository: repoResult.repository }; } };
  const projects: GithubProjectPort = { preflight: async () => ({ kind: 'ready' }), provision: async () => { order.push('project'); return projectResult; }, readback: async () => { order.push('project-readback'); return { kind: 'present', identity: projectResult.identity, hasIssues: true, linked: true }; } };
  const providers: ProviderActivationPort = { activate: async () => { order.push('provider'); return { kind: 'activated', inventory: { provider: 'codex', marketplace: { present: true, sourceType: 'local', source: provider.marketplaceSource }, plugins: provider.plugins }, ownership: { marketplace: 'created-by-configs', marketplaceSource: provider.marketplaceSource, plugins: [{ name: 'grilling', version: '1.2.3', source: provider.marketplaceSource }] } }; }, revoke: async () => ({ kind: 'preserved', reason: 'marketplace-pre-existing' }) };
  return { repositories, project: projects, provider: providers };
}
async function prepared(journal: OperationJournalPort) { await prepareDeploymentOperationPlan(journal, plan); }

describe('recoverDeploymentOperation', () => {
  test('recovers prepared/interrupted operations by identity without repeating succeeded steps', async () => {
    const journal = new InMemoryOperationJournal(); await prepared(journal); await journal.start('op-recovery'); await journal.appendStep('op-recovery', { sequence: 1, kind: 'github-repository', resource: 'octocat/agent-control', phase: 'succeeded' });
    const order: string[] = []; const result = await recoverDeploymentOperation(journal, 'op-recovery', 'dep-recovery', targets, deps(order));
    expect(order).toEqual(['project', 'project-readback', 'provider']); expect(result.operation?.phase).toBe('succeeded');
    const retryOrder: string[] = []; const retry = await recoverDeploymentOperation(journal, 'op-recovery', 'dep-recovery', targets, deps(retryOrder));
    expect(retry.operation?.phase).toBe('succeeded'); expect(retryOrder).toEqual([]);
  });
  test('returns terminal inconclusive or manual-cleanup states without retrying uncertain mutations', async () => {
    const inconclusive = new InMemoryOperationJournal(); await prepared(inconclusive); const uncertainDeps = deps([]); uncertainDeps.repositories = { ...uncertainDeps.repositories, provision: async () => ({ kind: 'inconclusive', stage: 'readback', reason: 'timeout', remoteRetention: 'retain' }) }; await applyDeploymentPlan(inconclusive, 'op-recovery', targets, uncertainDeps); const order: string[] = [];
    const uncertain = await recoverDeploymentOperation(inconclusive, 'op-recovery', 'dep-recovery', targets, deps(order)); expect(uncertain.operation?.phase).toBe('inconclusive'); expect(order).toEqual([]);
    const manual = new InMemoryOperationJournal(); await prepared(manual); const collisionDeps = deps([]); collisionDeps.repositories = { ...collisionDeps.repositories, provision: async () => ({ kind: 'collision', ownership: 'pre-existing', repository: repoResult.repository }) }; await applyDeploymentPlan(manual, 'op-recovery', targets, collisionDeps); const manualResult = await recoverDeploymentOperation(manual, 'op-recovery', 'dep-recovery', targets, deps(order)); expect(manualResult.operation?.phase).toBe('needs-manual-cleanup'); expect(order).toEqual([]);
  });
  test('refuses operation/deployment identity mismatch and leaves journal unchanged', async () => {
    const journal = new InMemoryOperationJournal(); await prepared(journal); const order: string[] = []; const result = await recoverDeploymentOperation(journal, 'op-recovery', 'wrong-deployment', targets, deps(order));
    expect(result.kind).toBe('blocked'); expect(result.nextAction).toBe('operation-identity-mismatch'); expect(order).toEqual([]); expect((await journal.find('op-recovery'))?.phase).toBe('prepared');
  });
  test('rejects any attempt to append a verified recovery step', async () => {
    const journal = new InMemoryOperationJournal(); await prepared(journal);
    await expect(journal.appendStep('op-recovery', { sequence: 1, kind: 'github-repository', resource: 'octocat/agent-control', phase: 'verified' as never })).rejects.toThrow('verified requires evaluator-approved evidence');
  });
  test('requires exact structured readback before resuming an inconclusive operation', async () => {
    const journal = new InMemoryOperationJournal();
    await prepared(journal);
    const collisionDeps = deps([]);
    collisionDeps.repositories = { ...collisionDeps.repositories, provision: async () => ({ kind: 'inconclusive', stage: 'readback', reason: 'timeout', remoteRetention: 'retain' }) };
    await applyDeploymentPlan(journal, 'op-recovery', targets, collisionDeps);
    const resolution = {
      operationId: 'op-recovery', deploymentId: 'dep-recovery', sequence: 1,
      kind: 'github-repository' as const, resource: 'octocat/agent-control',
      outcome: 'matched' as const, fingerprint: 'a'.repeat(64), observedAt: '2026-08-27T00:00:00Z',
    };
    await expect(recoverDeploymentOperation(journal, 'op-recovery', 'dep-recovery', targets, deps([]))).resolves.toMatchObject({ kind: 'inconclusive' });
    await expect(journal.resolveInconclusive('op-recovery', { ...resolution, operationId: 'wrong' }, '2026-08-27T00:00:01Z')).rejects.toThrow('invalid operation resolution');
    const resumed = await resolveDeploymentOperation(journal, 'op-recovery', 'dep-recovery', resolution, '2026-08-27T00:00:01Z');
    expect(resumed.operation?.phase).toBe('needs-resume');
    expect(resumed.operation?.nextAction).toBe('resume-operation');
    expect(resumed.remoteRetention).toBe('retain');
  });
  test('rejects stale and future resolutions without persisting them', async () => {
    for (const observedAt of ['2026-08-26T23:00:00.000Z', '2026-08-26T23:45:01.000Z', '2026-08-27T00:00:02.000Z']) {
      const journal = new InMemoryOperationJournal(); await prepared(journal); const uncertainDeps = deps([]);
      uncertainDeps.repositories = { ...uncertainDeps.repositories, provision: async () => ({ kind: 'inconclusive', stage: 'readback', reason: 'timeout', remoteRetention: 'retain' }) };
      await applyDeploymentPlan(journal, 'op-recovery', targets, uncertainDeps);
      const resolution = { operationId: 'op-recovery', deploymentId: 'dep-recovery', sequence: 1, kind: 'github-repository' as const, resource: 'octocat/agent-control', outcome: 'matched' as const, fingerprint: 'a'.repeat(64), observedAt };
      await expect(resolveDeploymentOperation(journal, 'op-recovery', 'dep-recovery', resolution, '2026-08-27T00:00:01.000Z')).rejects.toThrow('invalid operation resolution');
      expect((await journal.find('op-recovery'))?.resolutions).toEqual([]);
    }
  });
  test('apply retries the resolved inconclusive step before later planned steps', async () => {
    const journal = new InMemoryOperationJournal(); await prepared(journal); const order: string[] = []; const first = deps(order); let attempts = 0;
    first.repositories = { ...first.repositories, provision: async () => { order.push('repo'); attempts += 1; return attempts === 1 ? { kind: 'inconclusive', stage: 'readback', reason: 'timeout', remoteRetention: 'retain' } : repoResult; } };
    await applyDeploymentPlan(journal, 'op-recovery', targets, first);
    await resolveDeploymentOperation(journal, 'op-recovery', 'dep-recovery', { operationId: 'op-recovery', deploymentId: 'dep-recovery', sequence: 1, kind: 'github-repository', resource: 'octocat/agent-control', outcome: 'matched', fingerprint: 'a'.repeat(64), observedAt: '2026-08-27T00:00:00Z' }, '2026-08-27T00:00:01Z');
    const resumed = await applyDeploymentPlan(journal, 'op-recovery', targets, deps(order));
    expect(resumed.operation?.phase).toBe('succeeded');
    expect(order).toEqual(['repo', 'repo', 'repo-readback', 'project', 'project-readback', 'provider']);
  });
});
