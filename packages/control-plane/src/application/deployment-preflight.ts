import type {
  ConfigRevisionRepository,
  GithubProjectPort,
  GithubRepositoryPort,
  MulticaRuntimePort,
  OperationJournalPort,
  ProviderInventoryPort,
} from './ports';
import { prepareDeploymentOperationPlan } from './operation-plan';
import { createOperationJournal, type OperationJournalRecord, type OperationPlanInput } from '../domain/operation-journal';
import type { GithubProjectTarget } from '../domain/github-project';
import type { GithubRepositoryTarget } from '../domain/github-repository';
import type { MulticaSubject } from '../domain/multica';
import type { ProviderActivationTarget } from '../domain/provider';

export interface DeploymentPreflightPorts {
  readonly revision: ConfigRevisionRepository;
  readonly repositories: GithubRepositoryPort;
  readonly project: GithubProjectPort;
  readonly providers: ProviderInventoryPort;
  readonly multica?: MulticaRuntimePort;
}

export interface DeploymentPreflightInput {
  readonly deploymentId: string;
  readonly operationId: string;
  readonly revisionId: string;
  readonly repositories: readonly GithubRepositoryTarget[];
  readonly project: GithubProjectTarget;
  readonly providers: readonly ProviderActivationTarget[];
  readonly multicaSubjects?: readonly MulticaSubject[];
}

export interface DeploymentPreflightBlocker {
  readonly resource: string;
  readonly reason: string;
  readonly detail?: string;
}

export type DeploymentPreflightResult =
  | { readonly kind: 'ready'; readonly plan: OperationJournalRecord; readonly blockers: readonly []; readonly remoteRetention: 'retain' }
  | { readonly kind: 'blocked'; readonly plan: OperationJournalRecord; readonly blockers: readonly DeploymentPreflightBlocker[]; readonly remoteRetention: 'retain' };

