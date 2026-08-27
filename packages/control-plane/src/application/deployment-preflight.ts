import type {
  ConfigRevisionRepository,
  GithubProjectPort,
  GithubRepositoryPort,
  MulticaRuntimePort,
  OperationJournalPort,
  ProviderInventoryPort,
} from './ports';
import { prepareDeploymentOperationPlan } from './operation-plan';
import type { OperationJournalRecord, OperationPlanInput } from '../domain/operation-journal';
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

function repositoryResource(target: GithubRepositoryTarget): string { return `${target.owner}/${target.name}`; }
function projectResource(target: GithubProjectTarget): string { return target.title.trim().replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, ''); }
function sameSource(actual: string | null, expected: string): boolean { return actual !== null && actual.trim() !== '' && actual.trim().replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase() === expected.trim().replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase(); }

function sortedRepositories(targets: readonly GithubRepositoryTarget[]): readonly GithubRepositoryTarget[] {
  return [...targets].sort((left, right) => repositoryResource(left).localeCompare(repositoryResource(right)));
}
function sortedProviders(targets: readonly ProviderActivationTarget[]): readonly ProviderActivationTarget[] {
  return [...targets].sort((left, right) => left.provider.localeCompare(right.provider));
}

function buildPlanInput(input: DeploymentPreflightInput): OperationPlanInput {
  const repositories = sortedRepositories(input.repositories);
  const providers = sortedProviders(input.providers);
  return {
    deploymentId: input.deploymentId,
    operationId: input.operationId,
    steps: [
      ...repositories.map((target) => ({ kind: 'github-repository' as const, resource: target.name })),
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
  const plan = await prepareDeploymentOperationPlan(journal, buildPlanInput(input));
  const blockers: DeploymentPreflightBlocker[] = [];
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

  return blockers.length === 0 ? { kind: 'ready', plan, blockers: [], remoteRetention: 'retain' } : { kind: 'blocked', plan, blockers, remoteRetention: 'retain' };
}
