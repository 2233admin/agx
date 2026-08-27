import { describe, expect, test } from 'bun:test';
import { known, unknown } from '../../src/domain/facts';
import { projectStatus, type StatusProjectionInput } from '../../src/domain/status';
import type { EvidenceReceipt } from '../../src/domain/evidence';
import type { OperationJournalRecord } from '../../src/domain/operation-journal';
import type { LaunchPlan } from '../../src/domain/activation';
import type { StableConfigRevision } from '../../src/domain/config';

const revision = { configName: 'default', revisionId: 'rev-1', defaultMarker: known(true), scopeBoundary: known('project'), availability: known('resolved'), instructions: [], skills: [], mcp: [], hooks: [], plugins: [], triggerCategory: 'new-scenario', evidenceRef: 'evidence-1', supersedesRevisionId: null } as unknown as StableConfigRevision;
const operation = (phase: OperationJournalRecord['phase'] = 'succeeded'): OperationJournalRecord => ({ operationId: 'op-1', deploymentId: 'dep-1', phase, steps: [{ sequence: 1, kind: 'github-repository', resource: 'octocat/agent-control', phase: 'succeeded' }], remoteRetention: 'retain', nextAction: 'none' });
const launch = (phase: LaunchPlan['phase'] = 'succeeded'): LaunchPlan => ({ planId: 'plan-1', operationId: 'op-1', revisionId: 'rev-1', configName: 'default', client: 'omp', planHash: 'hash-1', phase, createdAt: '2026-01-01T00:00:00Z', confirmedAt: unknown('not-confirmed', '2026-01-01T00:00:00Z'), failureReason: unknown('none', '2026-01-01T00:00:00Z'), observedOutcome: phase === 'succeeded' ? known('succeeded') : unknown('not-observed', '2026-01-01T00:00:00Z') });
const evidence = (phase: EvidenceReceipt['phase'] = 'blocked_freshness'): EvidenceReceipt => ({ phase, profile: 'github-delivery/v1', installationId: 'install-0123456789abcdef', deploymentDigest: 'a'.repeat(64), subjectDigest: 'b'.repeat(64), evaluatedAt: '2026-01-01T00:00:00Z', satisfied: [], missing: [], diagnostics: [], nextSteps: [], evidence: [] });
const input = (overrides: Partial<StatusProjectionInput> = {}): StatusProjectionInput => ({ activeRevision: known(revision), deployment: { deploymentId: 'dep-1', phase: 'configured', lastOperationId: known('op-1'), reason: null, nextAction: 'none' }, operation: operation(), launchPlans: [launch()], readbacks: [], evidence: evidence(), ...overrides });

describe('projectStatus', () => {
  test('uses conservative precedence from blocked through configured and verified', () => {
    expect(projectStatus(input({ activeRevision: unknown('missing', '2026-01-01T00:00:00Z') })).phase).toBe('preflight-blocked');
    expect(projectStatus(input({ operation: operation('needs-manual-cleanup') })).phase).toBe('manual-cleanup');
    expect(projectStatus(input({ operation: operation('inconclusive') })).phase).toBe('inconclusive');
    expect(projectStatus(input({ deployment: { ...input().deployment, phase: 'drifted' } })).phase).toBe('drifted');
    expect(projectStatus(input({ launchPlans: [launch('failed')] })).phase).toBe('failed');
    expect(projectStatus(input({ launchPlans: [launch('applying')] })).phase).toBe('applying');
    expect(projectStatus(input({ deployment: { ...input().deployment, phase: 'awaiting' } })).phase).toBe('awaiting');
    expect(projectStatus(input()).phase).toBe('succeeded');
    expect(projectStatus(input({ evidence: evidence('verified') })).phase).toBe('verified');
  });

  test('does not overclaim verified for stale or unsuccessful identity/evidence', () => {
    expect(projectStatus(input({ evidence: { ...evidence('verified'), deploymentDigest: 'wrong' } })).phase).not.toBe('verified');
    expect(projectStatus(input({ operation: operation('failed'), evidence: evidence('verified') })).phase).not.toBe('verified');
    expect(projectStatus(input({ launchPlans: [launch('succeeded'), { ...launch(), planId: 'plan-2', revisionId: 'old-revision' }] })).diagnostics).toContain('STATUS-STALE-REVISION');
  });

  test('returns deterministic redaction-safe IDs, digests, ownership, missing codes, and actions', () => {
    const status = projectStatus(input({ readbacks: [{ kind: 'repository', resourceId: 'octocat/agent-control', digest: 'c'.repeat(64), ownership: 'created-by-configs', outcome: 'matched' }] }));
    expect(status).toEqual(expect.objectContaining({ deploymentId: 'dep-1', operationId: 'op-1', revisionId: 'rev-1', nextActions: expect.any(Array) }));
    expect(status.resources[0]).toEqual({ kind: 'repository', resourceId: 'octocat/agent-control', digest: 'c'.repeat(64), ownership: 'created-by-configs', outcome: 'matched' });
    expect(JSON.stringify(status)).not.toContain('prompt');
  });
  test('treats unknown external readback as inconclusive and keeps raw evidence out', () => {
    const status = projectStatus(input({ readbacks: [{ kind: 'project', resourceId: 'project-1', ownership: 'unknown', outcome: 'unknown' }] }));
    expect(status.phase).toBe('inconclusive');
    expect(JSON.stringify(status)).not.toContain('raw');
  });
});
