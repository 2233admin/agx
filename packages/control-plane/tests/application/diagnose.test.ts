import { expect, test } from 'bun:test';
import { diagnoseDeployment } from '../../src/application/diagnose';

test('diagnoseDeployment projects status without journal writes or raw payloads', () => {
  const result = diagnoseDeployment({
    activeRevision: { kind: 'unknown', reason: 'not-loaded', observedAt: '2026-01-01T00:00:00Z' },
    deployment: { deploymentId: 'dep-1', phase: 'planned', lastOperationId: { kind: 'unknown', reason: 'none', observedAt: '2026-01-01T00:00:00Z' }, reason: null, nextAction: 'prepare-plan' },
    operation: { operationId: 'op-1', deploymentId: 'dep-1', phase: 'prepared', steps: [], remoteRetention: 'retain', nextAction: 'start-operation' },
    launchPlans: [], readbacks: [],
    evidence: { phase: 'blocked_preflight', profile: 'github-delivery/v1', installationId: '', deploymentDigest: '', subjectDigest: '', evaluatedAt: '2026-01-01T00:00:00Z', satisfied: [], missing: [{ id: 'github.control-repository', code: 'MISSING' }], diagnostics: [], nextSteps: [], evidence: [] },
  });
  expect(result.phase).toBe('preflight-blocked');
  expect(result.diagnostics).toContain('STATUS-CONFIG-UNKNOWN');
  expect(Object.keys(result)).not.toContain('journalWrite');
});