const RESOURCE_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
function repositoryResource(target: GithubRepositoryTarget): string { return `${target.owner}/${target.name}`; }
function projectResource(target: GithubProjectTarget): string { return target.title.trim().replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, ''); }
function sameSource(actual: string | null, expected: string): boolean {
  return actual !== null && actual.trim() !== '' &&
    actual.trim().replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase() ===
    expected.trim().replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

function sortedRepositories(targets: readonly GithubRepositoryTarget[]): readonly GithubRepositoryTarget[] {
  return [...targets].sort((left, right) => repositoryResource(left).localeCompare(repositoryResource(right)));
}
function sortedProviders(targets: readonly ProviderActivationTarget[]): readonly ProviderActivationTarget[] {
  return [...targets].sort((left, right) => left.provider.localeCompare(right.provider));
}

function inputBlockers(input: DeploymentPreflightInput): readonly DeploymentPreflightBlocker[] {
  const blockers: DeploymentPreflightBlocker[] = [];
  if (!RESOURCE_ID.test(input.deploymentId)) blockers.push({ resource: input.deploymentId || '(missing)', reason: 'invalid-deployment-id' });
  if (!RESOURCE_ID.test(input.operationId)) blockers.push({ resource: input.operationId || '(missing)', reason: 'invalid-operation-id' });
  if (input.revisionId.trim() === '') blockers.push({ resource: '(missing)', reason: 'configuration-revision-required' });
  for (const target of input.repositories) if (!RESOURCE_ID.test(repositoryResource(target))) blockers.push({ resource: repositoryResource(target), reason: 'invalid-repository-resource' });
  if (!RESOURCE_ID.test(projectResource(input.project))) blockers.push({ resource: input.project.title || '(missing)', reason: 'invalid-project-resource' });
  for (const target of input.providers) if (!RESOURCE_ID.test(target.provider)) blockers.push({ resource: target.provider || '(missing)', reason: 'invalid-provider-resource' });
  return blockers;
}

function diagnosticPlan(input: OperationPlanInput): OperationJournalRecord {
  const safe = (value: string, fallback: string): string => RESOURCE_ID.test(value) ? value : fallback;
  const steps = input.steps.map((step, index) => ({ ...step, resource: safe(step.resource, `${step.kind}-${index + 1}`) }));
  return createOperationJournal({ operationId: safe(input.operationId, 'invalid-operation'), deploymentId: safe(input.deploymentId, 'invalid-deployment'), steps });
}

function buildPlanInput(input: DeploymentPreflightInput): OperationPlanInput {
  const repositories = sortedRepositories(input.repositories);
  const providers = sortedProviders(input.providers);
  return {
    deploymentId: input.deploymentId,
    operationId: input.operationId,
    steps: [
      ...repositories.map((target) => ({ kind: 'github-repository' as const, resource: repositoryResource(target) })),
      { kind: 'github-project' as const, resource: projectResource(input.project) },
      ...providers.map((target) => ({ kind: 'provider-activation' as const, resource: target.provider })),
    ],
  };
}

/** Runs only read-only typed preflights, then persists the deterministic prepared plan. */
export async function prepareDeploymentPlan(
  journal: OperationJournalPort,
  input: DeploymentPreflightInput,
  ports: DeploymentPreflightPorts,
): Promise<DeploymentPreflightResult> {
  const planInput = buildPlanInput(input);
  const diagnostic = diagnosticPlan(planInput);
  const blockers = [...inputBlockers(input)];
  if (blockers.length > 0) return { kind: 'blocked', plan: diagnostic, blockers, remoteRetention: 'retain' };
  try {
    const revision = await ports.revision.findById(input.revisionId);
    if (revision === null) blockers.push({ resource: input.revisionId, reason: 'configuration-revision-missing' });
  } catch {
    blockers.push({ resource: input.revisionId, reason: 'configuration-revision-inconclusive' });
  }

  for (const target of sortedRepositories(input.repositories)) {
    try {
      const result = await ports.repositories.preflight(target);
      if (result.kind === 'collision') blockers.push({ resource: repositoryResource(target), reason: 'repository-collision' });
      else if (result.kind === 'inconclusive') blockers.push({ resource: repositoryResource(target), reason: 'repository-inconclusive', detail: result.reason });
    } catch {
      blockers.push({ resource: repositoryResource(target), reason: 'repository-inconclusive' });
    }
  }
  try {
    const result = await ports.project.preflight(input.project);
    if (result.kind === 'collision') blockers.push({ resource: input.project.title, reason: 'project-collision' });
    else if (result.kind === 'inconclusive') blockers.push({ resource: input.project.title, reason: 'project-inconclusive', detail: result.reason });
  } catch {
    blockers.push({ resource: input.project.title, reason: 'project-inconclusive' });
  }
  for (const target of sortedProviders(input.providers)) {
    try {
      const result = await ports.providers.inspect(target.provider);
      if (result.kind === 'inconclusive') blockers.push({ resource: target.provider, reason: 'provider-inconclusive', detail: result.reason });
      else if (result.inventory.provider !== target.provider) blockers.push({ resource: target.provider, reason: 'provider-inconclusive', detail: 'provider identity mismatch' });
      else if (result.inventory.marketplace.present && !sameSource(result.inventory.marketplace.source, target.marketplaceSource)) blockers.push({ resource: target.provider, reason: 'provider-collision', detail: 'marketplace source differs' });
    } catch {
      blockers.push({ resource: target.provider, reason: 'provider-inconclusive' });
    }
  }
  for (const subject of input.multicaSubjects ?? []) {
    if (ports.multica === undefined) {
      blockers.push({ resource: subject.id, reason: 'multica-inconclusive', detail: 'Multica readback port unavailable' });
      continue;
    }
    try {
      const result = await ports.multica.readback(subject);
      if (result.kind === 'absent') blockers.push({ resource: subject.id, reason: 'multica-absent' });
      else if (result.kind === 'ambiguous') blockers.push({ resource: subject.id, reason: 'multica-ambiguous' });
      else if (result.kind === 'offline') blockers.push({ resource: subject.id, reason: 'multica-offline' });
      else if (result.kind === 'inconclusive') blockers.push({ resource: subject.id, reason: 'multica-inconclusive', detail: result.reason });
    } catch {
      blockers.push({ resource: subject.id, reason: 'multica-inconclusive' });
    }
  }

  if (blockers.length > 0) return { kind: 'blocked', plan: diagnostic, blockers, remoteRetention: 'retain' };
  const plan = await prepareDeploymentOperationPlan(journal, planInput);
  return { kind: 'ready', plan, blockers: [], remoteRetention: 'retain' };
}
