import { describe, expect, test } from 'bun:test';

import type { MulticaCommandPort } from '../../src/application/ports';
import type { MulticaSubject } from '../../src/domain/multica';
import { MulticaCliAdapter } from '../../src/adapters/multica/cli';

const RUNTIME: MulticaSubject = { kind: 'runtime', id: 'd3baaa7b-1111-4111-8111-111111111111' };
const WORKSPACE: MulticaSubject = { kind: 'workspace', id: 'd3baaa7b-1111-4111-8111-111111111111' };

interface Response { readonly stdout: string; readonly exitCode: number | null }
class FixtureMultica implements MulticaCommandPort {
  readonly calls: readonly (readonly string[])[] = [];
  constructor(private readonly response: Response, private readonly usable = true) {}
  async available(_signal: AbortSignal): Promise<boolean> { return this.usable; }
  async run(args: readonly string[], _signal: AbortSignal): Promise<Response> {
    (this.calls as (readonly string[])[]).push([...args]);
    return this.response;
  }
}
function json(value: unknown, exitCode = 0): Response { return { stdout: JSON.stringify(value), exitCode }; }
function runtime(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { id: RUNTIME.id, name: 'Claude AU-5090', status: 'online', ...overrides };
}

describe('MulticaCliAdapter', () => {
  test('reads the official runtime list with direct argv and returns online runtime evidence', async () => {
    const command = new FixtureMultica(json([runtime()]));
    const adapter = new MulticaCliAdapter(command);

    await expect(adapter.readback(RUNTIME)).resolves.toEqual({
      kind: 'observed', subject: RUNTIME, runtime: { id: RUNTIME.id, name: 'Claude AU-5090', status: 'online' },
    });
    expect(command.calls).toEqual([['runtime', 'list', '--output', 'json']]);
  });

  test('accepts the wrapped runtimes response shape', async () => {
    await expect(new MulticaCliAdapter(new FixtureMultica(json({ runtimes: [runtime()] }))).readback(RUNTIME)).resolves.toMatchObject({ kind: 'observed' });
  });

  test('keeps absent, ambiguous, and offline outcomes distinct', async () => {
    await expect(new MulticaCliAdapter(new FixtureMultica(json([]))).readback(RUNTIME)).resolves.toEqual({ kind: 'absent', subject: RUNTIME });
    await expect(new MulticaCliAdapter(new FixtureMultica(json([runtime(), { ...runtime(), name: 'duplicate' }]))).readback(RUNTIME)).resolves.toEqual({ kind: 'ambiguous', subject: RUNTIME, matchCount: 2 });
    await expect(new MulticaCliAdapter(new FixtureMultica(json([runtime({ status: 'offline' })]))).readback(RUNTIME)).resolves.toEqual({ kind: 'offline', subject: RUNTIME, status: 'offline' });
    await expect(new MulticaCliAdapter(new FixtureMultica(json([runtime({ status: 'mystery' })]))).readback(RUNTIME)).resolves.toEqual({ kind: 'inconclusive', subject: RUNTIME, reason: 'unknown-runtime-status' });
  });

  test('workspace and agent subjects are UUID-valid but inconclusive because only runtime list is observed', async () => {
    await expect(new MulticaCliAdapter(new FixtureMultica(json([]))).readback(WORKSPACE)).resolves.toEqual({ kind: 'inconclusive', subject: WORKSPACE, reason: 'subject-kind-not-observed' });
  });

  test('missing CLI, timeout, nonzero, malformed, trailing, duplicate, unknown, and bad UUID are inconclusive', async () => {
    await expect(new MulticaCliAdapter(new FixtureMultica(json([]), false)).readback(RUNTIME)).resolves.toMatchObject({ kind: 'inconclusive', reason: 'multica-cli-unavailable' });
    await expect(new MulticaCliAdapter({ available: async () => { throw new Error('timeout'); }, run: async () => json([]) }).readback(RUNTIME)).resolves.toMatchObject({ kind: 'inconclusive' });
    await expect(new MulticaCliAdapter(new FixtureMultica(json([], 1))).readback(RUNTIME)).resolves.toMatchObject({ kind: 'inconclusive' });
    for (const payload of ['{', '[] {}', '[{"id":"x","name":"bad","status":"online","extra":true}]', '[{"id":"x","id":"y","name":"bad","status":"online"}]']) {
      await expect(new MulticaCliAdapter(new FixtureMultica({ stdout: payload, exitCode: 0 })).readback(RUNTIME)).resolves.toMatchObject({ kind: 'inconclusive' });
    }
    await expect(new MulticaCliAdapter(new FixtureMultica(json([]))).readback({ kind: 'runtime', id: 'not-a-uuid' })).resolves.toMatchObject({ kind: 'inconclusive', reason: 'invalid-subject' });
  });
  test('bounds a hanging command and propagates cancellation', async () => {
    const timeout = new MulticaCliAdapter({ available: async () => true, run: async () => new Promise<Response>(() => undefined) }, 5);
    await expect(timeout.readback(RUNTIME)).resolves.toEqual({ kind: 'inconclusive', subject: RUNTIME, reason: 'multica-timeout' });

    const controller = new AbortController();
    const cancelled = new MulticaCliAdapter({ available: async () => true, run: async (_args, signal) => new Promise<Response>((resolve) => signal.addEventListener('abort', () => resolve({ stdout: '', exitCode: null }))) }, 1000);
    const result = cancelled.readback(RUNTIME, controller.signal);
    controller.abort();
    await expect(result).resolves.toEqual({ kind: 'inconclusive', subject: RUNTIME, reason: 'multica-cancelled' });
  });
  test('bounds a hanging CLI availability probe', async () => {
    const command: MulticaCommandPort = {
      available: async () => new Promise<boolean>(() => undefined),
      run: async (_args, _signal) => ({ stdout: '[]', exitCode: 0 }),
    };
    await expect(new MulticaCliAdapter(command, 5).readback(RUNTIME)).resolves.toEqual({
      kind: 'inconclusive', subject: RUNTIME, reason: 'multica-timeout',
    });
  });
});
