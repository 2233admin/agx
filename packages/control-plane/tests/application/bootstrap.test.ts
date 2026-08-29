import { expect, test } from 'bun:test';
import { decideBootstrapRepositoryTree, renderBootstrapRepository } from '../../src/application/bootstrap';

test('application bootstrap boundary delegates pure render and exact-tree decisions', () => {
  const source = { kind: 'agent-control' as const, templateVersion: 'agent-control/v1' as const, templateSetVersion: 'bootstrap-20260819.1', templateSetContentSHA256: '66b4db310377e9dfb173b3e39f4bc54665313ad2c4f6ee80602e941ea453e005', files: [{ path: 'README.md', content: '@@AGX_OWNER@@\n' }] };
  const rendered = renderBootstrapRepository(source, { owner: 'octocat', repository: 'agent-control', pluginSource: 'zaurakworks/agent-plugins' });
  expect(decideBootstrapRepositoryTree(rendered, [])).toEqual({ kind: 'create' });
});
