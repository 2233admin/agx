import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SqliteOperationJournal } from '../../src/adapters/sqlite/operation-journal';
import { importLegacyReceipt } from '../../src/adapters/migration/receipt-importer';
import { main } from '../../src/cli/index';
import { applyDeploymentPlan, type DeploymentApplyPorts, type DeploymentApplyTargets } from '../../src/application/deployment-apply';
import { prepareDeploymentPlan, type DeploymentPreflightPorts } from '../../src/application/deployment-preflight';
import { projectStatus, type StatusProjectionInput } from '../../src/domain/status';
import { known } from '../../src/domain/facts';
import type { ConfigRevisionRepository, GithubProjectPort, GithubRepositoryPort, ProviderActivationPort, ProviderInventoryPort } from '../../src/application/ports';

const repo = { owner: 'octocat', name: 'agent-control', visibility: 'private', description: '', sourcePath: 'C:/template', initialRevision: { commit: 'a'.repeat(40), templateVersion: 'v1', templateDigest: 'b'.repeat(64), requiredPaths: ['README.md'] } } as const;
const project = { owner: 'octocat', title: 'Agent System', visibility: 'private', linkedRepository: 'octocat/agent-control', installationId: 'install-0123456789abcdef' } as const;
const provider = { provider: 'codex', marketplaceSource: 'C:/agent-plugins', plugins: [{ name: 'review', version: '1.0.0', enabled: true }] } as const;
const revision = { configName: 'default', revisionId: 'rev-1', defaultMarker: known(true), scopeBoundary: known('project'), availability: known('resolved'), instructions: [], skills: [], mcp: [], hooks: [], plugins: [], triggerCategory: 'new-scenario', evidenceRef: 'fixture', supersedesRevisionId: null } as never;
let roots: string[] = [];
afterEach(async () => { await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true }))); roots = []; });

function remoteRepo() { return { kind: 'created' as const, repository: { nameWithOwner: 'octocat/agent-control', url: 'https://github.com/octocat/agent-control', visibility: 'private' as const, hasIssues: true, defaultBranch: 'main', headCommit: repo.initialRevision.commit, initialCommit: repo.initialRevision.commit }, ownership: 'created-by-configs' as const, initialRevision: repo.initialRevision, binding: { kind: 'github-repository' as const, resourceId: 'octocat/agent-control', ownership: 'unknown' as const, remoteIdentity: 'https://github.com/octocat/agent-control', destructiveActions: 'denied' as const } }; }
function remoteProject() { return { kind: 'created' as const, identity: { owner: 'octocat', number: 7, nodeId: 'PVT_1', url: 'https://github.com/users/octocat/projects/7', title: project.title, visibility: 'private' as const }, ownership: 'created-by-configs' as const, linked: true as const, binding: { kind: 'github-project' as const, resourceId: 'PVT_1', ownership: 'unknown' as const, remoteIdentity: 'https://github.com/users/octocat/projects/7', destructiveActions: 'denied' as const } }; }
function ports(order: string[], firstRepoInconclusive = false): { preflight: DeploymentPreflightPorts; apply: DeploymentApplyPorts } {
  let repoAttempts = 0;
  const repositories: GithubRepositoryPort = { preflight: async () => ({ kind: 'ready' }), provision: async () => { order.push('repo-provision'); repoAttempts += 1; return firstRepoInconclusive && repoAttempts === 1 ? { kind: 'inconclusive', stage: 'readback', reason: 'timeout', remoteRetention: 'retain' } : remoteRepo(); }, readback: async () => { order.push('repo-readback'); return { kind: 'present', repository: remoteRepo().repository }; } };
  const projects: GithubProjectPort = { preflight: async () => ({ kind: 'ready' }), provision: async () => { order.push('project-provision'); return remoteProject(); }, readback: async () => { order.push('project-readback'); return { kind: 'present', identity: remoteProject().identity, hasIssues: true, linked: true }; } };
  const providers: ProviderInventoryPort & ProviderActivationPort = { inspect: async () => ({ kind: 'observed', inventory: { provider: 'codex', marketplace: { present: false, sourceType: null, source: null }, plugins: [] } }), activate: async () => { order.push('provider-activate'); return { kind: 'activated', inventory: { provider: 'codex' as const, marketplace: { present: true, sourceType: 'local', source: provider.marketplaceSource }, plugins: provider.plugins }, ownership: { marketplace: 'created-by-configs' as const, marketplaceSource: provider.marketplaceSource, plugins: [{ name: 'review', version: '1.0.0', source: provider.marketplaceSource }] } }; }, revoke: async () => ({ kind: 'preserved', reason: 'marketplace-pre-existing' }) };
  return { preflight: { revision: { findById: async () => revision, listAll: async () => [revision] }, repositories, project: projects, providers }, apply: { repositories, project: projects, provider: providers } };
}

