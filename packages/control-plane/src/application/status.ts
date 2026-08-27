import { isKnown, unknown } from '../domain/facts';
import type { EvidenceReceipt } from '../domain/evidence';
import type { ConfigRevisionRepository, LaunchPlanRepository, OperationJournalPort } from './ports';
import type { DeploymentStatus } from '../domain/deployment';
import { projectStatus, type StatusProjectionInput, type UnifiedStatus } from '../domain/status';
export interface DurableStatusSelectors {
  readonly deploymentId: string;
  readonly operationId: string;
}
export interface DurableStatusDependencies {
  readonly configRepository: ConfigRevisionRepository;
  readonly deploymentRepository: { readonly findDeployment: (deploymentId: string) => Promise<DeploymentStatus | null> };
  readonly operationJournal: Pick<OperationJournalPort, 'find'>;
  readonly launchPlanRepository: LaunchPlanRepository;
}
function awaitingEvidence(): EvidenceReceipt {
  return { phase: 'awaiting_verification', profile: 'github-delivery/v1', installationId: '', deploymentDigest: '', subjectDigest: '', evaluatedAt: new Date(0).toISOString(), satisfied: [], missing: [], diagnostics: [], nextSteps: [], evidence: [] };
}
export async function loadStatusProjection(deps: DurableStatusDependencies, selectors: DurableStatusSelectors): Promise<StatusProjectionInput | null> {
  if (selectors.deploymentId.trim() === '' || selectors.operationId.trim() === '') return null;
  const deployment = await deps.deploymentRepository.findDeployment(selectors.deploymentId);
  const operation = await deps.operationJournal.find(selectors.operationId);
  if (deployment === null || operation === null || operation.deploymentId !== deployment.deploymentId) return null;
  const revisions = await deps.configRepository.listAll();
  const active = revisions.filter((revision) => isKnown(revision.defaultMarker) && revision.defaultMarker.value).sort((left, right) => left.revisionId < right.revisionId ? -1 : left.revisionId > right.revisionId ? 1 : 0)[0];
  return { activeRevision: active === undefined ? unknown('active-revision-unavailable', new Date(0).toISOString()) : { kind: 'known', value: active }, deployment, operation, launchPlans: [], readbacks: [], evidence: awaitingEvidence() };
}

export function getUnifiedStatus(input: StatusProjectionInput): UnifiedStatus {
  return projectStatus(input);
}
