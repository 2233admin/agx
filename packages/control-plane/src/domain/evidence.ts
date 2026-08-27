export const EVIDENCE_INPUT_SCHEMA_V1 = 'agx/evidence-input/v1';
export const EVIDENCE_OBSERVATION_SCHEMA_V1 = 'agx/evidence-observation/v1';
export const EVIDENCE_EVALUATOR_V1 = 'agx/evidence-evaluator/v1';
export const MAX_EVIDENCE_INPUT_BYTES = 1 << 20;
export const MAX_EVIDENCE_OBSERVATIONS = 128;
export const EVIDENCE_MAX_AGE_MS = 15 * 60 * 1000;

export type EvidenceProfile = 'github-delivery/v1' | 'multica-execution/v1';
export type EvidenceSource = 'github' | 'multica';
export type EvidenceKind =
  | 'github.control-repository.readback/v1' | 'github.contracts-repository.readback/v1' | 'github.project.readback/v1'
  | 'github.project-item.readback/v1' | 'github.contract-issue.readback/v1' | 'github.agent-first-write.readback/v1'
  | 'github.current-work.readback/v1' | 'github.delivery-pr.open/v1' | 'github.delivery-result.readback/v1'
  | 'github.checks.passed/v1' | 'github.independent-verifier.passed/v1'
  | 'multica.workspace.readback/v1' | 'multica.runtime.online/v1' | 'multica.agent.readback/v1'
  | 'multica.task.completed/v1' | 'multica.run.completed/v1';
export type ObservationOutcome = 'matched' | 'absent' | 'ambiguous' | 'drifted' | 'rejected';
export type EvidenceResourceType = 'repository' | 'project' | 'project_item' | 'issue' | 'commit' | 'pull_request' | 'check' | 'workspace' | 'runtime' | 'agent' | 'task' | 'run';

export interface EvidenceRef {
  readonly resourceType: EvidenceResourceType;
  readonly identitySHA256?: string;
  readonly uuid?: string;
  readonly number?: number;
  readonly revision?: string;
}

export interface EvidenceObservation {
  readonly schemaVersion: typeof EVIDENCE_OBSERVATION_SCHEMA_V1;
  readonly evaluatorVersion: typeof EVIDENCE_EVALUATOR_V1;
  readonly source: EvidenceSource;
  readonly kind: EvidenceKind;
  readonly installationId: string;
  readonly deploymentDigest: string;
  readonly subjectDigest: string;
  readonly ref: EvidenceRef;
  readonly fingerprint: string;
  readonly outcome: ObservationOutcome;
  readonly observedAt: string;
}

export interface EvidenceEvaluationInput {
  readonly schemaVersion: typeof EVIDENCE_INPUT_SCHEMA_V1;
  readonly evaluatorVersion: typeof EVIDENCE_EVALUATOR_V1;
  readonly installationId: string;
  readonly deploymentDigest: string;
  readonly subjectDigest: string;
  readonly profile: EvidenceProfile;
  readonly evaluatedAt: string;
  readonly observations: readonly EvidenceObservation[];
}

export type EvidencePhase = 'blocked_outcome' | 'blocked_freshness' | 'blocked_preflight' | 'awaiting_verification' | 'verified';
export interface EvidenceDiagnostic { readonly code: string; readonly category: 'preflight' | 'outcome' | 'freshness'; }
export interface EvidenceRequirementResult { readonly id: string; readonly code: string; }
export interface EvidenceObservationRef { readonly source: EvidenceSource; readonly kind: EvidenceKind; readonly fingerprint: string; readonly ref: EvidenceRef; readonly observedAt: string; }
export interface EvidenceReceipt {
  readonly phase: EvidencePhase;
  readonly profile: EvidenceProfile;
  readonly installationId: string;
  readonly deploymentDigest: string;
  readonly subjectDigest: string;
  readonly evaluatedAt: string;
  readonly satisfied: readonly EvidenceRequirementResult[];
  readonly missing: readonly EvidenceRequirementResult[];
  readonly diagnostics: readonly EvidenceDiagnostic[];
  readonly nextSteps: readonly string[];
  readonly evidence: readonly EvidenceObservationRef[];
}

