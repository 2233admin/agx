import { afterEach, describe, expect, test } from 'bun:test';
import { main } from '../../src/cli/index';
import { InMemoryOperationJournal } from '../../src/adapters/operation/in-memory-journal';
import { prepareDeploymentOperationPlan } from '../../src/application/operation-plan';
import type { DeploymentApplyTargets } from '../../src/application/deployment-apply';
import type { DeploymentPreflightPorts } from '../../src/application/deployment-preflight';
import type { ConfigRevisionRepository, GithubProjectPort, GithubRepositoryPort, ProviderActivationPort, ProviderInventoryPort } from '../../src/application/ports';
import type { OperationPlanInput } from '../../src/domain/operation-journal';

const repo = { owner: 'octocat', name: 'agent-control', visibility: 'private', description: '', sourcePath: 'C:/template', initialRevision: { commit: 'a'.repeat(40), templateVersion: 'v1', templateDigest: 'b'.repeat(64), requiredPaths: ['README.md'] } } as const;
const project = { owner: 'octocat', title: 'Agent System', visibility: 'private', linkedRepository: 'octocat/agent-control', installationId: 'install-0123456789abcdef' } as const;
const provider = { provider: 'codex', marketplaceSource: 'C:/plugins', plugins: [] } as const;
const plan: OperationPlanInput = { deploymentId: 'dep-init', operationId: 'op-init', steps: [{ kind: 'github-repository', resource: 'octocat/agent-control' }, { kind: 'github-project', resource: project.installationId }, { kind: 'provider-activation', resource: 'codex' }] };
let output: string[] = [];
afterEach(() => { output = []; });
function capture() { const old = console.log; console.log = (...args: unknown[]) => output.push(args.map(String).join(' ')); return () => { console.log = old; }; }
function adapters(order: string[], counters: { remote: number }): { preflight: DeploymentPreflightPorts; targets: DeploymentApplyTargets } {
  const repoPort: GithubRepositoryPort = { preflight: async () => ({ kind: 'ready' }), provision: async () => { counters.remote += 1; order.push('repo'); return { kind: 'inconclusive', stage: 'readback', reason: 'fixture', remoteRetention: 'retain' }; }, readback: async () => { counters.remote += 1; order.push('repo-readback'); return { kind: 'present', repository: { nameWithOwner: 'octocat/agent-control', url: 'https://github.com/octocat/agent-control', visibility: 'private' as const, hasIssues: true, defaultBranch: 'main', headCommit: repo.initialRevision.commit, initialCommit: repo.initialRevision.commit } }; } };
  const projectPort: GithubProjectPort = { preflight: async () => ({ kind: 'ready' }), provision: async () => { counters.remote += 1; order.push('project'); return { kind: 'inconclusive', stage: 'readback', reason: 'fixture', remoteRetention: 'retain' }; }, readback: async () => { counters.remote += 1; order.push('project-readback'); return { kind: 'inconclusive', reason: 'fixture', remoteRetention: 'retain' }; } };
  const providerPort: ProviderInventoryPort & ProviderActivationPort = { inspect: async () => ({ kind: 'observed', inventory: { provider: 'codex', marketplace: { present: false, sourceType: null, source: null }, plugins: [] } }), activate: async () => { counters.remote += 1; order.push('provider'); return { kind: 'inconclusive', stage: 'fixture', reason: 'fixture', remoteRetention: 'retain' }; }, revoke: async () => ({ kind: 'preserved', reason: 'ownership-unknown' }) };
  return { preflight: { revision: { findById: async () => ({ configName: 'default', revisionId: 'rev', defaultMarker: { kind: 'known', value: true }, scopeBoundary: { kind: 'known', value: 'project' }, availability: { kind: 'known', value: 'resolved' }, instructions: [], skills: [], mcp: [], hooks: [], plugins: [], triggerCategory: 'new-scenario', evidenceRef: 'fixture', supersedesRevisionId: null }), listAll: async () => [] } as ConfigRevisionRepository, repositories: repoPort, project: projectPort, providers: providerPort }, targets: { repositories: new Map([['octocat/agent-control', repo]]), project, providers: new Map([['codex', provider]]) } };
}

describe('configs init deployment CLI', () => {
  test('missing injected deployment dependencies returns typed unsupported without opening clients', async () => {
    const restore = capture(); expect(await main(['init', '--plan'])).toBe(1); expect(await main(['init', '--apply'])).toBe(1); restore();
    expect(output.join('\n')).toContain('STATUS-SOURCE-UNAVAILABLE'); expect(output.join('\n')).not.toMatch(/prompt|transcript|token|secret/i);
  });
  test('strictly parses only init plan/apply modes', async () => {
    expect(await main(['init'])).toBe(2); expect(await main(['init', '--plan', '--extra'])).toBe(2);
  });
  test('plan runs typed preflight without remote mutation and apply preserves bounded ordering/retention', async () => {
    const journal = new InMemoryOperationJournal(); const counters = { remote: 0 }; const order: string[] = []; const fixture = adapters(order, counters);
    const restore = capture();
    const planned = await main(['init', '--plan'], { deploymentPlan: { journal, input: { deploymentId: plan.deploymentId, operationId: plan.operationId, revisionId: 'rev', repositories: [repo], project, providers: [provider] }, ports: fixture.preflight } });
    expect(planned).toBe(0); expect(counters.remote).toBe(0);
    expect(planned).toBe(0); expect(counters.remote).toBe(0); expect(await journal.find(plan.operationId)).toBeNull();
    await prepareDeploymentOperationPlan(journal, plan);
    const applied = await main(['init', '--apply'], { deploymentApply: { journal, operationId: plan.operationId, deploymentId: plan.deploymentId, targets: fixture.targets, ports: { repositories: fixture.preflight.repositories, project: fixture.preflight.project, provider: fixture.preflight.providers as never } } });
    restore(); expect(applied).toBe(1); expect(order).toEqual(['repo']); expect(output.join('\n')).toContain('retain');
  });
});
