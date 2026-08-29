export const FIRST_USE_CONTRACT_VERSION = 'agx.first-use/v1' as const;
export type FirstUseStatus = 'awaiting' | 'effective';
export type FirstUseValidationResult = 'awaiting' | 'passed' | 'pending_or_failed';

export interface FirstUseRepositoryIdentity { readonly owner: string; readonly name: string; readonly url: string; }
export interface FirstUseProjectIdentity { readonly owner: string; readonly number: number; readonly nodeId: string; readonly title: string; readonly url: string; }
export interface FirstUseValidation {
  readonly command: string;
  readonly workflow: string;
  readonly check: string;
  readonly workflowSHA256: string;
}
export interface FirstUseContract {
  readonly schemaVersion: typeof FIRST_USE_CONTRACT_VERSION;
  readonly installationId: string;
  readonly controlRepository: FirstUseRepositoryIdentity;
  readonly contractsRepository: FirstUseRepositoryIdentity;
  readonly project: FirstUseProjectIdentity;
  readonly profile: string;
  readonly objective: 'complete bootstrap verification';
  readonly issueTitle: string;
  readonly pullRequestTitle: string;
  readonly marker: string;
  readonly branch: string;
  readonly revision: string;
  readonly validation: FirstUseValidation;
  readonly requiredActions: readonly string[];
  readonly requiredOutputs: readonly string[];
  readonly cleanup: 'operator-owned';
}
export type FirstUseContractDecision =
  | { readonly kind: 'valid'; readonly contract: FirstUseContract }
  | { readonly kind: 'rejected'; readonly reason: 'malformed-schema' | 'invalid-identity' | 'invalid-marker' | 'invalid-branch' | 'invalid-revision' | 'invalid-validation' | 'invalid-actions' | 'unsafe-field' };

export interface FirstUseEvidenceSummary {
  readonly status: FirstUseStatus;
  readonly issueURL?: string;
  readonly issueNumber?: number;
  readonly projectItem?: string;
  readonly pullRequestURL?: string;
  readonly pullRequestNumber?: number;
  readonly revision?: string;
  readonly workPointer?: string;
  readonly validationResult?: FirstUseValidationResult;
  readonly problems?: readonly string[];
}
export type FirstUseEvidenceDecision =
  | { readonly kind: 'accepted'; readonly summary: FirstUseEvidenceSummary }
  | { readonly kind: 'rejected'; readonly reason: 'unsafe-field' | 'malformed-evidence' };

const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const REPOSITORY = /^[A-Za-z0-9_.-]{1,100}$/;
const SHA1 = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const NODE_ID = /^\S{1,256}$/;
const CONTROL = /[\u0000-\u001f\u007f]/;
const FORBIDDEN = new Set(['prompt', 'transcript', 'body', 'issuebody', 'tool_payload', 'credential', 'token', 'authorization']);
const CONTRACT_FIELDS = new Set(['schemaVersion', 'installationId', 'controlRepository', 'contractsRepository', 'project', 'profile', 'objective', 'issueTitle', 'pullRequestTitle', 'marker', 'branch', 'revision', 'validation', 'requiredActions', 'requiredOutputs', 'cleanup']);

