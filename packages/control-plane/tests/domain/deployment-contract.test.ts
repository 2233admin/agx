import { describe, expect, test } from 'bun:test';
import { known, unknown } from '../../src/domain/facts';
import {
  authorizeOwnership,
  createDeploymentStatus,
  transitionDeployment as transitionDeploymentAt,
  validateExternalEvidenceObservation,
  type DeploymentEvent,
  type ExternalEvidenceObservation,
  type ResourceBinding,
} from '../../src/domain/deployment';
import {
  createOperationStatus,
  transitionOperation as transitionOperationAt,
} from '../../src/domain/operation';
import { PUBLIC_STATUS_FIELDS, redactStatus } from '../../src/domain/redaction';
const TEST_NOW = '2026-08-27T01:30:00.000Z';
const transitionDeployment = (status: Parameters<typeof transitionDeploymentAt>[0], event: Parameters<typeof transitionDeploymentAt>[1]) =>
  transitionDeploymentAt(status, event, TEST_NOW);
const transitionOperation = (status: Parameters<typeof transitionOperationAt>[0], event: Parameters<typeof transitionOperationAt>[1]) =>
  transitionOperationAt(status, event, TEST_NOW);
describe('deployment ownership and status', () => {
  test('only configs-owned resources may be mutated or deleted', () => {
    const owned: ResourceBinding = { kind: 'github-repository', resourceId: 'repo-1', ownership: 'created-by-configs', fingerprint: known('fp') };
    const existing: ResourceBinding = { ...owned, ownership: 'pre-existing' };
    const unknownResource: ResourceBinding = { ...owned, ownership: 'unknown', fingerprint: unknown('not-observed', '2026-08-27T00:00:00Z') };

    expect(authorizeOwnership(owned, 'mutate')).toEqual({ ok: true });
    expect(authorizeOwnership(owned, 'delete')).toEqual({ ok: true });
    expect(authorizeOwnership(existing, 'mutate')).toEqual({ ok: false, reason: 'resource-is-pre-existing' });
    expect(authorizeOwnership(unknownResource, 'delete')).toEqual({ ok: false, reason: 'resource-ownership-unknown' });
    expect(authorizeOwnership({ ...owned, fingerprint: unknown('not-observed', '2026-08-27T00:00:00Z') }, 'mutate')).toEqual({ ok: false, reason: 'resource-fingerprint-unknown' });
    expect(authorizeOwnership({ ...owned, fingerprint: known('') }, 'delete')).toEqual({ ok: false, reason: 'resource-fingerprint-invalid' });
  });

  test('deployment transitions are immutable and reject invalid phase changes', () => {
    const initial = createDeploymentStatus({ deploymentId: 'dep-1', createdAt: '2026-08-27T00:00:00Z' });
    const applying = transitionDeployment(initial, { type: 'apply-started', operationId: 'op-1' });
    expect(applying.ok).toBe(true);
    if (!applying.ok) return;
    expect(initial.phase).toBe('planned');
    expect(applying.status.phase).toBe('applying');
    expect(applying.status.lastOperationId).toEqual(known('op-1'));

    const configured = transitionDeployment(applying.status, { type: 'observed', outcome: 'configured' });
    expect(configured).toEqual({ ok: true, status: { ...applying.status, phase: 'configured', nextAction: 'none' } });
    if (!configured.ok) return;
    expect(transitionDeployment(configured.status, { type: 'apply-started', operationId: 'op-2' })).toEqual({ ok: false, reason: 'invalid-transition' });
    expect(transitionDeployment(applying.status, { type: 'observed', outcome: 'drifted' } as unknown as DeploymentEvent)).toEqual({ ok: false, reason: 'invalid-transition' });
    expect(transitionDeployment(applying.status, { type: 'observed', outcome: 'inconclusive' } as unknown as DeploymentEvent)).toEqual({ ok: false, reason: 'invalid-transition' });
  });
  test('requires a fresh external proof bound to deployment and operation', () => {
    const initial = createDeploymentStatus({ deploymentId: 'dep-1', createdAt: '2026-08-27T00:00:00Z' });
    const applying = transitionDeployment(initial, { type: 'apply-started', operationId: 'op-1' });
    if (!applying.ok) throw new Error('expected applying');
    const configured = transitionDeployment(applying.status, { type: 'observed', outcome: 'configured' });
    if (!configured.ok) throw new Error('expected configured');
    const proof: ExternalEvidenceObservation = {
      deploymentId: 'dep-1',
      operationId: 'op-1',
      profile: 'github-delivery/v1',
      subject: { kind: 'github-repository', id: 'repo-1' },
      source: 'github',
      evidenceId: 'github:issue/1',
      observedAt: '2026-08-27T00:00:00.000Z',
      expiresAt: '2026-08-27T02:00:00.000Z',
      verifiedAt: '2026-08-27T00:30:00.000Z',
    };
    expect(transitionDeployment(configured.status, { type: 'evidence-observed', proof })).toEqual({
      ok: true,
      status: { ...configured.status, phase: 'configured', nextAction: 'evaluate-evidence-profile' },
    });
    expect(transitionDeployment(configured.status, { type: 'evidence-observed', proof: { ...proof, evidenceId: 'local:runtime-success' } })).toEqual({
      ok: false,
      reason: 'invalid-external-evidence',
    });
    expect(transitionDeployment(configured.status, { type: 'evidence-observed', proof: { ...proof, operationId: 'other-operation' } })).toEqual({
      ok: false,
      reason: 'invalid-external-evidence',
    });
    expect(transitionDeployment(configured.status, { type: 'evidence-observed', proof: { ...proof, subject: null } as unknown as ExternalEvidenceObservation })).toEqual({
      ok: false,
      reason: 'invalid-external-evidence',
    });
  });
  test('rejects evidence evaluated before it starts or after expiry', () => {
    const proof: ExternalEvidenceObservation = {
      deploymentId: 'dep-1',
      operationId: 'op-1',
      profile: 'github-delivery/v1',
      subject: { kind: 'github-repository', id: 'repo-1' },
      source: 'github',
      evidenceId: 'github:issue/1',
      observedAt: '2026-08-27T01:00:00.000Z',
      expiresAt: '2026-08-27T02:00:00.000Z',
      verifiedAt: '2026-08-27T01:30:00.000Z',
    };
    expect(validateExternalEvidenceObservation(proof, 'dep-1', 'op-1', '2026-08-27T00:30:00.000Z')).toEqual({ ok: false, reason: 'invalid-external-evidence' });
    expect(validateExternalEvidenceObservation(proof, 'dep-1', 'op-1', '2026-08-27T02:00:00.000Z')).toEqual({ ok: false, reason: 'invalid-external-evidence' });
    expect(validateExternalEvidenceObservation(proof, 'dep-1', 'op-1', '2026-08-27T01:30:00.000Z')).toEqual({ ok: true });
  });
});