interface Requirement { readonly id: string; readonly code: string; readonly next: string; readonly kinds: readonly EvidenceKind[]; }
const githubRequirements: readonly Requirement[] = [
  { id: 'github.control-repository', code: 'AGX-EVIDENCE-GITHUB-CONTROL-REPOSITORY-MISSING', next: 'read back the control repository', kinds: ['github.control-repository.readback/v1'] },
  { id: 'github.contracts-repository', code: 'AGX-EVIDENCE-GITHUB-CONTRACTS-REPOSITORY-MISSING', next: 'read back the contracts repository', kinds: ['github.contracts-repository.readback/v1'] },
  { id: 'github.project', code: 'AGX-EVIDENCE-GITHUB-PROJECT-MISSING', next: 'read back the deployment Project', kinds: ['github.project.readback/v1'] },
  { id: 'github.project-item', code: 'AGX-EVIDENCE-GITHUB-PROJECT-ITEM-MISSING', next: 'read back the Bootstrap Verification Project item', kinds: ['github.project-item.readback/v1'] },
  { id: 'github.contract-issue', code: 'AGX-EVIDENCE-GITHUB-CONTRACT-ISSUE-MISSING', next: 'read back the Bootstrap Verification Issue', kinds: ['github.contract-issue.readback/v1'] },
  { id: 'github.first-write', code: 'AGX-EVIDENCE-GITHUB-FIRST-WRITE-MISSING', next: 'read back the agent first write or current-work pointer', kinds: ['github.agent-first-write.readback/v1', 'github.current-work.readback/v1'] },
  { id: 'github.delivery', code: 'AGX-EVIDENCE-GITHUB-DELIVERY-RESULT-MISSING', next: 'read back an open delivery PR or delivery result', kinds: ['github.delivery-pr.open/v1', 'github.delivery-result.readback/v1'] },
  { id: 'github.verifier', code: 'AGX-EVIDENCE-GITHUB-VERIFIER-MISSING', next: 'read back all required checks or an independent verifier', kinds: ['github.checks.passed/v1', 'github.independent-verifier.passed/v1'] },
];
const multicaRequirements: readonly Requirement[] = [
  { id: 'multica.workspace', code: 'AGX-EVIDENCE-MULTICA-WORKSPACE-MISSING', next: 'read back the selected Multica Workspace', kinds: ['multica.workspace.readback/v1'] },
  { id: 'multica.runtime', code: 'AGX-EVIDENCE-MULTICA-RUNTIME-MISSING', next: 'read back the selected Multica Runtime as online', kinds: ['multica.runtime.online/v1'] },
  { id: 'multica.agent', code: 'AGX-EVIDENCE-MULTICA-AGENT-MISSING', next: 'read back the selected Multica Agent', kinds: ['multica.agent.readback/v1'] },
  { id: 'multica.execution', code: 'AGX-EVIDENCE-MULTICA-EXECUTION-MISSING', next: 'read back a completed Multica Task or Run', kinds: ['multica.task.completed/v1', 'multica.run.completed/v1'] },
];
const allKinds = new Set<EvidenceKind>([...githubRequirements, ...multicaRequirements].flatMap((r) => r.kinds));
const hex64 = /^[0-9a-f]{64}$/i;
const hex40 = /^[0-9a-f]{40}$/i;
const install = /^install-[0-9a-f]{16}$/;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function sourceForKind(kind: EvidenceKind): EvidenceSource { return kind.startsWith('multica.') ? 'multica' : 'github'; }
function resourceForKind(kind: EvidenceKind): EvidenceResourceType {
  if (kind.includes('repository')) return 'repository'; if (kind === 'github.project.readback/v1') return 'project'; if (kind === 'github.project-item.readback/v1') return 'project_item';
  if (kind.includes('contract-issue')) return 'issue'; if (kind.includes('delivery')) return 'pull_request'; if (kind.includes('checks')) return 'check';
  if (kind.includes('first-write') || kind.includes('current-work')) return 'commit'; if (kind.includes('workspace')) return 'workspace'; if (kind.includes('runtime')) return 'runtime'; if (kind.includes('agent')) return 'agent'; if (kind.includes('task')) return 'task'; return 'run';
}
function requiresRevision(kind: EvidenceKind): boolean { return kind.includes('first-write') || kind.includes('current-work') || kind.includes('delivery') || kind.includes('checks'); }
function relevant(profile: EvidenceProfile, kind: EvidenceKind): boolean { return profile === 'multica-execution/v1' || sourceForKind(kind) === 'github'; }
function diag(code: string, category: EvidenceDiagnostic['category']): EvidenceDiagnostic { return { code, category }; }
function uniqueDiagnostics(values: readonly EvidenceDiagnostic[]): readonly EvidenceDiagnostic[] { const seen = new Set<string>(); return values.filter((value) => !seen.has(value.code) && seen.add(value.code)); }

