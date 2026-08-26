import { type Fact, known, unknown } from './facts';

export type Ownership = 'created-by-configs' | 'pre-existing' | 'unknown';
export type ResourceKind =
  | 'github-repository'
  | 'github-project'
  | 'provider-source'
  | 'multica-workspace'
  | 'multica-runtime'
  | 'multica-agent';
export type OwnershipAction = 'read' | 'mutate' | 'delete';

export interface ResourceBinding {
  readonly kind: ResourceKind;
  readonly resourceId: string;
  readonly ownership: Ownership;
  readonly fingerprint: Fact<string>;
}

export type EvidenceProfile = 'github-delivery/v1' | 'multica-execution/v1';
export type EvidenceSource = 'github' | 'multica';
export type EvidenceSubjectKind =
  | 'github-repository'
  | 'github-project'
  | 'multica-workspace'
  | 'multica-runtime'
  | 'multica-agent';
export interface EvidenceSubject {
  readonly kind: EvidenceSubjectKind;
  readonly id: string;
}

/**
 * One externally validated observation. This token does not assert that every
 * requirement in the selected profile is satisfied; a later evaluator must
 * aggregate all required observations before entering `verified`.
 */
export interface ExternalEvidenceObservation {
  readonly deploymentId: string;
  readonly operationId: string;
  readonly profile: EvidenceProfile;
  readonly subject: EvidenceSubject;
  readonly source: EvidenceSource;
  readonly evidenceId: string;
  readonly observedAt: string;
  readonly expiresAt: string;
  readonly verifiedAt: string;
}

export function validateExternalEvidenceObservation(
  proof: ExternalEvidenceObservation,
  deploymentId: string,
  operationId: string,
  now: string,
): { readonly ok: true } | { readonly ok: false; readonly reason: 'invalid-external-evidence' } {
  if (proof === null || typeof proof !== 'object' ||
      typeof proof.deploymentId !== 'string' || typeof proof.operationId !== 'string' ||
      typeof proof.evidenceId !== 'string' || typeof proof.observedAt !== 'string' ||
      typeof proof.expiresAt !== 'string' || typeof proof.verifiedAt !== 'string') {
    return { ok: false, reason: 'invalid-external-evidence' };
  }
  const subject = proof.subject;
  if (subject === null || typeof subject !== 'object' ||
      typeof subject.id !== 'string' || typeof subject.kind !== 'string') {
    return { ok: false, reason: 'invalid-external-evidence' };
  }
  if (proof.deploymentId !== deploymentId || proof.operationId !== operationId) {
    return { ok: false, reason: 'invalid-external-evidence' };
  }
  if (proof.evidenceId.trim() === '' || subject.id.trim() === '') {
    return { ok: false, reason: 'invalid-external-evidence' };
  }
  const observedAt = Date.parse(proof.observedAt);
  const expiresAt = Date.parse(proof.expiresAt);
  const verifiedAt = Date.parse(proof.verifiedAt);
  const verificationNow = Date.parse(now);
  if (!Number.isFinite(observedAt) || !Number.isFinite(expiresAt) || !Number.isFinite(verifiedAt) || !Number.isFinite(verificationNow) ||
      verifiedAt < observedAt || verifiedAt > expiresAt || verifiedAt > verificationNow ||
      verificationNow < observedAt || verificationNow >= expiresAt) {
    return { ok: false, reason: 'invalid-external-evidence' };
  }
  const githubSubject = proof.subject.kind === 'github-repository' || proof.subject.kind === 'github-project';
  const multicaSubject = proof.subject.kind === 'multica-workspace' || proof.subject.kind === 'multica-runtime' || proof.subject.kind === 'multica-agent';
  if (proof.source !== 'github' && proof.source !== 'multica') {
    return { ok: false, reason: 'invalid-external-evidence' };
  }
  if ((proof.source === 'github' && (!githubSubject || proof.profile !== 'github-delivery/v1' || !proof.evidenceId.startsWith('github:'))) ||
      (proof.source === 'multica' && (!multicaSubject || proof.profile !== 'multica-execution/v1' || !proof.evidenceId.startsWith('multica:')))) {
    return { ok: false, reason: 'invalid-external-evidence' };
  }
  return { ok: true };
}