function isRecord(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function validRepo(value: unknown): value is FirstUseRepositoryIdentity {
  if (!isRecord(value) || Object.keys(value).some((key) => !['owner', 'name', 'url'].includes(key))) return false;
  return typeof value.owner === 'string' && OWNER.test(value.owner) && typeof value.name === 'string' && REPOSITORY.test(value.name) && value.url === `https://github.com/${value.owner}/${value.name}`;
}
function validProject(value: unknown): value is FirstUseProjectIdentity {
  if (!isRecord(value) || Object.keys(value).some((key) => !['owner', 'number', 'nodeId', 'title', 'url'].includes(key))) return false;
  if (typeof value.owner !== 'string' || !OWNER.test(value.owner) || typeof value.number !== 'number' || !Number.isSafeInteger(value.number) || value.number <= 0 || typeof value.nodeId !== 'string' || !NODE_ID.test(value.nodeId) || CONTROL.test(value.nodeId) || typeof value.title !== 'string' || value.title.trim() === '' || CONTROL.test(value.title) || typeof value.url !== 'string') return false;
  const match = /^https:\/\/github\.com\/(?:orgs|users)\/([^/]+)\/projects\/(\d+)$/.exec(value.url);
  return match !== null && match[1] === value.owner && Number(match[2]) === value.number;
}
function hasForbidden(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasForbidden);
  if (!isRecord(value)) return false;
  return Object.entries(value).some(([key, child]) => FORBIDDEN.has(key.toLowerCase()) || hasForbidden(child));
}
export function validateFirstUseContract(input: unknown): FirstUseContractDecision {
  if (!isRecord(input) || hasForbidden(input)) return { kind: 'rejected', reason: hasForbidden(input) ? 'unsafe-field' : 'malformed-schema' };
  if (Object.keys(input).some((key) => !CONTRACT_FIELDS.has(key))) return { kind: 'rejected', reason: 'malformed-schema' };
  const value = input as Partial<FirstUseContract>;
  if (value.schemaVersion !== FIRST_USE_CONTRACT_VERSION || typeof value.installationId !== 'string' || !/^\S{1,128}$/.test(value.installationId) || !validRepo(value.controlRepository) || !validRepo(value.contractsRepository) || !validProject(value.project)) return { kind: 'rejected', reason: 'invalid-identity' };
  if (value.controlRepository.owner.toLowerCase() !== value.contractsRepository.owner.toLowerCase() || value.project.owner.toLowerCase() !== value.controlRepository.owner.toLowerCase()) return { kind: 'rejected', reason: 'invalid-identity' };
  if (value.marker !== `AGX-Installation: ${value.installationId}`) return { kind: 'rejected', reason: 'invalid-marker' };
  if (typeof value.branch !== 'string' || !value.branch.startsWith('agx/bootstrap-verification-')) return { kind: 'rejected', reason: 'invalid-branch' };
  if (typeof value.revision !== 'string' || !SHA1.test(value.revision)) return { kind: 'rejected', reason: 'invalid-revision' };
  if (!isRecord(value.validation) || Object.keys(value.validation).some((key) => !['command', 'workflow', 'check', 'workflowSHA256'].includes(key)) || typeof value.validation.command !== 'string' || value.validation.command === '' || typeof value.validation.workflow !== 'string' || value.validation.workflow === '' || typeof value.validation.check !== 'string' || value.validation.check === '' || typeof value.validation.workflowSHA256 !== 'string' || !SHA256.test(value.validation.workflowSHA256)) return { kind: 'rejected', reason: 'invalid-validation' };
  if (!Array.isArray(value.requiredActions) || value.requiredActions.length === 0 || !value.requiredActions.every((item) => typeof item === 'string' && item.length > 0 && !CONTROL.test(item)) || !Array.isArray(value.requiredOutputs) || !value.requiredOutputs.every((item) => typeof item === 'string' && item.length > 0 && !CONTROL.test(item)) || typeof value.profile !== 'string' || value.profile.trim() === '' || value.objective !== 'complete bootstrap verification' || value.cleanup !== 'operator-owned' || typeof value.issueTitle !== 'string' || value.issueTitle === '' || typeof value.pullRequestTitle !== 'string' || value.pullRequestTitle === '') return { kind: 'rejected', reason: 'invalid-actions' };
  return { kind: 'valid', contract: value as FirstUseContract };
}

