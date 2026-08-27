import { expect, test } from 'bun:test';
import { main } from '../../src/cli/index';
import type { LifecycleDecisionProviders } from '../../src/cli/index';

test('lifecycle commands return typed unsupported without injected decisions', async () => {
  const output: string[] = []; const old = console.log; console.log = (...args: unknown[]) => output.push(args.map(String).join(' '));
  try {
    expect(await main(['upgrade', '--checkpoint', 'checkpoint-1'])).toBe(1);
    expect(await main(['rollback', '--checkpoint', 'checkpoint-1'])).toBe(1);
    expect(await main(['uninstall'])).toBe(1);
  } finally { console.log = old; }
  expect(output.join('\n')).toContain('STATUS-SOURCE-UNAVAILABLE');
});

test('lifecycle commands strictly parse selectors and emit allowlisted decisions with remote retention', async () => {
  const calls: string[] = []; const output: string[] = []; const old = console.log; console.log = (...args: unknown[]) => output.push(args.map(String).join(' '));
  const providers: LifecycleDecisionProviders = {
    upgrade: async (checkpointId) => { calls.push(`upgrade:${checkpointId}`); return { kind: 'ready', action: 'upgrade-locally-atomically', checkpoint: { schemaVersion: 'configs.lifecycle/v1', checkpointId, installationId: 'install-0123456789abcdef', deploymentId: 'dep-1', revisionId: 'rev-1', fromVersion: '1.2.2', toVersion: '1.2.3', release: {} as never, preUpgradeStateDigest: 'a'.repeat(64), postUpgradeStateDigest: 'b'.repeat(64), preUpgradeState: [], remoteRetention: 'retain' } as never, remoteRetention: 'retain' }; },
    rollback: async (checkpointId) => { calls.push(`rollback:${checkpointId}`); return { kind: 'rejected', reason: 'state-modified' }; },
    uninstall: async () => { calls.push('uninstall'); return { kind: 'ready', action: 'delete-owned-local-only', deletePaths: ['configs/state.json'], retainRemote: ['repositories', 'projects', 'provider-client'] }; },
  };
  try {
    expect(await main(['upgrade', '--checkpoint', 'cp-1'], { lifecycleDecisionProviders: providers })).toBe(0);
    expect(await main(['rollback', '--checkpoint', 'cp-1'], { lifecycleDecisionProviders: providers })).toBe(1);
    expect(await main(['uninstall'], { lifecycleDecisionProviders: providers })).toBe(0);
    expect(await main(['upgrade'])).toBe(2);
    expect(await main(['uninstall', '--checkpoint', 'cp-1'])).toBe(2);
  } finally { console.log = old; }
  expect(calls).toEqual(['upgrade:cp-1', 'rollback:cp-1', 'uninstall']);
  expect(output.join('\n')).toContain('"remoteRetention":"retain"');
  expect(output.join('\n')).not.toMatch(/prompt|transcript|token|secret|assetSHA256|preUpgradeStateDigest/i);
});
