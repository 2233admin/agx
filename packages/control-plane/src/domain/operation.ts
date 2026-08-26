import { validateExternalEvidenceObservation, type ExternalEvidenceObservation } from './deployment';
export type OperationPhase =
  | 'prepared'
  | 'applying'
  | 'observing'
  | 'succeeded'
  | 'degraded'
  | 'failed'
  | 'cancelled'
  | 'inconclusive'
  | 'needs-resume'
  | 'needs-manual-cleanup'
  | 'verified';

export type OperationOutcome = 'succeeded' | 'degraded' | 'failed';
export type OperationEvent =
  | { readonly type: 'started' }
  | { readonly type: 'process-observed' }
  | { readonly type: 'observed'; readonly outcome: OperationOutcome }
  | { readonly type: 'failed'; readonly reason: string }
  | { readonly type: 'cancelled'; readonly reason: string }
  | { readonly type: 'remote-uncertain'; readonly reason: string }
  | { readonly type: 'resumed' }
  | { readonly type: 'manual-cleanup-required'; readonly reason: string }
  | { readonly type: 'evidence-observed'; readonly proof: ExternalEvidenceObservation }
  | { readonly type: 'verified' };

export interface OperationStatus {
  readonly operationId: string;
  readonly deploymentId: string;
  readonly phase: OperationPhase;
  readonly reason: string | null;
  readonly nextAction: string;
}

export interface CreateOperationStatusParams {
  readonly operationId: string;
  readonly deploymentId: string;
  readonly createdAt: string;
}

export function createOperationStatus(params: CreateOperationStatusParams): OperationStatus {
  return {
    operationId: params.operationId,
    deploymentId: params.deploymentId,
    phase: 'prepared',
    reason: null,
    nextAction: 'start-operation',
  };
}

export function transitionOperation(
  status: OperationStatus,
  event: OperationEvent,
  now: string,
): { readonly ok: true; readonly status: OperationStatus } | { readonly ok: false; readonly reason: string } {
  if (event.type === 'started' && status.phase === 'prepared') {
    return { ok: true, status: { ...status, phase: 'applying', nextAction: 'observe-operation' } };
  }
  if (event.type === 'process-observed' && status.phase === 'applying') {
    return { ok: true, status: { ...status, phase: 'observing', nextAction: 'record-outcome' } };
  }
  if (event.type === 'observed' && status.phase === 'observing') {
    const nextAction = event.outcome === 'succeeded' ? 'none' : 'inspect-diagnostics';
    return { ok: true, status: { ...status, phase: event.outcome, nextAction } };
  }
  if (event.type === 'failed' && (status.phase === 'applying' || status.phase === 'observing')) {
    return { ok: true, status: { ...status, phase: 'failed', reason: event.reason, nextAction: 'inspect-diagnostics' } };
  }
  if (event.type === 'cancelled' && (status.phase === 'prepared' || status.phase === 'applying' || status.phase === 'observing')) {
    return { ok: true, status: { ...status, phase: 'cancelled', reason: event.reason, nextAction: 'none' } };
  }
  if (event.type === 'remote-uncertain' && (status.phase === 'applying' || status.phase === 'observing')) {
    return { ok: true, status: { ...status, phase: 'inconclusive', reason: event.reason, nextAction: 'observe-remote-state' } };
  }
  if (event.type === 'resumed' && status.phase === 'inconclusive') {
    return { ok: true, status: { ...status, phase: 'applying', nextAction: 'observe-remote-state' } };
  }
  if (event.type === 'manual-cleanup-required' && (status.phase === 'inconclusive' || status.phase === 'failed')) {
    return { ok: true, status: { ...status, phase: 'needs-manual-cleanup', reason: event.reason, nextAction: 'manual-cleanup' } };
  }
  if (event.type === 'evidence-observed' && (status.phase === 'succeeded' || status.phase === 'degraded')) {
    const validation = validateExternalEvidenceObservation(event.proof, status.deploymentId, status.operationId, now);
    if (!validation.ok) return validation;
    return { ok: true, status: { ...status, nextAction: 'evaluate-evidence-profile' } };
  }
  if (event.type === 'verified') {
    return { ok: false, reason: 'verified-requires-external-evidence' };
  }
  return { ok: false, reason: 'invalid-transition' };
}
