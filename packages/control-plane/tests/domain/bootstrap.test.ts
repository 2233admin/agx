import { describe, expect, test } from 'bun:test';
import {
  BOOTSTRAP_TEMPLATE_SET_CONTENT_SHA256,
  BOOTSTRAP_TEMPLATE_SET_VERSION,
  renderBootstrap,
  decideBootstrapTree,
  type BootstrapTemplateSource,
} from '../../src/domain/bootstrap';

const source = (files: BootstrapTemplateSource['files'] = [
  { path: 'README.md', content: 'owner=@@AGX_OWNER@@\r\nrepo=@@AGX_REPOSITORY@@\r\n' },
  { path: 'work/current.md', content: '@@AGX_TARGET_URL@@\n' },
]): BootstrapTemplateSource => ({
  kind: 'agent-control', templateVersion: 'agent-control/v1', templateSetVersion: BOOTSTRAP_TEMPLATE_SET_VERSION,
  templateSetContentSHA256: BOOTSTRAP_TEMPLATE_SET_CONTENT_SHA256, files,
});

describe('bootstrap renderer', () => {
  test('renders allowlisted substitutions with LF normalization, sorted paths, and deterministic digest', () => {
    const input = source();
    const first = renderBootstrap(input, { owner: 'octo-lab', repository: 'agent-control', pluginSource: 'zaurakworks/agent-plugins' });
    const second = renderBootstrap(input, { owner: 'octo-lab', repository: 'agent-control', pluginSource: 'zaurakworks/agent-plugins' });
    expect(first).toEqual(second);
    expect(first.files.map((file) => file.path)).toEqual(['README.md', 'work/current.md']);
    expect(first.files[0]?.content).toBe('owner=octo-lab\nrepo=agent-control\n');
    expect(first.files[1]?.content).toBe('https://github.com/octo-lab/agent-control\n');
    expect(first.digest).toMatch(/^[a-f0-9]{64}$/);
  });

  test('rejects unsafe placeholders, paths, NUL, git, and live-state files', () => {
    for (const files of [
      [{ path: '../escape', content: 'ok' }],
      [{ path: '.git/config', content: 'ok' }],
      [{ path: 'work/records/1.json', content: 'ok' }],
      [{ path: 'x.txt', content: '@@AGX_UNKNOWN@@' }],
      [{ path: 'x.txt', content: 'bad\0value' }],
    ]) {
      expect(() => renderBootstrap(source(files), { owner: 'octo-lab', repository: 'agent-control', pluginSource: 'zaurakworks/agent-plugins' })).toThrow();
    }
  });
  test('rejects template set identity drift', () => {
    expect(() => renderBootstrap({ ...source(), templateSetVersion: 'bootstrap-other' }, { owner: 'octo-lab', repository: 'agent-control', pluginSource: 'zaurakworks/agent-plugins' })).toThrow();
    expect(() => renderBootstrap({ ...source(), templateSetContentSHA256: 'a'.repeat(64) }, { owner: 'octo-lab', repository: 'agent-control', pluginSource: 'zaurakworks/agent-plugins' })).toThrow();
  });

  test('chooses create, already-exact, or reject without mutating a tree', () => {
    const rendered = renderBootstrap(source(), { owner: 'octo-lab', repository: 'agent-control', pluginSource: 'zaurakworks/agent-plugins' });
    expect(decideBootstrapTree(rendered, [])).toEqual({ kind: 'create' });
    expect(decideBootstrapTree(rendered, rendered.files.map((file) => ({ path: file.path, kind: 'file', content: file.content })))).toEqual({ kind: 'already-exact' });
    expect(decideBootstrapTree(rendered, [{ path: 'README.md', kind: 'file', content: 'drift' }])).toMatchObject({ kind: 'reject' });
    expect(decideBootstrapTree(rendered, [{ path: 'README.md', kind: 'symlink' }])).toMatchObject({ kind: 'reject' });
  });
});
