import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { main } from '../../src/cli/index';
import { InMemoryOperationJournal } from '../../src/adapters/operation/in-memory-journal';
import { prepareDeploymentOperationPlan } from '../../src/application/operation-plan';
import type { DeploymentApplyTargets } from '../../src/application/deployment-apply';
import type { DeploymentPreflightPorts } from '../../src/application/deployment-preflight';
import type { ConfigRevisionRepository, GithubProjectPort, GithubRepositoryPort, GithubRepositorySourcePort, ProviderActivationPort, ProviderInventoryPort } from '../../src/application/ports';
import type { DefaultDeploymentDependencies } from '../../src/adapters/deployment/default-dependencies';
import type { OperationPlanInput } from '../../src/domain/operation-journal';

const repo = { owner: 'octocat', name: 'agent-control', visibility: 'private', description: '', sourcePath: 'C:/template', initialRevision: { commit: 'a'.repeat(40), templateVersion: 'v1', templateDigest: 'b'.repeat(64), requiredPaths: ['README.md'] } } as const;
const project = { owner: 'octocat', title: 'Agent System', visibility: 'private', linkedRepository: 'octocat/agent-control', installationId: 'install-0123456789abcdef' } as const;
const provider = { provider: 'codex', marketplaceSource: 'C:/plugins', plugins: [] } as const;
const plan: OperationPlanInput = { deploymentId: 'dep-init', operationId: 'op-init', revisionId: 'rev', steps: [{ kind: 'github-repository', resource: 'octocat/agent-control' }, { kind: 'github-project', resource: project.installationId }, { kind: 'provider-activation', resource: 'codex' }] };
let output: string[] = [];
afterEach(() => { output = []; });
function capture() { const old = console.log; console.log = (...args: unknown[]) => output.push(args.map(String).join(' ')); return () => { console.log = old; }; }
function adapters(order: string[], counters: { remote: number }): { preflight: DeploymentPreflightPorts; targets: DeploymentApplyTargets } {
  const repoPort: GithubRepositoryPort = { preflight: async () => ({ kind: 'ready' }), provision: async () => { counters.remote += 1; order.push('repo'); return { kind: 'inconclusive', stage: 'readback', reason: 'fixture', remoteRetention: 'retain' }; }, readback: async () => { counters.remote += 1; order.push('repo-readback'); return { kind: 'present', repository: { nameWithOwner: 'octocat/agent-control', url: 'https://github.com/octocat/agent-control', visibility: 'private' as const, hasIssues: true, defaultBranch: 'main', headCommit: repo.initialRevision.commit, initialCommit: repo.initialRevision.commit } }; } };
  const projectPort: GithubProjectPort = { preflight: async () => ({ kind: 'ready' }), provision: async () => { counters.remote += 1; order.push('project'); return { kind: 'inconclusive', stage: 'readback', reason: 'fixture', remoteRetention: 'retain' }; }, readback: async () => { counters.remote += 1; order.push('project-readback'); return { kind: 'inconclusive', reason: 'fixture', remoteRetention: 'retain' }; } };
  const providerPort: ProviderInventoryPort & ProviderActivationPort = { inspect: async () => ({ kind: 'observed', inventory: { provider: 'codex', marketplace: { present: false, sourceType: null, source: null }, plugins: [] } }), activate: async () => { counters.remote += 1; order.push('provider'); return { kind: 'inconclusive', stage: 'fixture', reason: 'fixture', remoteRetention: 'retain' }; }, revoke: async () => ({ kind: 'preserved', reason: 'ownership-unknown' }) };
  const source: GithubRepositorySourcePort = { validate: async () => ({ kind: 'valid', snapshotPath: 'C:/snapshot', contentDigest: 'b'.repeat(64), initialCommit: 'a'.repeat(40) }) };
  return { preflight: { revision: { findById: async () => ({ configName: 'default', revisionId: 'rev', defaultMarker: { kind: 'known', value: true }, scopeBoundary: { kind: 'known', value: 'project' }, availability: { kind: 'known', value: 'resolved' }, instructions: [], skills: [], mcp: [], hooks: [], plugins: [], triggerCategory: 'new-scenario', evidenceRef: 'fixture', supersedesRevisionId: null }), listAll: async () => [] } as ConfigRevisionRepository, repositories: repoPort, source, project: projectPort, providers: providerPort }, targets: { repositories: new Map([['octocat/agent-control', repo]]), project, providers: new Map([['codex', provider]]) } };
}

