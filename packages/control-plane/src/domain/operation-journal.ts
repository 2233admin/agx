export type OperationStepKind = 'github-repository' | 'github-project' | 'provider-activation';
export type OperationStepPhase = 'pending' | 'succeeded' | 'inconclusive' | 'needs-manual-cleanup';

export interface OperationStep {
  readonly sequence: number;
  readonly kind: OperationStepKind;
  readonly resource: string;
  readonly phase: OperationStepPhase;
  readonly reason?: string;
}

export type OperationJournalPhase =
  | 'prepared' | 'applying' | 'observing' | 'succeeded' | 'degraded' | 'failed'
  | 'cancelled' | 'inconclusive' | 'needs-resume' | 'needs-manual-cleanup';

export interface OperationJournalRecord {
  readonly operationId: string;
  readonly deploymentId: string;
  readonly revisionId?: string;
  readonly phase: OperationJournalPhase;
  readonly steps: readonly OperationStep[];
  readonly resolutions?: readonly OperationResolution[];
  readonly remoteRetention: 'retain';
  readonly nextAction: string;
}
export const OPERATION_RESOLUTION_MAX_AGE_MS = 15 * 60 * 1000;
export type ResolutionOutcome = 'matched' | 'absent' | 'drifted';
export interface OperationResolution {
  readonly operationId: string;
  readonly deploymentId: string;
  readonly sequence: number;
  readonly kind: OperationStepKind;
  readonly resource: string;
  readonly outcome: ResolutionOutcome;
  readonly fingerprint: string;
  readonly observedAt: string;
}

export interface OperationPlanStep {
  readonly kind: OperationStepKind;
  readonly resource: string;
}

export interface OperationPlanInput {
  readonly operationId: string;
  readonly deploymentId: string;
  readonly revisionId: string;
  readonly steps: readonly OperationPlanStep[];
}

const STEP_REASON = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const RESOURCE_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const MAX_STEP_REASON_LENGTH = 128;

export function createOperationJournal(input: OperationPlanInput): OperationJournalRecord {
  if (input.operationId.trim() === '' || input.deploymentId.trim() === '' || input.revisionId.trim() === '' || input.steps.length === 0) throw new Error('invalid operation plan');
  const steps = input.steps.map((step, index) => {
    if (!RESOURCE_ID.test(step.resource)) throw new Error('invalid operation plan step');
    return { sequence: index + 1, kind: step.kind, resource: step.resource, phase: 'pending' as const };
  });
  return { operationId: input.operationId, deploymentId: input.deploymentId, revisionId: input.revisionId, phase: 'prepared', steps, resolutions: [], remoteRetention: 'retain', nextAction: 'start-operation' };
}
export function appendOperationStep(record: OperationJournalRecord, step: OperationStep): OperationJournalRecord {
  if (step.phase === ('verified' as OperationStepPhase)) throw new Error('verified requires evaluator-approved evidence');
  const pending = record.steps.find((value) => value.phase === 'pending');
  if (pending === undefined || step.sequence !== pending.sequence) throw new Error('operation step sequence is not append-only');
  if (step.kind !== pending.kind || step.resource !== pending.resource) throw new Error('operation step does not match plan');
  if (step.reason !== undefined && (step.reason.length > MAX_STEP_REASON_LENGTH || !STEP_REASON.test(step.reason))) throw new Error('invalid operation step reason');
  const steps = record.steps.map((value) => value.sequence === step.sequence ? step : value);
  if (step.phase === 'inconclusive') return { ...record, steps, phase: 'inconclusive', nextAction: 'observe-remote-state' };
  if (step.phase === 'needs-manual-cleanup') return { ...record, steps, phase: 'needs-manual-cleanup', nextAction: 'manual-cleanup' };
  return { ...record, steps };
}

export function startOperationJournal(record: OperationJournalRecord): OperationJournalRecord {
  if (record.phase !== 'prepared' && record.phase !== 'needs-resume') throw new Error('operation is not resumable');
  return { ...record, phase: 'applying', nextAction: 'observe-operation' };
}

export function resolveInconclusiveOperation(
  record: OperationJournalRecord,
  resolution: OperationResolution,
  now: string,
): OperationJournalRecord {
  const pending = record.steps.find((step) => step.phase === 'inconclusive' || step.phase === 'pending');
  if (record.phase !== 'inconclusive' || pending === undefined ||
      resolution.operationId !== record.operationId || resolution.deploymentId !== record.deploymentId ||
      resolution.sequence !== pending.sequence || resolution.kind !== pending.kind || resolution.resource !== pending.resource ||
      !/^[a-f0-9]{64}$/.test(resolution.fingerprint) || !Number.isFinite(Date.parse(resolution.observedAt)) || !Number.isFinite(Date.parse(now)) ||
      Date.parse(resolution.observedAt) > Date.parse(now) || Date.parse(now) - Date.parse(resolution.observedAt) >= OPERATION_RESOLUTION_MAX_AGE_MS) {
    throw new Error('invalid operation resolution');
  }
  if (resolution.outcome !== 'matched') return { ...record, resolutions: [...(record.resolutions ?? []), resolution], phase: 'needs-manual-cleanup', nextAction: 'manual-cleanup' };
  const steps = record.steps.map((step) => step.sequence === pending.sequence ? { sequence: step.sequence, kind: step.kind, resource: step.resource, phase: 'pending' as const } : step);
  return { ...record, steps, resolutions: [...(record.resolutions ?? []), resolution], phase: 'needs-resume', nextAction: 'resume-operation' };
}

export function finishOperationJournal(record: OperationJournalRecord, phase: Extract<OperationJournalPhase, 'succeeded' | 'failed' | 'cancelled'>, reason?: string): OperationJournalRecord {
  if (record.phase !== 'applying' && record.phase !== 'observing') throw new Error('operation is not applying');
  if (reason !== undefined && (reason.length > MAX_STEP_REASON_LENGTH || !STEP_REASON.test(reason))) throw new Error('invalid operation reason');
  return { ...record, phase, nextAction: phase === 'succeeded' || phase === 'cancelled' ? 'none' : 'inspect-diagnostics', ...(reason === undefined ? {} : { reason }) };
}
