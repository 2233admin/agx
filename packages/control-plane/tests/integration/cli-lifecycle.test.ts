import { afterEach, describe, expect, test } from 'bun:test';
import { main } from '../../src/cli/index';
import type { StatusProjectionInput } from '../../src/domain/status';

const statusInput = (): StatusProjectionInput => ({ activeRevision: { kind: 'unknown', reason: 'fixture-empty', observedAt: '2026-01-01T00:00:00Z' }, deployment: { deploymentId: 'dep-empty', phase: 'planned', lastOperationId: { kind: 'unknown', reason: 'none', observedAt: '2026-01-01T00:00:00Z' }, reason: null, nextAction: 'prepare-plan' }, operation: { operationId: 'op-empty', deploymentId: 'dep-empty', phase: 'prepared', steps: [], remoteRetention: 'retain', nextAction: 'start-operation' }, launchPlans: [], readbacks: [], evidence: { phase: 'blocked_preflight', profile: 'github-delivery/v1', installationId: '', deploymentDigest: '', subjectDigest: '', evaluatedAt: '2026-01-01T00:00:00Z', satisfied: [], missing: [], diagnostics: [], nextSteps: [], evidence: [] } });

let output: string[] = [];
afterEach(() => { output = []; });
function capture() { const old = console.log; console.log = (...args: unknown[]) => output.push(args.map(String).join(' ')); return () => { console.log = old; }; }

describe('lifecycle rehearsal CLI', () => {
  test('status and diagnose use injected unified projection without opening or writing state', async () => {
    const restore = capture();
    const overrides = { statusProjection: statusInput() };
    expect(await main(['status'], overrides)).toBe(0);
    expect(await main(['diagnose'], overrides)).toBe(0);
    restore();
    expect(output.join('\n')).toContain('STATUS-CONFIG-UNKNOWN');
    expect(output.join('\n')).not.toMatch(/prompt|transcript|secret|token/i);
  });
  test('default status and diagnose report typed unsupported state without falling back to launch status', async () => {
    const restore = capture();
    expect(await main(['status'])).toBe(0);
    expect(await main(['diagnose'])).toBe(0);
    restore();
    expect(output.join('\n')).toContain('STATUS-SOURCE-UNAVAILABLE');
    expect(output.join('\n')).not.toContain('Revision:');
    expect(output.join('\n')).toContain('"readOnly":true');
  });

  test('migrate-agx requires explicit root and returns injected manual/rejected/imported decisions without writes', async () => {
    const restore = capture();
    const calls: string[] = [];
    const overrides = { migrationImporter: async (root: string) => { calls.push(root); return { kind: 'requires-manual-review' as const, reason: 'sidecar-runtime-not-authoritative' as const }; } };
    expect(await main(['migrate-agx', '--root', 'C:/fixture-installation'], overrides)).toBe(0);
    expect(await main(['migrate-agx'], overrides)).toBe(2);
    restore();
    expect(calls).toEqual(['C:/fixture-installation']);
    expect(output.join('\n')).toContain('sidecar-runtime-not-authoritative');
    expect(output.join('\n')).not.toMatch(/prompt|transcript|secret|token/i);
  });
});