describe('operation status', () => {
  test('requires observation before success and preserves inconclusive remote results', () => {
    const prepared = createOperationStatus({ operationId: 'op-1', deploymentId: 'dep-1', createdAt: '2026-08-27T00:00:00Z' });
    expect(transitionOperation(prepared, { type: 'verified' })).toEqual({ ok: false, reason: 'verified-requires-external-evidence' });
    const applying = transitionOperation(prepared, { type: 'started' });
    expect(applying.ok).toBe(true);
    if (!applying.ok) return;
    const uncertain = transitionOperation(applying.status, { type: 'remote-uncertain', reason: 'readback-timeout' });
    expect(uncertain.ok).toBe(true);
    if (!uncertain.ok) return;
    expect(uncertain.status.phase).toBe('inconclusive');
    expect(transitionOperation(uncertain.status, { type: 'resumed' })).toEqual({ ok: true, status: { ...uncertain.status, phase: 'applying', nextAction: 'observe-remote-state' } });
  });

  test('terminal operation cannot become verified locally', () => {
    const prepared = createOperationStatus({ operationId: 'op-2', deploymentId: 'dep-1', createdAt: '2026-08-27T00:00:00Z' });
    const applying = transitionOperation(prepared, { type: 'started' });
    if (!applying.ok) throw new Error('expected applying');
    const observing = transitionOperation(applying.status, { type: 'process-observed' });
    if (!observing.ok) throw new Error('expected observing');
    const succeeded = transitionOperation(observing.status, { type: 'observed', outcome: 'succeeded' });
    if (!succeeded.ok) throw new Error('expected succeeded');
    expect(succeeded.status.phase).toBe('succeeded');
    expect(transitionOperation(succeeded.status, { type: 'verified' })).toEqual({ ok: false, reason: 'verified-requires-external-evidence' });
    const proof: ExternalEvidenceObservation = {
      deploymentId: 'dep-1',
      operationId: 'op-2',
      profile: 'github-delivery/v1',
      subject: { kind: 'github-project', id: 'project-1' },
      source: 'github',
      evidenceId: 'github:project/1',
      observedAt: '2026-08-27T00:00:00.000Z',
      expiresAt: '2026-08-27T02:00:00.000Z',
      verifiedAt: '2026-08-27T00:30:00.000Z',
    };
    expect(transitionOperation(succeeded.status, { type: 'evidence-observed', proof })).toEqual({
      ok: true,
      status: { ...succeeded.status, phase: 'succeeded', reason: null, nextAction: 'evaluate-evidence-profile' },
    });
    expect(transitionOperation(succeeded.status, { type: 'evidence-observed', proof: { ...proof, expiresAt: '2026-08-27T00:15:00.000Z' } })).toEqual({
      ok: false,
      reason: 'invalid-external-evidence',
    });
  });
});

describe('status redaction allowlist', () => {
  test('keeps only public status fields and removes private payloads', () => {
    expect(PUBLIC_STATUS_FIELDS).toContain('phase');
    expect(redactStatus({ deploymentId: 'dep-1', phase: 'configured', nextAction: 'none', token: 'secret', prompt: 'private', payload: { transcript: 'private' } })).toEqual({ deploymentId: 'dep-1', phase: 'configured', nextAction: 'none' });
  });
});
