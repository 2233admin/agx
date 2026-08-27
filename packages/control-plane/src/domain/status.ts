import type { EvidenceReceipt } from './evidence';
import type { LaunchPlan } from './activation';
import type { StableConfigRevision } from './config';
import type { DeploymentStatus, Ownership } from './deployment';
import type { OperationJournalRecord } from './operation-journal';
import type { Fact } from './facts';

export type UnifiedStatusPhase = 'preflight-blocked' | 'manual-cleanup' | 'inconclusive' | 'needs-resume' | 'drifted' | 'failed' | 'cancelled' | 'incomplete' | 'applying' | 'observing' | 'awaiting' | 'configured' | 'succeeded' | 'verified';
export type StatusReadbackOutcome = 'matched' | 'missing' | 'modified' | 'unknown';
export type StatusReadbackKind = 'repository' | 'project' | 'provider';
export interface StatusReadback {
  readonly kind: StatusReadbackKind;
  readonly resourceId: string;
  readonly digest?: string;
  readonly ownership: Ownership;
  readonly outcome: StatusReadbackOutcome;
}
export interface StatusProjectionInput {
  readonly activeRevision: Fact<StableConfigRevision>;
  readonly deployment: DeploymentStatus;
  readonly operation: OperationJournalRecord;
  readonly launchPlans: readonly LaunchPlan[];
  readonly readbacks: readonly StatusReadback[];
  readonly evidence: EvidenceReceipt;
}
export interface StatusResourceSummary {
  readonly kind: StatusReadbackKind;
  readonly resourceId: string;
  readonly digest?: string;
  readonly ownership: Ownership;
  readonly outcome: StatusReadbackOutcome;
}
export interface UnifiedStatus {
  readonly phase: UnifiedStatusPhase;
  readonly deploymentId: string;
  readonly operationId: string;
  readonly revisionId?: string;
  readonly resources: readonly StatusResourceSummary[];
  readonly diagnostics: readonly string[];
  readonly missing: readonly string[];
  readonly nextActions: readonly string[];
}

const DIGEST = /^[a-f0-9]{64}$/;
const CODE = /^[A-Z0-9][A-Z0-9-]{0,127}$/;
const NEXT_ACTIONS: Record<UnifiedStatusPhase, string> = {
  'preflight-blocked': 'resolve-preflight', 'manual-cleanup': 'perform-manual-cleanup', inconclusive: 'observe-remote-state', 'needs-resume': 'resume-operation', drifted: 'reconcile-resources', failed: 'inspect-diagnostics', cancelled: 'start-new-operation', incomplete: 'inspect-diagnostics', applying: 'observe-resources', observing: 'record-outcome', awaiting: 'complete-first-use', configured: 'none', succeeded: 'none', verified: 'none',
};

