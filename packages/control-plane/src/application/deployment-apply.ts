import type {
  GithubProjectPort,
  GithubRepositoryPort,
  OperationJournalPort,
  ProviderActivationPort,
} from './ports';
import type { OperationJournalRecord, OperationResolution } from '../domain/operation-journal';
import type { GithubProjectTarget } from '../domain/github-project';
import type { GithubRepositoryTarget } from '../domain/github-repository';
import type { ProviderActivationTarget } from '../domain/provider';

export interface DeploymentApplyTargets {
  readonly repositories: ReadonlyMap<string, GithubRepositoryTarget>;
  readonly project: GithubProjectTarget;
  readonly providers: ReadonlyMap<string, ProviderActivationTarget>;
}

export interface DeploymentApplyPorts {
  readonly repositories: GithubRepositoryPort;
  readonly project: GithubProjectPort;
  readonly provider: ProviderActivationPort;
}

export interface DeploymentApplyResult {
  readonly kind: 'succeeded' | 'inconclusive' | 'needs-manual-cleanup' | 'blocked';
  readonly operation: OperationJournalRecord | null;
  readonly remoteRetention: 'retain';
  readonly nextAction: string;
}

function code(value: string): string {
  const safe = value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return safe.slice(0, 128) || 'external-operation-failed';
}

function result(kind: DeploymentApplyResult['kind'], operation: OperationJournalRecord | null, nextAction?: string): DeploymentApplyResult {
  return { kind, operation, remoteRetention: 'retain', nextAction: nextAction ?? operation?.nextAction ?? 'inspect-diagnostics' };
}

async function appendFailure(journal: OperationJournalPort, operation: OperationJournalRecord, phase: 'inconclusive' | 'needs-manual-cleanup', reason: string): Promise<DeploymentApplyResult> {
  const pending = operation.steps.find((item) => item.phase === 'pending');
  if (pending === undefined) return result('blocked', operation);
  const updated = await journal.appendStep(operation.operationId, { ...pending, phase, reason: code(reason) });
  return result(phase, updated);
}

export async function applyDeploymentPlan(
  journal: OperationJournalPort,
  operationId: string,
  targets: DeploymentApplyTargets,
  ports: DeploymentApplyPorts,
): Promise<DeploymentApplyResult> {
  let operation = await journal.find(operationId);
  if (operation === null) return result('blocked', null);
  if (operation.phase === 'succeeded') return result('succeeded', operation);
  if (operation.phase === 'inconclusive') return result('inconclusive', operation);
  if (operation.phase === 'needs-manual-cleanup' || operation.phase === 'failed' || operation.phase === 'cancelled' || operation.phase === 'degraded') return result('needs-manual-cleanup', operation);
  if (operation.phase === 'prepared' || operation.phase === 'needs-resume') operation = await journal.start(operation.operationId);
  if (operation.phase !== 'applying' && operation.phase !== 'observing') return result('blocked', operation);

  for (const planned of operation.steps) {
    if (planned.phase !== 'pending') continue;
    if (planned.kind === 'github-repository') {
      const target = targets.repositories.get(planned.resource);
      if (target === undefined) return appendFailure(journal, operation, 'needs-manual-cleanup', 'repository-target-missing');
      let provision;
      try { provision = await ports.repositories.provision(target); } catch { return appendFailure(journal, operation, 'inconclusive', 'repository-provision-inconclusive'); }
      if (provision.kind === 'collision') return appendFailure(journal, operation, 'needs-manual-cleanup', 'repository-collision');
      if (provision.kind === 'inconclusive') return appendFailure(journal, operation, 'inconclusive', 'repository-provision-inconclusive');
      let readback;
      try { readback = await ports.repositories.readback(target); } catch { return appendFailure(journal, operation, 'inconclusive', 'repository-readback-inconclusive'); }
      if (readback.kind !== 'present') return appendFailure(journal, operation, 'inconclusive', 'repository-readback-inconclusive');
      operation = await journal.appendStep(operation.operationId, { ...planned, phase: 'succeeded' });
    } else if (planned.kind === 'github-project') {
      const target = targets.project;
      if (planned.resource !== target.installationId) return appendFailure(journal, operation, 'needs-manual-cleanup', 'project-target-mismatch');
      let provision;
      try { provision = await ports.project.provision(target); } catch { return appendFailure(journal, operation, 'inconclusive', 'project-provision-inconclusive'); }
      if (provision.kind === 'collision') return appendFailure(journal, operation, 'needs-manual-cleanup', 'project-collision');
      if (provision.kind === 'inconclusive') return appendFailure(journal, operation, 'inconclusive', 'project-provision-inconclusive');
      let readback;
      try { readback = await ports.project.readback(target, provision.identity.number); } catch { return appendFailure(journal, operation, 'inconclusive', 'project-readback-inconclusive'); }
      if (readback.kind !== 'present' || !readback.linked) return appendFailure(journal, operation, 'inconclusive', 'project-readback-inconclusive');
      operation = await journal.appendStep(operation.operationId, { ...planned, phase: 'succeeded' });
    } else {
      const target = targets.providers.get(planned.resource);
      if (target === undefined) return appendFailure(journal, operation, 'needs-manual-cleanup', 'provider-target-missing');
      let activation;
      try { activation = await ports.provider.activate(target); } catch { return appendFailure(journal, operation, 'inconclusive', 'provider-activation-inconclusive'); }
      if (activation.kind === 'collision') return appendFailure(journal, operation, 'needs-manual-cleanup', 'provider-collision');
      if (activation.kind === 'inconclusive') return appendFailure(journal, operation, 'inconclusive', 'provider-activation-inconclusive');
      operation = await journal.appendStep(operation.operationId, { ...planned, phase: 'succeeded' });
    }
  }
  operation = await journal.finish(operation.operationId, 'succeeded');
  return result('succeeded', operation);
}
export async function recoverDeploymentOperation(
  journal: OperationJournalPort,
  operationId: string,
  deploymentId: string,
  targets: DeploymentApplyTargets,
  ports: DeploymentApplyPorts,
): Promise<DeploymentApplyResult> {
  const operation = await journal.find(operationId);
  if (operation === null) return result('blocked', null, 'operation-not-found');
  if (operation.deploymentId !== deploymentId) return result('blocked', operation, 'operation-identity-mismatch');
  return applyDeploymentPlan(journal, operationId, targets, ports);
}
export async function resolveDeploymentOperation(
  journal: OperationJournalPort,
  operationId: string,
  deploymentId: string,
  resolution: OperationResolution,
  now: string,
): Promise<DeploymentApplyResult> {
  if (resolution.operationId !== operationId || resolution.deploymentId !== deploymentId) return result('inconclusive', await journal.find(operationId), 'observe-remote-state');
  const operation = await journal.resolveInconclusive(operationId, resolution, now);
  return result(operation.phase === 'needs-manual-cleanup' ? 'needs-manual-cleanup' : 'inconclusive', operation);
}