function validateRef(kind: EvidenceKind, ref: unknown): boolean {
  if (ref === null || typeof ref !== 'object') return false;
  const value = ref as Record<string, unknown>;
  if (Object.keys(value).some((key) => !['resourceType', 'identitySHA256', 'uuid', 'number', 'revision'].includes(key))) return false;
  if (value.resourceType !== resourceForKind(kind)) return false;
  if (value.identitySHA256 !== undefined && (typeof value.identitySHA256 !== 'string' || !hex64.test(value.identitySHA256))) return false;
  if (value.uuid !== undefined && (typeof value.uuid !== 'string' || !uuid.test(value.uuid))) return false;
  if (value.number !== undefined && (typeof value.number !== 'number' || !Number.isSafeInteger(value.number) || value.number <= 0)) return false;
  if (value.revision !== undefined && (typeof value.revision !== 'string' || !hex40.test(value.revision))) return false;
  if (requiresRevision(kind) !== (value.revision !== undefined)) return false;
  if (kind.startsWith('multica.') && (kind.includes('workspace') || kind.includes('runtime') || kind.includes('agent'))) return typeof value.uuid === 'string' && value.identitySHA256 === undefined && value.number === undefined;
  if (kind.includes('contract-issue') || kind.includes('delivery') || kind.includes('project-item')) return typeof value.number === 'number' && value.uuid === undefined && value.identitySHA256 === undefined;
  return (typeof value.identitySHA256 === 'string') !== (typeof value.uuid === 'string') && value.number === undefined;
}

function validateObservation(value: unknown): boolean {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const observation = value as Record<string, unknown>;
  if (Object.keys(observation).some((key) => !['schemaVersion', 'evaluatorVersion', 'source', 'kind', 'installationId', 'deploymentDigest', 'subjectDigest', 'ref', 'fingerprint', 'outcome', 'observedAt'].includes(key))) return false;
  return observation.schemaVersion === EVIDENCE_OBSERVATION_SCHEMA_V1 && observation.evaluatorVersion === EVIDENCE_EVALUATOR_V1 &&
    (observation.source === 'github' || observation.source === 'multica') && typeof observation.kind === 'string' && allKinds.has(observation.kind as EvidenceKind) &&
    typeof observation.installationId === 'string' && typeof observation.deploymentDigest === 'string' && typeof observation.subjectDigest === 'string' && typeof observation.fingerprint === 'string' &&
    hex64.test(observation.deploymentDigest) && hex64.test(observation.subjectDigest) && hex64.test(observation.fingerprint) && typeof observation.outcome === 'string' &&
    ['matched', 'absent', 'ambiguous', 'drifted', 'rejected'].includes(observation.outcome) && typeof observation.observedAt === 'string' && Number.isFinite(Date.parse(observation.observedAt)) &&
    validateRef(observation.kind as EvidenceKind, observation.ref);
}

function duplicateKeysOrMalformed(value: string): boolean {
  let index = 0;
  const whitespace = () => { while (/\s/.test(value[index] ?? '')) index += 1; };
  const stringValue = (): string | null => { if (value[index] !== '"') return null; const start = index++; while (index < value.length) { if (value[index] === '\\') index += 2; else if (value[index++] === '"') { try { return JSON.parse(value.slice(start, index)) as string; } catch { return null; } } } return null; };
  const parseValue = (): boolean => { whitespace(); if (value[index] === '{') { index += 1; whitespace(); const keys = new Set<string>(); if (value[index] === '}') { index += 1; return true; } while (index < value.length) { const key = stringValue(); if (key === null || keys.has(key)) return false; keys.add(key); whitespace(); if (value[index++] !== ':' || !parseValue()) return false; whitespace(); if (value[index] === '}') { index += 1; return true; } if (value[index++] !== ',') return false; whitespace(); } return false; } if (value[index] === '[') { index += 1; whitespace(); if (value[index] === ']') { index += 1; return true; } while (index < value.length) { if (!parseValue()) return false; whitespace(); if (value[index] === ']') { index += 1; return true; } if (value[index++] !== ',') return false; whitespace(); } return false; } if (value[index] === '"') return stringValue() !== null; const literal = /^(?:-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?|true|false|null)/.exec(value.slice(index)); if (literal === null) return false; index += literal[0].length; return true; };
  if (!parseValue()) return true; whitespace(); return index !== value.length;
}

