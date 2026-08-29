import { expect, test } from 'bun:test';
import { summarizeFirstUse, validateFirstUse } from '../../src/application/first-use';

test('application first-use boundary returns safe validation and evidence decisions', () => {
  const input = { schemaVersion: 'agx.first-use/v1', installationId: 'install-1', controlRepository: { owner: 'octocat', name: 'agent-control', url: 'https://github.com/octocat/agent-control' }, contractsRepository: { owner: 'octocat', name: 'agent-contracts', url: 'https://github.com/octocat/agent-contracts' }, project: { owner: 'octocat', number: 7, nodeId: 'PVT_1', title: 'Agent System', url: 'https://github.com/users/octocat/projects/7' }, profile: 'default', objective: 'complete bootstrap verification', issueTitle: 'Bootstrap Verification', pullRequestTitle: 'Bootstrap Verification', marker: 'AGX-Installation: install-1', branch: 'agx/bootstrap-verification-install-1', revision: 'a'.repeat(40), validation: { command: 'python3 tools/validate.py', workflow: 'Validation', check: 'validate', workflowSHA256: 'b'.repeat(64) }, requiredActions: ['create-issue'], requiredOutputs: [], cleanup: 'operator-owned' };
  expect(validateFirstUse(input).kind).toBe('valid');
  expect(summarizeFirstUse(input, { status: 'awaiting', issueNumber: 1 }).kind).toBe('accepted');
});
