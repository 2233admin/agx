import { expect, test } from 'bun:test';
import { BunProviderCommandPort, createClaudeProviderCommandPort, createCodexProviderCommandPort, type ProviderSpawn } from '../../src/adapters/providers/process';

test('provider process runs exact argv/cwd with bounded environment and redacted stderr', async () => {
  let seen: { argv: readonly string[]; cwd: string; env: Readonly<Record<string, string>> } | null = null;
  const spawn: ProviderSpawn = (argv, options) => { seen = { argv, cwd: options.cwd, env: options.env }; return { stdout: 'provider-output', stderr: 'secret stderr', exited: Promise.resolve(0), kill: () => {} }; };
  const port = new BunProviderCommandPort({ binary: 'codex', cwd: 'C:/work', spawn, which: () => 'codex' });
  const result = await port.run(['exec', '--json']);
  expect(seen as unknown).toEqual({ argv: ['codex', 'exec', '--json'], cwd: 'C:/work', env: expect.not.objectContaining({ GH_TOKEN: expect.anything() }) });
  expect(result.stdout).toBe('provider-output'); expect(result.stderr).toBe('command-stderr'); expect(result.exitCode).toBe(0);
});

test('provider process reports missing binary, pre-abort, timeout, and nonzero exit without raw stderr', async () => {
  const missing = new BunProviderCommandPort({ binary: 'claude', cwd: 'C:/work', which: () => null });
  expect(await missing.available()).toBe(false); expect(await missing.run([])).toEqual({ stdout: '', stderr: 'binary-not-found', exitCode: null });
  let spawned = false;
  const pending = Promise.withResolvers<number>();
  const spawn: ProviderSpawn = () => { spawned = true; return { stdout: '', stderr: 'secret', exited: pending.promise, kill: () => {} }; };
  const controller = new AbortController(); controller.abort();
  const port = new BunProviderCommandPort({ binary: 'codex', cwd: 'C:/work', timeoutMs: 10, spawn, which: () => 'codex' });
  expect(await port.run([], controller.signal)).toEqual({ stdout: '', stderr: 'command-cancelled', exitCode: null }); expect(spawned).toBe(false);
  expect((await port.run([])).stderr).toBe('command-timeout');
});

test('provider factories pin binaries and require absolute cwd', () => {
  expect(() => createCodexProviderCommandPort({ cwd: 'relative' })).toThrow('absolute path');
  expect(() => createClaudeProviderCommandPort({ cwd: 'relative' })).toThrow('absolute path');
});