export type EvidenceDecodeResult = { readonly kind: 'accepted'; readonly input: EvidenceEvaluationInput } | { readonly kind: 'rejected'; readonly reason: string };
export function decodeEvidenceInput(text: string): EvidenceDecodeResult {
  if (new TextEncoder().encode(text).byteLength > MAX_EVIDENCE_INPUT_BYTES) return { kind: 'rejected', reason: 'input-too-large' };
  if (duplicateKeysOrMalformed(text)) return { kind: 'rejected', reason: 'input-invalid' };
  let value: unknown; try { value = JSON.parse(text); } catch { return { kind: 'rejected', reason: 'input-invalid' }; }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return { kind: 'rejected', reason: 'input-invalid' };
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !['schemaVersion', 'evaluatorVersion', 'installationId', 'deploymentDigest', 'subjectDigest', 'profile', 'evaluatedAt', 'observations'].includes(key)) || !Array.isArray(record.observations) || record.observations.length > MAX_EVIDENCE_OBSERVATIONS || !record.observations.every(validateObservation)) return { kind: 'rejected', reason: 'input-invalid' };
  if (record.schemaVersion !== EVIDENCE_INPUT_SCHEMA_V1 || record.evaluatorVersion !== EVIDENCE_EVALUATOR_V1 || !install.test(String(record.installationId)) || !hex64.test(String(record.deploymentDigest)) || !hex64.test(String(record.subjectDigest)) || !['github-delivery/v1', 'multica-execution/v1'].includes(String(record.profile)) || typeof record.evaluatedAt !== 'string' || !Number.isFinite(Date.parse(record.evaluatedAt))) return { kind: 'rejected', reason: 'input-invalid' };
  return { kind: 'accepted', input: record as unknown as EvidenceEvaluationInput };
}

function envelopeDiagnostics(input: EvidenceEvaluationInput): EvidenceDiagnostic[] {
  const result: EvidenceDiagnostic[] = [];
  if (input.schemaVersion !== EVIDENCE_INPUT_SCHEMA_V1) result.push(diag('AGX-EVIDENCE-SCHEMA-UNSUPPORTED', 'preflight'));
  if (input.evaluatorVersion !== EVIDENCE_EVALUATOR_V1) result.push(diag('AGX-EVIDENCE-EVALUATOR-UNSUPPORTED', 'preflight'));
  if (input.profile !== 'github-delivery/v1' && input.profile !== 'multica-execution/v1') result.push(diag('AGX-EVIDENCE-PROFILE-UNSUPPORTED', 'preflight'));
  if (!install.test(input.installationId)) result.push(diag('AGX-EVIDENCE-INSTALLATION-INVALID', 'preflight'));
  if (!hex64.test(input.deploymentDigest) || !hex64.test(input.subjectDigest)) result.push(diag('AGX-EVIDENCE-SUBJECT-INCOMPLETE', 'preflight'));
  if (!Number.isFinite(Date.parse(input.evaluatedAt))) result.push(diag('AGX-EVIDENCE-EVALUATED-AT-INVALID', 'preflight'));
  if (input.observations.length > MAX_EVIDENCE_OBSERVATIONS) result.push(diag('AGX-EVIDENCE-OBSERVATION-LIMIT', 'preflight'));
  for (const observation of input.observations) if (!validateObservation(observation)) result.push(diag('AGX-EVIDENCE-OBSERVATION-INVALID', 'preflight'));
  return result;
}

function requirementSet(profile: EvidenceProfile): readonly Requirement[] { return profile === 'multica-execution/v1' ? [...githubRequirements, ...multicaRequirements] : githubRequirements; }
function observationKey(value: EvidenceObservation): string { return JSON.stringify({ source: value.source, kind: value.kind, ref: value.ref }); }
function observationSortKey(value: EvidenceObservation): string { return JSON.stringify(value); }

