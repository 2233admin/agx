import { describe, expect, test } from 'bun:test';

import {
  EVIDENCE_EVALUATOR_V1,
  EVIDENCE_INPUT_SCHEMA_V1,
  EVIDENCE_OBSERVATION_SCHEMA_V1,
  MAX_EVIDENCE_INPUT_BYTES,
  evaluateEvidence,
  decodeEvidenceInput,
  type EvidenceEvaluationInput,
  type EvidenceKind,
} from '../../src/domain/evidence';

const INSTALLATION_ID = 'install-0123456789abcdef';
const DEPLOYMENT_DIGEST = '1'.repeat(64);
const SUBJECT_DIGEST = '2'.repeat(64);
const FINGERPRINT = '3'.repeat(64);
const NOW = '2026-08-27T00:00:00.000Z';

const githubKinds: readonly EvidenceKind[] = [
  'github.control-repository.readback/v1', 'github.contracts-repository.readback/v1', 'github.project.readback/v1',
  'github.project-item.readback/v1', 'github.contract-issue.readback/v1', 'github.agent-first-write.readback/v1',
  'github.delivery-pr.open/v1', 'github.checks.passed/v1',
];

function refFor(kind: EvidenceKind, index: number): Record<string, unknown> {
  const resourceType = kind.includes('first-write') || kind.includes('current-work') ? 'commit' :
    kind.startsWith('github.project') ? kind === 'github.project.readback/v1' ? 'project' : 'project_item' :
      kind.includes('repository') ? 'repository' : kind.includes('issue') ? 'issue' : kind.includes('delivery') ? 'pull_request' :
        kind.includes('checks') ? 'check' : kind.includes('workspace') ? 'workspace' : kind.includes('runtime') ? 'runtime' :
          kind.includes('agent') ? 'agent' : kind.includes('task') ? 'task' : kind.includes('run') ? 'run' : 'commit';
  const ref: Record<string, unknown> = { resourceType };
  if (kind.startsWith('multica.workspace') || kind.startsWith('multica.runtime') || kind.startsWith('multica.agent')) ref.uuid = 'd3baaa7b-1111-4111-8111-111111111111';
  else if (kind.includes('first-write') || kind.includes('delivery') || kind.includes('checks')) ref.revision = 'a'.repeat(40);
  if (kind.includes('issue') || kind.includes('delivery') || kind.includes('project-item')) ref.number = index + 1;
  else if (!kind.startsWith('multica.workspace') && !kind.startsWith('multica.runtime') && !kind.startsWith('multica.agent')) ref.identitySHA256 = `${index + 4}`.repeat(64).slice(0, 64);
  return ref;
}

function observation(kind: EvidenceKind, index: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: EVIDENCE_OBSERVATION_SCHEMA_V1, evaluatorVersion: EVIDENCE_EVALUATOR_V1, source: kind.startsWith('multica.') ? 'multica' : 'github',
    kind, installationId: INSTALLATION_ID, deploymentDigest: DEPLOYMENT_DIGEST, subjectDigest: SUBJECT_DIGEST,
    ref: refFor(kind, index), fingerprint: FINGERPRINT, outcome: 'matched', observedAt: NOW, ...overrides,
  };
}

function input(profile: 'github-delivery/v1' | 'multica-execution/v1', observations: readonly Record<string, unknown>[]): EvidenceEvaluationInput {
  return {
    schemaVersion: EVIDENCE_INPUT_SCHEMA_V1, evaluatorVersion: EVIDENCE_EVALUATOR_V1, installationId: INSTALLATION_ID,
    deploymentDigest: DEPLOYMENT_DIGEST, subjectDigest: SUBJECT_DIGEST, profile, evaluatedAt: NOW, observations,
  } as unknown as EvidenceEvaluationInput;
}

describe('Evidence evaluator', () => {
  test('verifies complete fresh GitHub delivery evidence only', () => {
    const result = evaluateEvidence(input('github-delivery/v1', githubKinds.map((kind, index) => observation(kind, index))), NOW);
    expect(result.phase).toBe('verified');
    expect(result.satisfied).toHaveLength(8);
    expect(result.missing).toHaveLength(0);
    expect(result.evidence).toHaveLength(8);
  });

  test('multica profile adds Workspace, Runtime, Agent, and completed Task-or-Run requirements', () => {
    const kinds: EvidenceKind[] = [...githubKinds, 'multica.workspace.readback/v1', 'multica.runtime.online/v1', 'multica.agent.readback/v1', 'multica.task.completed/v1'];
    const result = evaluateEvidence(input('multica-execution/v1', kinds.map((kind, index) => observation(kind, index))), NOW);
    expect(result.phase).toBe('verified');
    expect(result.satisfied).toHaveLength(12);
  });

  test('missing evidence awaits verification and never claims verified', () => {
    const result = evaluateEvidence(input('github-delivery/v1', githubKinds.slice(0, 2).map((kind, index) => observation(kind, index))), NOW);
    expect(result.phase).toBe('awaiting_verification');
    expect(result.missing.length).toBe(6);
  });

  test('stale evidence blocks freshness, while non-matched outcome blocks outcome', () => {
    const stale = evaluateEvidence(input('github-delivery/v1', githubKinds.map((kind, index) => observation(kind, index, { observedAt: '2026-08-26T23:44:59.000Z' }))), NOW);
    expect(stale.phase).toBe('blocked_freshness');
    const outcome = evaluateEvidence(input('github-delivery/v1', githubKinds.map((kind, index) => observation(kind, index, { outcome: 'absent' }))), NOW);
    expect(outcome.phase).toBe('blocked_outcome');
  });

  test('conflicting singleton observations and binding mismatches block outcome/preflight', () => {
    const duplicate = [observation(githubKinds[0]!, 0), observation(githubKinds[0]!, 0, { fingerprint: '4'.repeat(64) })];
    expect(evaluateEvidence(input('github-delivery/v1', duplicate), NOW).phase).toBe('blocked_outcome');
    const mismatch = [observation(githubKinds[0]!, 0, { installationId: 'install-fedcba9876543210' })];
    expect(evaluateEvidence(input('github-delivery/v1', mismatch), NOW).phase).toBe('blocked_outcome');
  });

  test('decoder rejects unknown, duplicate, trailing, and oversized input', () => {
    expect(decodeEvidenceInput('{"schemaVersion":"x","unexpected":1}').kind).toBe('rejected');
    expect(decodeEvidenceInput('{"schemaVersion":"x","schemaVersion":"y"}').kind).toBe('rejected');
    expect(decodeEvidenceInput('{} {}').kind).toBe('rejected');
    expect(decodeEvidenceInput('x'.repeat(MAX_EVIDENCE_INPUT_BYTES + 1)).kind).toBe('rejected');
    const validEnvelope = input('github-delivery/v1', []);
    for (const invalidObservation of [null, 42, []]) {
      expect(decodeEvidenceInput(JSON.stringify({ ...validEnvelope, observations: [invalidObservation] })).kind).toBe('rejected');
    }
  });
});
