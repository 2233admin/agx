import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EVIDENCE_EVALUATOR_V1, EVIDENCE_INPUT_SCHEMA_V1, evaluateEvidence, type EvidenceEvaluationInput } from '../../src/domain/evidence';
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
function ports(order: string[], firstRepoInconclusive = false): { preflight: DeploymentPreflightPorts; apply: DeploymentApplyPorts; remoteCalls: () => number } {
  let repoAttempts = 0; let remoteCalls = 0;
  const repositories: GithubRepositoryPort = { preflight: async () => ({ kind: 'ready' }), provision: async () => { remoteCalls += 1; order.push('repo-provision'); repoAttempts += 1; return firstRepoInconclusive && repoAttempts === 1 ? { kind: 'inconclusive', stage: 'readback', reason: 'timeout', remoteRetention: 'retain' } : remoteRepo(); }, readback: async () => { remoteCalls += 1; order.push('repo-readback'); return { kind: 'present', repository: remoteRepo().repository }; } };
  const projects: GithubProjectPort = { preflight: async () => ({ kind: 'ready' }), provision: async () => { remoteCalls += 1; order.push('project-provision'); return remoteProject(); }, readback: async () => { remoteCalls += 1; order.push('project-readback'); return { kind: 'present', identity: remoteProject().identity, hasIssues: true, linked: true }; } };
  const providers: ProviderInventoryPort & ProviderActivationPort = { inspect: async () => ({ kind: 'observed', inventory: { provider: 'codex', marketplace: { present: false, sourceType: null, source: null }, plugins: [] } }), activate: async () => { remoteCalls += 1; order.push('provider-activate'); return { kind: 'activated', inventory: { provider: 'codex' as const, marketplace: { present: true, sourceType: 'local', source: provider.marketplaceSource }, plugins: provider.plugins }, ownership: { marketplace: 'created-by-configs' as const, marketplaceSource: provider.marketplaceSource, plugins: [{ name: 'review', version: '1.0.0', source: provider.marketplaceSource }] } }; }, revoke: async () => ({ kind: 'preserved', reason: 'marketplace-pre-existing' }) };
  return { preflight: { revision: { findById: async () => revision, listAll: async () => [revision] }, repositories, project: projects, providers }, apply: { repositories, project: projects, provider: providers }, remoteCalls: () => remoteCalls };
}

async function validReceiptRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'configs-cutover-')); roots.push(root);
  const owned = 'legacy state\n'; const digest = createHash('sha256').update(owned).digest('hex');
  await mkdir(path.join(root, '.agx'), { recursive: true }); await mkdir(path.join(root, 'components', 'agent-plugins'), { recursive: true });
  await writeFile(path.join(root, 'components', 'agent-plugins', 'README.md'), owned); await writeFile(path.join(root, 'operator.md'), 'preserve me\n');
  await writeFile(path.join(root, '.agx', 'receipt.json'), JSON.stringify({ schema_version: 'agx.receipt/v2', installation_id: 'install-1', bundle_id: 'bundle-1', bundle_sha256: 'a'.repeat(64), template_version: 'bootstrap-20260819.1', template_content_sha256: 'b'.repeat(64), phase: 'configured', components: [{ name: 'agent-plugins', repository: 'zaurakworks/agent-plugins', distribution_repository: '2233admin/agent-plugins', commit_sha: 'c'.repeat(40), asset_sha256: 'd'.repeat(64), path: 'components/agent-plugins' }], owned_files: ['components/agent-plugins/README.md'], owned_file_sha256: { 'components/agent-plugins/README.md': digest } }));
  return root;
}
const EVIDENCE_NOW = '2026-08-27T00:00:00Z';
function evidenceInput(observations: readonly unknown[]): EvidenceEvaluationInput {
  return { schemaVersion: EVIDENCE_INPUT_SCHEMA_V1, evaluatorVersion: EVIDENCE_EVALUATOR_V1, installationId: project.installationId, deploymentDigest: 'd'.repeat(64), subjectDigest: 'e'.repeat(64), profile: 'github-delivery/v1', evaluatedAt: EVIDENCE_NOW, observations } as EvidenceEvaluationInput;
}
function completeEvidence() {
  const common = { schemaVersion: 'agx/evidence-observation/v1' as const, evaluatorVersion: 'agx/evidence-evaluator/v1' as const, source: 'github' as const, installationId: project.installationId, deploymentDigest: 'd'.repeat(64), subjectDigest: 'e'.repeat(64), fingerprint: 'f'.repeat(64), outcome: 'matched' as const, observedAt: EVIDENCE_NOW };
  const observations = [
    { ...common, kind: 'github.control-repository.readback/v1' as const, ref: { resourceType: 'repository' as const, identitySHA256: '1'.repeat(64) } },
    { ...common, kind: 'github.contracts-repository.readback/v1' as const, ref: { resourceType: 'repository' as const, identitySHA256: '2'.repeat(64) } },
    { ...common, kind: 'github.project.readback/v1' as const, ref: { resourceType: 'project' as const, identitySHA256: '5'.repeat(64) } },
    { ...common, kind: 'github.project-item.readback/v1' as const, ref: { resourceType: 'project_item' as const, number: 8 } },
    { ...common, kind: 'github.contract-issue.readback/v1' as const, ref: { resourceType: 'issue' as const, number: 9 } },
    { ...common, kind: 'github.current-work.readback/v1' as const, ref: { resourceType: 'commit' as const, identitySHA256: '3'.repeat(64), revision: repo.initialRevision.commit } },
    { ...common, kind: 'github.delivery-pr.open/v1' as const, ref: { resourceType: 'pull_request' as const, number: 10, revision: repo.initialRevision.commit } },
    { ...common, kind: 'github.checks.passed/v1' as const, ref: { resourceType: 'check' as const, identitySHA256: '4'.repeat(64), revision: repo.initialRevision.commit } },
  ];
  return evaluateEvidence(evidenceInput(observations), EVIDENCE_NOW);
}