export function evaluateEvidence(input: EvidenceEvaluationInput, now: string): EvidenceReceipt {
  const requirements = requirementSet(input.profile);
  const initialDiagnostics = envelopeDiagnostics(input);
  const base: EvidenceReceipt = { phase: 'blocked_preflight', profile: input.profile, installationId: input.installationId, deploymentDigest: input.deploymentDigest, subjectDigest: input.subjectDigest, evaluatedAt: now, satisfied: [], missing: requirements.map(({ id, code }) => ({ id, code })), diagnostics: uniqueDiagnostics(initialDiagnostics), nextSteps: requirements.map(({ next }) => next), evidence: [] };
  if (initialDiagnostics.length > 0) return base;
  const identity = new Map<string, EvidenceObservation>(); const ambiguous = new Set<string>(); const diagnostics: EvidenceDiagnostic[] = [];
  for (const observation of [...input.observations].sort((a, b) => observationSortKey(a).localeCompare(observationSortKey(b)))) {
    const key = observationKey(observation); const previous = identity.get(key);
    if (previous !== undefined) { if (observationSortKey(previous) !== observationSortKey(observation)) { ambiguous.add(key); diagnostics.push(diag('AGX-EVIDENCE-OBSERVATION-AMBIGUOUS', 'outcome')); } continue; }
    identity.set(key, observation);
  }
  const validByKind = new Map<EvidenceKind, EvidenceObservation[]>(); let freshnessBlocked = false; let outcomeBlocked = diagnostics.length > 0; const evaluatedMs = Date.parse(now);
  for (const [key, observation] of identity) {
    if (ambiguous.has(key)) continue;
    if (observation.source !== sourceForKind(observation.kind)) { diagnostics.push(diag('AGX-EVIDENCE-SOURCE-MISMATCH', 'preflight')); continue; }
    if (!relevant(input.profile, observation.kind)) continue;
    if (observation.installationId !== input.installationId) { diagnostics.push(diag('AGX-EVIDENCE-INSTALLATION-MISMATCH', 'outcome')); outcomeBlocked = true; continue; }
    if (observation.deploymentDigest !== input.deploymentDigest || observation.subjectDigest !== input.subjectDigest) { diagnostics.push(diag('AGX-EVIDENCE-BINDING-MISMATCH', 'outcome')); outcomeBlocked = true; continue; }
    if (observation.outcome !== 'matched') { diagnostics.push(diag('AGX-EVIDENCE-OBSERVATION-NOT-MATCHED', 'outcome')); outcomeBlocked = true; continue; }
    const observedMs = Date.parse(observation.observedAt);
    if (observedMs > evaluatedMs) { diagnostics.push(diag('AGX-EVIDENCE-OBSERVATION-FUTURE', 'freshness')); freshnessBlocked = true; continue; }
    if (!Number.isFinite(evaluatedMs) || evaluatedMs - observedMs >= EVIDENCE_MAX_AGE_MS) { diagnostics.push(diag('AGX-EVIDENCE-OBSERVATION-EXPIRED', 'freshness')); freshnessBlocked = true; continue; }
    const values = validByKind.get(observation.kind) ?? []; values.push(observation); validByKind.set(observation.kind, values);
  }
  for (const [kind, values] of validByKind) if (values.length > 1) { diagnostics.push(diag('AGX-EVIDENCE-OBSERVATION-AMBIGUOUS', 'outcome')); outcomeBlocked = true; validByKind.delete(kind); }
  let revision: string | null = null; let revisionMismatch = false;
  for (const [kind, values] of validByKind) if (requiresRevision(kind) && values.length === 1) { const value = values[0]?.ref.revision ?? ''; if (revision === null) revision = value; else if (revision !== value) revisionMismatch = true; }
  if (revisionMismatch) { diagnostics.push(diag('AGX-EVIDENCE-REVISION-MISMATCH', 'outcome')); outcomeBlocked = true; }
  const satisfied: EvidenceRequirementResult[] = []; const missing: EvidenceRequirementResult[] = []; const nextSteps: string[] = []; const evidence: EvidenceObservationRef[] = [];
  for (const requirement of requirements) {
    const selected = requirement.kinds.map((kind) => validByKind.get(kind)?.[0]).find((value) => value !== undefined && (!revisionMismatch || !requiresRevision(value.kind)));
    if (selected === undefined) { missing.push({ id: requirement.id, code: requirement.code }); nextSteps.push(requirement.next); }
    else { satisfied.push({ id: requirement.id, code: requirement.code }); evidence.push({ source: selected.source, kind: selected.kind, fingerprint: selected.fingerprint, ref: selected.ref, observedAt: selected.observedAt }); }
  }
  const finalDiagnostics = uniqueDiagnostics(diagnostics); const phase: EvidencePhase = finalDiagnostics.some((item) => item.category === 'preflight') ? 'blocked_preflight' : outcomeBlocked ? 'blocked_outcome' : freshnessBlocked ? 'blocked_freshness' : missing.length === 0 ? 'verified' : 'awaiting_verification';
  return { ...base, phase, satisfied, missing, diagnostics: finalDiagnostics, nextSteps, evidence };
}
