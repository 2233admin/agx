import { describe, expect, test } from 'bun:test';
import {
  FIRST_USE_CONTRACT_VERSION,
  summarizeFirstUseEvidence,
  validateFirstUseContract,
  type FirstUseContract,
} from '../../src/domain/first-use';

const contract = (): FirstUseContract => ({
  schemaVersion: FIRST_USE_CONTRACT_VERSION,
  installationId: 'install-0123456789abcdef',
  controlRepository: { owner: 'octocat', name: 'agent-control', url: 'https://github.com/octocat/agent-control' },
  contractsRepository: { owner: 'octocat', name: 'agent-contracts', url: 'https://github.com/octocat/agent-contracts' },
  project: { owner: 'octocat', number: 7, nodeId: 'PVT_1', title: 'Agent System', url: 'https://github.com/users/octocat/projects/7' },
  profile: 'default',
  objective: 'complete bootstrap verification',
  issueTitle: 'Bootstrap Verification',
  pullRequestTitle: 'Bootstrap Verification',
  marker: 'AGX-Installation: install-0123456789abcdef',
  branch: 'agx/bootstrap-verification-install-0123456789abcdef',
  revision: 'a'.repeat(40),
  validation: { command: 'python3 tools/validate.py', workflow: 'Validation', check: 'validate', workflowSHA256: 'b'.repeat(64) },
  requiredActions: ['create-issue', 'open-pull-request'],
  requiredOutputs: ['issue', 'pull-request'],
  cleanup: 'operator-owned',
});

describe('first-use contract', () => {
  test('accepts the bounded identity, marker, revision, workflow, actions, and cleanup contract', () => {
    expect(validateFirstUseContract(contract())).toEqual({ kind: 'valid', contract: contract() });
  });
  test('rejects mismatched owner, marker, branch, revision, digest, or raw prompt/transcript fields', () => {
    for (const mutate of [
      (value: FirstUseContract) => ({ ...value, marker: 'wrong' }),
      (value: FirstUseContract) => ({ ...value, branch: 'main' }),
      (value: FirstUseContract) => ({ ...value, revision: 'not-a-sha' }),
      (value: FirstUseContract) => ({ ...value, controlRepository: { ...value.controlRepository, owner: 'other' } }),
      (value: FirstUseContract) => ({ ...value, validation: { ...value.validation, workflowSHA256: 'x' } }),
      (value: FirstUseContract) => ({ ...value, prompt: 'secret' } as unknown as FirstUseContract),
    ]) expect(validateFirstUseContract(mutate(contract())).kind).toBe('rejected');
  });
  test('rejects unknown contract fields and non-string profile', () => {
    expect(validateFirstUseContract({ ...contract(), extra: true })).toMatchObject({ kind: 'rejected' });
    expect(validateFirstUseContract({ ...contract(), profile: 7 } as unknown as FirstUseContract)).toMatchObject({ kind: 'rejected' });
  });

  test('summarizes only redaction-safe evidence fields and rejects prompt/transcript/Issue body', () => {
    const summary = summarizeFirstUseEvidence({ status: 'effective', issueURL: 'https://github.com/octocat/agent-control/issues/1', issueNumber: 1, projectItem: 'PVTI_1', pullRequestURL: 'https://github.com/octocat/agent-control/pull/2', pullRequestNumber: 2, revision: 'a'.repeat(40), validationResult: 'passed', problems: [] });
    expect(summary).toEqual({ kind: 'accepted', summary: expect.objectContaining({ status: 'effective', issueNumber: 1, pullRequestNumber: 2 }) });
    expect(summarizeFirstUseEvidence({ status: 'awaiting', body: 'raw Issue body' }).kind).toBe('rejected');
    expect(summarizeFirstUseEvidence({ status: 'awaiting', transcript: 'raw transcript' }).kind).toBe('rejected');
  });
});