describe('configs init deployment CLI', () => {
  test('missing injected deployment dependencies returns typed unsupported without opening clients', async () => {
    const restore = capture(); expect(await main(['init', '--plan'])).toBe(2); expect(await main(['init', '--apply'])).toBe(2); restore();
  });
  test('strictly parses only init plan/apply modes', async () => {
    expect(await main(['init'])).toBe(2); expect(await main(['init', '--plan', '--extra'])).toBe(2); expect(await main(['init', '--plan', '--input', 'relative.json'])).toBe(2);
  });
  test('plan runs typed preflight without remote mutation and apply preserves bounded ordering/retention', async () => {
    const journal = new InMemoryOperationJournal(); const counters = { remote: 0 }; const order: string[] = []; const fixture = adapters(order, counters);
    const restore = capture();
    const planned = await main(['init', '--plan'], { deploymentPlan: { journal, input: { sourceRoot: 'C:/', deploymentId: plan.deploymentId, operationId: plan.operationId, revisionId: 'rev', repositories: [repo], project, providers: [provider] }, ports: fixture.preflight } });
    expect(planned).toBe(0); expect(counters.remote).toBe(0); expect(await journal.find(plan.operationId)).toBeNull();
    await prepareDeploymentOperationPlan(journal, plan);
    const applied = await main(['init', '--apply'], { deploymentApply: { journal, operationId: plan.operationId, deploymentId: plan.deploymentId, targets: fixture.targets, ports: { repositories: fixture.preflight.repositories, project: fixture.preflight.project, provider: fixture.preflight.providers as never } } });
    restore(); expect(applied).toBe(1); expect(order).toEqual(['repo']); expect(output.join('\n')).toContain('retain');
  });
  test('default input plan and apply parse one file, preserve plan dry-run, and close injected default dependencies', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'configs-default-input-')); const inputPath = path.join(root, 'deployment.json');
    writeFileSync(inputPath, JSON.stringify({ schemaVersion: 1, sourceRoot: 'C:/', deploymentId: 'dep-input', operationId: 'op-input', revisionId: 'rev', repositories: [repo], project, providers: [provider] }));
    const counters = { remote: 0 }; const order: string[] = []; const fixture = adapters(order, counters); const journal = new InMemoryOperationJournal(); let factoryCalls = 0; let closeCalls = 0;
    const defaultDeploymentFactory = (): DefaultDeploymentDependencies => { factoryCalls += 1; return { journal, preflight: fixture.preflight, apply: { repositories: fixture.preflight.repositories, project: fixture.preflight.project, provider: fixture.preflight.providers as never }, readonlyStatus: { load: async () => null }, close: () => { closeCalls += 1; } }; };
    const restore = capture();
    try { expect(await main(['init', '--plan', '--input', inputPath], { defaultDeploymentFactory })).toBe(0); expect(await journal.find('op-input')).toBeNull(); expect(await main(['init', '--apply', '--input', inputPath], { defaultDeploymentFactory })).toBe(1); expect(factoryCalls).toBe(2); expect(closeCalls).toBe(2); expect(order).toEqual(['repo']); } finally { restore(); rmSync(root, { recursive: true, force: true }); }
  });
  test('default input rejects malformed files before constructing deployment dependencies', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'configs-invalid-input-')); const inputPath = path.join(root, 'deployment.json'); writeFileSync(inputPath, JSON.stringify({ schemaVersion: 1, unknown: 'secret-value' })); let factoryCalls = 0; const restore = capture();
    try { expect(await main(['init', '--plan', '--input', inputPath], { defaultDeploymentFactory: () => { factoryCalls += 1; throw new Error('must not construct'); } })).toBe(1); } finally { restore(); rmSync(root, { recursive: true, force: true }); }
    expect(factoryCalls).toBe(0); expect(output.join('\n')).toContain('DEPLOYMENT-INPUT-INVALID'); expect(output.join('\n')).not.toContain('secret-value');
  });
});
