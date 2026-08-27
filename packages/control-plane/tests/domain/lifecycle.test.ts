import { describe, expect, test } from 'bun:test';
import { decideRollback, decideUninstall, decideUpgrade, validateUpgradeCheckpoint, type LocalState, type ReleaseDescriptor, type UpgradeCheckpoint } from '../../src/domain/lifecycle';

const files = [{ path: 'configs/settings.json', digest: 'a'.repeat(64), ownership: 'created-by-configs' as const, kind: 'file' as const }, { path: 'configs/README.md', digest: 'b'.repeat(64), ownership: 'pre-existing' as const, kind: 'file' as const }];
const release: ReleaseDescriptor = { version: '1.2.3', tag: 'v1.2.3', assetName: 'configs-windows-amd64.zip', assetSHA256: 'c'.repeat(64), provenance: { repository: 'zaurakworks/agent-control', commitSHA: 'd'.repeat(40) }, platform: { os: 'windows', arch: 'amd64' } };
const checkpoint = (): UpgradeCheckpoint => ({ schemaVersion: 'configs.lifecycle/v1', checkpointId: 'checkpoint-1', installationId: 'install-0123456789abcdef', deploymentId: 'dep-1', revisionId: 'rev-1', fromVersion: '1.2.2', toVersion: release.version, release, preUpgradeStateDigest: 'e'.repeat(64), postUpgradeStateDigest: 'f'.repeat(64), preUpgradeState: files, remoteRetention: 'retain' });
const state = (digest: string, records: LocalState['records'] = files): LocalState => ({ digest, records });

describe('lifecycle contracts', () => {
  test('accepts exact checkpoint and release identity for a pure upgrade decision', () => {
    expect(validateUpgradeCheckpoint(checkpoint())).toEqual({ kind: 'valid', checkpoint: checkpoint() });
    expect(decideUpgrade({ checkpoint: checkpoint(), release, platform: release.platform, currentState: state(checkpoint().preUpgradeStateDigest), smoke: 'passed' })).toEqual(expect.objectContaining({ kind: 'ready', remoteRetention: 'retain', action: 'upgrade-locally-atomically' }));
  });

  test('rejects malformed or secret checkpoints and exact release/tag/asset/provenance/platform mismatches', () => {
    expect(validateUpgradeCheckpoint({ ...checkpoint(), token: 'secret' })).toMatchObject({ kind: 'rejected' });
    expect(validateUpgradeCheckpoint({ ...checkpoint(), preUpgradeStateDigest: 'bad' })).toMatchObject({ kind: 'rejected' });
    expect(decideUpgrade({ checkpoint: checkpoint(), release: { ...release, tag: 'v9.9.9' }, platform: release.platform, currentState: state(checkpoint().preUpgradeStateDigest), smoke: 'passed' })).toMatchObject({ kind: 'rejected', reason: 'release-mismatch' });
    expect(decideUpgrade({ checkpoint: checkpoint(), release, platform: { os: 'linux', arch: 'amd64' }, currentState: state(checkpoint().preUpgradeStateDigest), smoke: 'passed' })).toMatchObject({ kind: 'rejected', reason: 'platform-mismatch' });
  });

  test('rejects stale or modified pre-upgrade state, unknown ownership, symlinks, and failed smoke', () => {
    expect(decideUpgrade({ checkpoint: checkpoint(), release, platform: release.platform, currentState: state('1'.repeat(64)), smoke: 'passed' })).toMatchObject({ kind: 'rejected', reason: 'state-modified' });
    expect(decideUpgrade({ checkpoint: checkpoint(), release, platform: release.platform, currentState: state(checkpoint().preUpgradeStateDigest, [{ ...files[0]!, ownership: 'unknown' }]), smoke: 'passed' })).toMatchObject({ kind: 'rejected', reason: 'unknown-local-state' });
    expect(decideUpgrade({ checkpoint: checkpoint(), release, platform: release.platform, currentState: state(checkpoint().preUpgradeStateDigest, [{ ...files[0]!, kind: 'symlink' }]), smoke: 'passed' })).toMatchObject({ kind: 'rejected', reason: 'unsafe-local-state' });
    expect(decideUpgrade({ checkpoint: checkpoint(), release, platform: release.platform, currentState: state(checkpoint().preUpgradeStateDigest), smoke: 'failed' })).toMatchObject({ kind: 'rejected', reason: 'smoke-failed' });
  });

  test('creates atomic rollback decision only for exact post-upgrade local state and retains all remote state', () => {
    expect(decideRollback({ checkpoint: checkpoint(), currentState: state(checkpoint().postUpgradeStateDigest), smoke: 'passed' })).toEqual(expect.objectContaining({ kind: 'ready', action: 'restore-local-atomically', remoteRetention: 'retain', restore: checkpoint().preUpgradeState }));
    expect(decideRollback({ checkpoint: checkpoint(), currentState: state('1'.repeat(64)), smoke: 'passed' })).toMatchObject({ kind: 'rejected', reason: 'state-modified' });
  });

  test('uninstall deletes only configs-owned local paths and always retains remote repositories, Projects, and provider state', () => {
    expect(decideUninstall({ localState: state('a'.repeat(64)), remoteResources: ['repositories', 'projects', 'provider-client'] })).toEqual({ kind: 'ready', action: 'delete-owned-local-only', deletePaths: ['configs/settings.json'], retainRemote: ['repositories', 'projects', 'provider-client'] });
    expect(decideUninstall({ localState: state('a'.repeat(64), [{ ...files[0]!, ownership: 'unknown' }]), remoteResources: [] })).toMatchObject({ kind: 'rejected', reason: 'unknown-local-state' });
  });
});