async function validReceiptRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'configs-cutover-')); roots.push(root);
  const owned = 'legacy state\n'; const digest = createHash('sha256').update(owned).digest('hex');
  await mkdir(path.join(root, '.agx'), { recursive: true }); await mkdir(path.join(root, 'components', 'agent-plugins'), { recursive: true });
  await writeFile(path.join(root, 'components', 'agent-plugins', 'README.md'), owned); await writeFile(path.join(root, 'operator.md'), 'preserve me\n');
  await writeFile(path.join(root, '.agx', 'receipt.json'), JSON.stringify({ schema_version: 'agx.receipt/v2', installation_id: 'install-1', bundle_id: 'bundle-1', bundle_sha256: 'a'.repeat(64), template_version: 'bootstrap-20260819.1', template_content_sha256: 'b'.repeat(64), phase: 'configured', components: [{ name: 'agent-plugins', repository: 'zaurakworks/agent-plugins', distribution_repository: '2233admin/agent-plugins', commit_sha: 'c'.repeat(40), asset_sha256: 'd'.repeat(64), path: 'components/agent-plugins' }], owned_files: ['components/agent-plugins/README.md'], owned_file_sha256: { 'components/agent-plugins/README.md': digest } }));
  return root;
}

describe('configs-primary cutover rehearsal', () => {
  test('runs preflight, interrupted apply, explicit resolution, verified status/diagnose, and legacy import without side effects', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'configs-cutover-journal-')); roots.push(root); const journal = new SqliteOperationJournal(path.join(root, 'state.sqlite3'), () => '2026-08-27T00:00:00.000Z'); const order: string[] = []; const adapters = ports(order, true);
    const preflight = await prepareDeploymentPlan(journal, { deploymentId: 'dep-rehearsal', operationId: 'op-rehearsal', revisionId: 'rev-1', repositories: [repo], project, providers: [provider] }, adapters.preflight);
    expect(preflight.kind).toBe('ready');
    const targets: DeploymentApplyTargets = { repositories: new Map([['octocat/agent-control', repo]]), project, providers: new Map([['codex', provider]]) };
    const first = await applyDeploymentPlan(journal, 'op-rehearsal', targets, adapters.apply); expect(first.kind).toBe('inconclusive');
    const recovered = await journal.resolveInconclusive('op-rehearsal', { operationId: 'op-rehearsal', deploymentId: 'dep-rehearsal', sequence: 1, kind: 'github-repository', resource: 'octocat/agent-control', outcome: 'matched', fingerprint: 'e'.repeat(64), observedAt: '2026-08-27T00:00:00Z' }, '2026-08-27T00:00:01Z');
    expect(recovered.steps[0]?.phase).toBe('pending');
    const final = await applyDeploymentPlan(journal, 'op-rehearsal', targets, adapters.apply); expect(final.operation?.phase).toBe('succeeded'); expect(final.remoteRetention).toBe('retain'); expect(order).toEqual(['repo-provision', 'repo-provision', 'repo-readback', 'project-provision', 'project-readback', 'provider-activate']);
    const statusInput: StatusProjectionInput = { activeRevision: known(revision), deployment: { deploymentId: 'dep-rehearsal', phase: 'configured', lastOperationId: known('op-rehearsal'), reason: null, nextAction: 'none' }, operation: final.operation!, launchPlans: [], readbacks: [{ kind: 'repository', resourceId: 'octocat/agent-control', digest: 'a'.repeat(64), ownership: 'created-by-configs', outcome: 'matched' }, { kind: 'project', resourceId: project.installationId, digest: 'b'.repeat(64), ownership: 'created-by-configs', outcome: 'matched' }, { kind: 'provider', resourceId: 'codex', digest: 'c'.repeat(64), ownership: 'created-by-configs', outcome: 'matched' }], evidence: { phase: 'verified', profile: 'github-delivery/v1', installationId: 'install-0123456789abcdef', deploymentDigest: 'd'.repeat(64), subjectDigest: 'e'.repeat(64), evaluatedAt: '2026-08-27T00:00:00Z', satisfied: [], missing: [], diagnostics: [], nextSteps: [], evidence: [] } };
    expect(projectStatus(statusInput).phase).toBe('verified');
    const output: string[] = []; const oldLog = console.log; console.log = (...args: unknown[]) => output.push(args.map(String).join(' ')); try { expect(await main(['status'], { statusProjection: statusInput })).toBe(0); expect(await main(['diagnose'], { statusProjection: statusInput })).toBe(0); } finally { console.log = oldLog; }
    expect(output.join('\n')).toContain('verified'); expect(output.join('\n')).not.toMatch(/prompt|transcript|secret|token|private payload/i);
    const receiptRoot = await validReceiptRoot(); const imported = await importLegacyReceipt(receiptRoot, { clock: () => '2026-08-27T00:00:00Z' }); expect(imported.kind).toBe('imported'); expect(await readFile(path.join(receiptRoot, 'operator.md'), 'utf8')).toBe('preserve me\n'); journal.close();
  });
});