describe('configs-primary cutover rehearsal', () => {
  test('runs preflight, interrupted apply, explicit resolution, verified status/diagnose, and legacy import without side effects', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'configs-cutover-journal-')); roots.push(root); const journal = new SqliteOperationJournal(path.join(root, 'state.sqlite3'), () => '2026-08-27T00:00:00.000Z'); const order: string[] = []; const adapters = ports(order, true);
    const preflight = await prepareDeploymentPlan(journal, { deploymentId: 'dep-rehearsal', operationId: 'op-rehearsal', revisionId: 'rev-1', repositories: [repo], project, providers: [provider] }, adapters.preflight);
    expect(preflight.kind).toBe('ready');
    expect(adapters.remoteCalls()).toBe(0);
    const targets: DeploymentApplyTargets = { repositories: new Map([['octocat/agent-control', repo]]), project, providers: new Map([['codex', provider]]) };
    const first = await applyDeploymentPlan(journal, 'op-rehearsal', targets, adapters.apply); expect(first.kind).toBe('inconclusive');
    const recovered = await journal.resolveInconclusive('op-rehearsal', { operationId: 'op-rehearsal', deploymentId: 'dep-rehearsal', sequence: 1, kind: 'github-repository', resource: 'octocat/agent-control', outcome: 'matched', fingerprint: 'e'.repeat(64), observedAt: '2026-08-27T00:00:00Z' }, '2026-08-27T00:00:01Z');
    expect(recovered.steps[0]?.phase).toBe('pending');
    const final = await applyDeploymentPlan(journal, 'op-rehearsal', targets, adapters.apply); expect(final.operation?.phase).toBe('succeeded'); expect(final.remoteRetention).toBe('retain'); expect(order).toEqual(['repo-provision', 'repo-provision', 'repo-readback', 'project-provision', 'project-readback', 'provider-activate']);
    const realEvidence = completeEvidence();
    const statusInput: StatusProjectionInput = { activeRevision: known(revision), deployment: { deploymentId: 'dep-rehearsal', phase: 'configured', lastOperationId: known('op-rehearsal'), reason: null, nextAction: 'none' }, operation: final.operation!, launchPlans: [], readbacks: [{ kind: 'repository', resourceId: 'octocat/agent-control', digest: 'a'.repeat(64), ownership: 'created-by-configs', outcome: 'matched' }, { kind: 'project', resourceId: project.installationId, digest: 'b'.repeat(64), ownership: 'created-by-configs', outcome: 'matched' }, { kind: 'provider', resourceId: 'codex', digest: 'c'.repeat(64), ownership: 'created-by-configs', outcome: 'matched' }], evidence: realEvidence };
    expect(realEvidence).toEqual(expect.objectContaining({ phase: 'verified', missing: [], diagnostics: [] }));
    const fakeEmptyEvidence = evaluateEvidence(evidenceInput([]), EVIDENCE_NOW);
    expect(fakeEmptyEvidence.phase).not.toBe('verified');
    expect(projectStatus({ ...statusInput, evidence: fakeEmptyEvidence }).phase).not.toBe('verified');
    const output: string[] = []; const oldLog = console.log; console.log = (...args: unknown[]) => output.push(args.map(String).join(' ')); try { expect(await main(['status'], { statusProjection: statusInput })).toBe(0); expect(await main(['diagnose'], { statusProjection: statusInput })).toBe(0); } finally { console.log = oldLog; }
    expect(output.join('\n')).toContain('verified'); expect(output.join('\n')).not.toMatch(/prompt|transcript|secret|token|private payload/i);
    const receiptRoot = await validReceiptRoot(); const imported = await importLegacyReceipt(receiptRoot, { clock: () => '2026-08-27T00:00:00Z' }); expect(imported.kind).toBe('imported'); expect(await readFile(path.join(receiptRoot, 'operator.md'), 'utf8')).toBe('preserve me\n'); journal.close();
  });
});