export function authorizeOwnership(
  resource: ResourceBinding,
  action: OwnershipAction,
): { readonly ok: true } | { readonly ok: false; readonly reason: string } {
  if (action === 'read') return { ok: true };
  if (resource.ownership === 'created-by-configs') {
    if (resource.fingerprint.kind !== 'known') return { ok: false, reason: 'resource-fingerprint-unknown' };
    if (resource.fingerprint.value.trim() === '') return { ok: false, reason: 'resource-fingerprint-invalid' };
    return { ok: true };
  }
  if (resource.ownership === 'pre-existing') return { ok: false, reason: 'resource-is-pre-existing' };
  return { ok: false, reason: 'resource-ownership-unknown' };
}

export type DeploymentPhase = 'planned' | 'applying' | 'configured' | 'awaiting' | 'drifted' | 'inconclusive' | 'failed' | 'verified';
export type DeploymentObservedOutcome = 'configured' | 'awaiting' | 'failed';
export type DeploymentEvent =
  | { readonly type: 'apply-started'; readonly operationId: string }
  | { readonly type: 'observed'; readonly outcome: DeploymentObservedOutcome }
  | { readonly type: 'remote-uncertain'; readonly reason: string }
  | { readonly type: 'resume-requested' }
  | { readonly type: 'drift-detected' }
  | { readonly type: 'evidence-observed'; readonly proof: ExternalEvidenceObservation };

export interface DeploymentStatus {
  readonly deploymentId: string;
  readonly phase: DeploymentPhase;
  readonly lastOperationId: Fact<string>;
  readonly nextAction: string;
}

export interface CreateDeploymentStatusParams {
  readonly deploymentId: string;
  readonly createdAt: string;
}

export function createDeploymentStatus(params: CreateDeploymentStatusParams): DeploymentStatus {
  return {
    deploymentId: params.deploymentId,
    phase: 'planned',
    lastOperationId: unknown('no-operation-recorded', params.createdAt),
    nextAction: 'prepare-plan',
  };
}

export function transitionDeployment(
  status: DeploymentStatus,
  event: DeploymentEvent,
  now: string,
): { readonly ok: true; readonly status: DeploymentStatus } | { readonly ok: false; readonly reason: string } {
  if (event.type === 'apply-started' && status.phase === 'planned') {
    return { ok: true, status: { ...status, phase: 'applying', lastOperationId: known(event.operationId), nextAction: 'observe-resources' } };
  }
  if (event.type === 'observed' && status.phase === 'applying') {
    if (event.outcome !== 'configured' && event.outcome !== 'awaiting' && event.outcome !== 'failed') {
      return { ok: false, reason: 'invalid-transition' };
    }
    const nextAction = event.outcome === 'configured' ? 'none' : 'inspect-diagnostics';
    return { ok: true, status: { ...status, phase: event.outcome, nextAction } };
  }
  if (event.type === 'remote-uncertain' && status.phase === 'applying') {
    return { ok: true, status: { ...status, phase: 'inconclusive', nextAction: 'observe-remote-state' } };
  }
  if (event.type === 'resume-requested' && status.phase === 'inconclusive') {
    return { ok: true, status: { ...status, phase: 'applying', nextAction: 'observe-resources' } };
  }
  if (event.type === 'drift-detected' && status.phase === 'configured') {
    return { ok: true, status: { ...status, phase: 'drifted', nextAction: 'reconcile-resources' } };
  }
  if (event.type === 'evidence-observed' && (status.phase === 'configured' || status.phase === 'awaiting')) {
    const operationId = status.lastOperationId.kind === 'known' ? status.lastOperationId.value : '';
    const validation = validateExternalEvidenceObservation(event.proof, status.deploymentId, operationId, now);
    if (!validation.ok) return validation;
    return { ok: true, status: { ...status, nextAction: 'evaluate-evidence-profile' } };
  }
  return { ok: false, reason: 'invalid-transition' };
}