function uniqueSorted(values: readonly string[]): readonly string[] { return [...new Set(values)].sort(); }
function validKnownRevision(fact: Fact<StableConfigRevision>): fact is { readonly kind: 'known'; readonly value: StableConfigRevision } { return fact.kind === 'known'; }
function readbackSummaries(readbacks: readonly StatusReadback[], diagnostics: string[]): readonly StatusResourceSummary[] {
  const sorted = [...readbacks].sort((left, right) => left.kind < right.kind ? -1 : left.kind > right.kind ? 1 : left.resourceId < right.resourceId ? -1 : left.resourceId > right.resourceId ? 1 : 0);
  return sorted.map((readback) => {
    const digest = readback.digest === undefined ? undefined : DIGEST.test(readback.digest) ? readback.digest : undefined;
    if (readback.digest !== undefined && digest === undefined) diagnostics.push('STATUS-READBACK-DIGEST-INVALID');
    return { kind: readback.kind, resourceId: readback.resourceId, ...(digest === undefined ? {} : { digest }), ownership: readback.ownership, outcome: readback.outcome };
  });

}
export function projectStatus(input: StatusProjectionInput): UnifiedStatus {
  const diagnostics: string[] = [];
  const missing: string[] = [];
  const resources = readbackSummaries(input.readbacks, diagnostics);
  for (const requirement of input.evidence.missing) if (CODE.test(requirement.code)) missing.push(requirement.code);
  for (const diagnostic of input.evidence.diagnostics) if (CODE.test(diagnostic.code)) diagnostics.push(diagnostic.code);
  const revisionId = validKnownRevision(input.activeRevision) ? input.activeRevision.value.revisionId : undefined;
  if (!validKnownRevision(input.activeRevision)) diagnostics.push('STATUS-CONFIG-UNKNOWN');
  if (input.operation.deploymentId !== input.deployment.deploymentId || input.deployment.lastOperationId.kind === 'known' && input.deployment.lastOperationId.value !== input.operation.operationId) diagnostics.push('STATUS-STALE-IDENTITY');
  if (input.deployment.lastOperationId.kind !== 'known') diagnostics.push('STATUS-DEPLOYMENT-OPERATION-UNKNOWN');
  for (const plan of input.launchPlans) {
    if (plan.operationId !== input.operation.operationId || revisionId !== undefined && plan.revisionId !== revisionId) diagnostics.push('STATUS-STALE-REVISION');
  }
  if (input.evidence.phase === 'blocked_preflight') diagnostics.push('STATUS-EVIDENCE-PREFLIGHT-BLOCKED');
  const manual = input.operation.phase === 'needs-manual-cleanup' || input.operation.steps.some((step) => step.phase === 'needs-manual-cleanup');
  const readbackUnknown = resources.some((resource) => resource.outcome === 'unknown');
  if (readbackUnknown) diagnostics.push('STATUS-READBACK-UNKNOWN');
  const uncertain = input.operation.phase === 'inconclusive' || input.operation.phase === 'needs-resume' || input.operation.steps.some((step) => step.phase === 'inconclusive') || readbackUnknown;
  const drifted = input.deployment.phase === 'drifted' || resources.some((resource) => resource.outcome === 'modified');
  const failed = input.deployment.phase === 'failed' || input.operation.phase === 'failed' || input.operation.phase === 'cancelled' || input.operation.phase === 'degraded' || input.launchPlans.some((plan) => plan.phase === 'failed' || plan.phase === 'cancelled');
  if (!DIGEST.test(input.evidence.deploymentDigest) || !DIGEST.test(input.evidence.subjectDigest)) diagnostics.push('STATUS-EVIDENCE-DIGEST-INVALID');
  const incomplete = input.launchPlans.some((plan) => plan.phase === 'incomplete');
  const observing = input.deployment.phase === 'applying' && input.launchPlans.some((plan) => plan.phase === 'observing');
  const applying = input.deployment.phase === 'applying' || input.operation.phase === 'applying' || input.launchPlans.some((plan) => plan.phase === 'applying');
  const awaiting = input.deployment.phase === 'awaiting' || input.launchPlans.some((plan) => plan.phase === 'awaiting-confirmation') || input.evidence.phase === 'awaiting_verification';
  const successful = input.deployment.phase === 'configured' && input.operation.phase === 'succeeded';
  const verified = successful && input.evidence.phase === 'verified' && input.evidence.missing.length === 0 && input.evidence.diagnostics.length === 0 && diagnostics.length === 0;
  const phase: UnifiedStatusPhase = !validKnownRevision(input.activeRevision) || diagnostics.includes('STATUS-STALE-IDENTITY') || diagnostics.includes('STATUS-STALE-REVISION') || diagnostics.includes('STATUS-DEPLOYMENT-OPERATION-UNKNOWN') || input.evidence.phase === 'blocked_preflight' ? 'preflight-blocked' : manual ? 'manual-cleanup' : uncertain ? (input.operation.phase === 'needs-resume' ? 'needs-resume' : 'inconclusive') : drifted ? 'drifted' : failed ? (input.operation.phase === 'cancelled' ? 'cancelled' : 'failed') : incomplete ? 'incomplete' : observing ? 'observing' : applying ? 'applying' : awaiting ? 'awaiting' : verified ? 'verified' : successful ? 'succeeded' : input.deployment.phase === 'configured' ? 'configured' : 'awaiting';
  return { phase, deploymentId: input.deployment.deploymentId, operationId: input.operation.operationId, ...(revisionId === undefined ? {} : { revisionId }), resources, diagnostics: uniqueSorted(diagnostics), missing: uniqueSorted(missing), nextActions: [NEXT_ACTIONS[phase]] };
}