function escaped(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function resourceNumber(value: unknown, base: string, resource: 'issues' | 'pull'): number | null {
  if (typeof value !== 'string' || value.length > 512 || CONTROL.test(value)) return null;
  const match = new RegExp(`^${escaped(base)}/${resource}/(\\d+)$`).exec(value);
  if (match === null || !Number.isSafeInteger(Number(match[1])) || Number(match[1]) <= 0 || String(Number(match[1])) !== match[1]) return null;
  return Number(match[1]);
}
function boundedText(value: unknown, max: number): value is string { return typeof value === 'string' && value.length <= max && !CONTROL.test(value); }

export function summarizeFirstUseEvidence(contractInput: unknown, input: unknown): FirstUseEvidenceDecision {
  const contractDecision = validateFirstUseContract(contractInput);
  if (contractDecision.kind !== 'valid') return { kind: 'rejected', reason: 'malformed-evidence' };
  if (!isRecord(input) || hasForbidden(input)) return { kind: 'rejected', reason: hasForbidden(input) ? 'unsafe-field' : 'malformed-evidence' };
  const allowed = new Set(['status', 'issueURL', 'issueNumber', 'projectItem', 'pullRequestURL', 'pullRequestNumber', 'revision', 'workPointer', 'validationResult', 'problems']);
  if (Object.keys(input).some((key) => !allowed.has(key))) return { kind: 'rejected', reason: 'unsafe-field' };
  if (input.status !== 'awaiting' && input.status !== 'effective') return { kind: 'rejected', reason: 'malformed-evidence' };
  const contract = contractDecision.contract;
  const issueNumber = input.issueURL === undefined ? null : resourceNumber(input.issueURL, contract.controlRepository.url, 'issues');
  const pullRequestNumber = input.pullRequestURL === undefined ? null : resourceNumber(input.pullRequestURL, contract.controlRepository.url, 'pull');
  if ((input.issueURL !== undefined && issueNumber === null) || (input.pullRequestURL !== undefined && pullRequestNumber === null) || (input.issueNumber !== undefined && (typeof input.issueNumber !== 'number' || !Number.isSafeInteger(input.issueNumber) || input.issueNumber <= 0)) || (input.pullRequestNumber !== undefined && (typeof input.pullRequestNumber !== 'number' || !Number.isSafeInteger(input.pullRequestNumber) || input.pullRequestNumber <= 0)) || (issueNumber !== null && input.issueNumber !== undefined && issueNumber !== input.issueNumber) || (pullRequestNumber !== null && input.pullRequestNumber !== undefined && pullRequestNumber !== input.pullRequestNumber)) return { kind: 'rejected', reason: 'malformed-evidence' };
  if (input.projectItem !== undefined && (!boundedText(input.projectItem, 256) || !NODE_ID.test(input.projectItem))) return { kind: 'rejected', reason: 'malformed-evidence' };
  if (input.workPointer !== undefined && input.workPointer !== 'work/current.md') return { kind: 'rejected', reason: 'malformed-evidence' };
  if (input.revision !== undefined && (input.revision !== contract.revision || !SHA1.test(input.revision))) return { kind: 'rejected', reason: 'malformed-evidence' };
  const summary: FirstUseEvidenceSummary = { status: input.status };
  for (const key of ['issueURL', 'projectItem', 'pullRequestURL', 'revision', 'workPointer'] as const) if (input[key] !== undefined) (summary as unknown as Record<string, unknown>)[key] = input[key];
  for (const key of ['issueNumber', 'pullRequestNumber'] as const) if (input[key] !== undefined) (summary as unknown as Record<string, unknown>)[key] = input[key];
  if (input.validationResult !== undefined && !['awaiting', 'passed', 'pending_or_failed'].includes(String(input.validationResult))) return { kind: 'rejected', reason: 'malformed-evidence' };
  if (input.validationResult !== undefined) (summary as unknown as Record<string, unknown>).validationResult = input.validationResult;
  if (input.problems !== undefined) { if (!Array.isArray(input.problems) || input.problems.length > 32 || !input.problems.every((item) => boundedText(item, 256))) return { kind: 'rejected', reason: 'malformed-evidence' }; (summary as unknown as Record<string, unknown>).problems = [...input.problems]; }
  return { kind: 'accepted', summary };
}
