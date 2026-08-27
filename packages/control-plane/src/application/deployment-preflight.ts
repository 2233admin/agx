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
interface NormalizedDeploymentInput {
  readonly input: DeploymentPreflightInput;
  readonly blockers: readonly DeploymentPreflightBlocker[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizeInput(value: unknown): NormalizedDeploymentInput {
  const raw = isRecord(value) ? value : {};
  const blockers: DeploymentPreflightBlocker[] = [];
  if (raw.repositories !== undefined && !Array.isArray(raw.repositories)) blockers.push({ resource: '(invalid repositories)', reason: 'invalid-repositories-input' });
  const repositories: GithubRepositoryTarget[] = [];
  for (const target of Array.isArray(raw.repositories) ? raw.repositories : []) {
    if (isRecord(target) && typeof target.owner === 'string' && typeof target.name === 'string') repositories.push(target as unknown as GithubRepositoryTarget);
    else blockers.push({ resource: '(invalid repository target)', reason: 'invalid-repository-input' });
  }
  if (raw.providers !== undefined && !Array.isArray(raw.providers)) blockers.push({ resource: '(invalid providers)', reason: 'invalid-providers-input' });
  const providers: ProviderActivationTarget[] = [];
  for (const target of Array.isArray(raw.providers) ? raw.providers : []) {
    if (isRecord(target) && typeof target.provider === 'string' && typeof target.marketplaceSource === 'string' && Array.isArray(target.plugins)) providers.push(target as unknown as ProviderActivationTarget);
    else blockers.push({ resource: '(invalid provider target)', reason: 'invalid-provider-input' });
  }
  if (raw.multicaSubjects !== undefined && !Array.isArray(raw.multicaSubjects)) blockers.push({ resource: '(invalid Multica subjects)', reason: 'invalid-multica-input' });
  const multicaSubjects: MulticaSubject[] = [];
  for (const subject of Array.isArray(raw.multicaSubjects) ? raw.multicaSubjects : []) {
    if (isRecord(subject) && typeof subject.kind === 'string' && typeof subject.id === 'string') multicaSubjects.push(subject as unknown as MulticaSubject);
    else blockers.push({ resource: '(invalid Multica subject)', reason: 'invalid-multica-input' });
  }
  const project = isRecord(raw.project) ? raw.project as unknown as GithubProjectTarget : null;
  const normalized: DeploymentPreflightInput = {
    deploymentId: typeof raw.deploymentId === 'string' ? raw.deploymentId : '',
    operationId: typeof raw.operationId === 'string' ? raw.operationId : '',
    revisionId: typeof raw.revisionId === 'string' ? raw.revisionId : '[invalid-revision-id]',
    repositories,
    project: project as GithubProjectTarget,
    providers,
    multicaSubjects,
  };
  if (raw.revisionId !== undefined && typeof raw.revisionId !== 'string') blockers.push({ resource: '(invalid revision id)', reason: 'invalid-revision-input' });
  if (!isRecord(raw.project)) blockers.push({ resource: '(invalid project target)', reason: 'invalid-project-input' });
  return { input: normalized, blockers };
}

const RESOURCE_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
function repositoryResource(target: GithubRepositoryTarget): string { return `${target.owner}/${target.name}`; }
function projectResource(target: GithubProjectTarget | null | undefined): string {
  return target !== null && target !== undefined && typeof target.installationId === 'string' ? target.installationId : '';
}
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
  if (!RESOURCE_ID.test(input.deploymentId)) blockers.push({ resource: '(invalid deployment id)', reason: 'invalid-deployment-id' });
  if (!RESOURCE_ID.test(input.operationId)) blockers.push({ resource: '(invalid operation id)', reason: 'invalid-operation-id' });
  if (input.revisionId.trim() === '') blockers.push({ resource: '(missing revision id)', reason: 'configuration-revision-required' });
  const repositories = Array.isArray(input.repositories) ? input.repositories : [];
  const seenRepositories = new Set<string>();
  for (const target of repositories) {
    const resource = repositoryResource(target);
    const canonical = resource.toLowerCase();
    if (!RESOURCE_ID.test(resource)) blockers.push({ resource: '(invalid repository target)', reason: 'invalid-repository-resource' });
    else if (seenRepositories.has(canonical)) blockers.push({ resource, reason: 'duplicate-repository-target' });
    seenRepositories.add(canonical);
  }
  const project = input.project as GithubProjectTarget | null | undefined;
  const resource = projectResource(project);
  if (project !== null && project !== undefined && (typeof project.title !== 'string' || project.title.trim() === '' || !/[\p{L}\p{N}]/u.test(project.title) || /[\u0000-\u001f\u007f]/.test(project.title))) blockers.push({ resource: '(invalid project title)', reason: 'invalid-project-title' });
  else if (project !== null && project !== undefined && !RESOURCE_ID.test(resource)) blockers.push({ resource: '(invalid project identity)', reason: 'invalid-project-resource' });
  const seenProviders = new Set<string>();
  const providers = Array.isArray(input.providers) ? input.providers : [];
  for (const target of providers) {
    const canonical = target.provider.toLowerCase();
    if (!RESOURCE_ID.test(target.provider)) blockers.push({ resource: '(invalid provider target)', reason: 'invalid-provider-resource' });
    else if (seenProviders.has(canonical)) blockers.push({ resource: target.provider, reason: 'duplicate-provider-target' });
    seenProviders.add(canonical);
  }
  return blockers;
}

function diagnosticPlan(input: OperationPlanInput): OperationJournalRecord {
  return {
    operationId: RESOURCE_ID.test(input.operationId) ? input.operationId : '[invalid-operation-id]',
    deploymentId: RESOURCE_ID.test(input.deploymentId) ? input.deploymentId : '[invalid-deployment-id]',
    revisionId: input.revisionId,
    phase: 'prepared',
    steps: input.steps.map((step, index) => ({
      sequence: index + 1,
      kind: step.kind,
      resource: RESOURCE_ID.test(step.resource) ? step.resource : `[invalid-${step.kind}-${index + 1}]`,
      phase: 'pending' as const,
    })),
    remoteRetention: 'retain',
    nextAction: 'start-operation',
  };
}

function buildPlanInput(input: DeploymentPreflightInput): OperationPlanInput {
  const repositories = sortedRepositories(Array.isArray(input.repositories) ? input.repositories : []);
  const providers = sortedProviders(Array.isArray(input.providers) ? input.providers : []);
  return {
    deploymentId: input.deploymentId,
    operationId: input.operationId,
    revisionId: input.revisionId,
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
  const normalized = normalizeInput(input);
  input = normalized.input;
  const planInput = buildPlanInput(input);
  const diagnostic = diagnosticPlan(planInput);
  const blockers = [...normalized.blockers, ...inputBlockers(input)];
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
