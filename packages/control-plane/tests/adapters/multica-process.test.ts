import { expect, test } from 'bun:test';
import { BunMulticaCommandPort, createMulticaCommandPort, type MulticaSpawn } from '../../src/adapters/multica/process';

test('Multica process executes exact runtime list argv with allowlisted env and redacted stderr', async () => {
  let seen: { argv: readonly string[]; cwd: string; env: Readonly<Record<string, string>> } | null = null;
  const spawn: MulticaSpawn = (argv, options) => { seen = { argv, cwd: options.cwd, env: options.env }; return { stdout: '{"runtimes":[]}', stderr: 'secret', exited: Promise.resolve(0), kill: () => {} }; };
  const port = new BunMulticaCommandPort({ binary: 'multica', cwd: 'C:/work', spawn, which: () => 'multica' });
  const result = await port.run(['runtime', 'list', '--output', 'json'], new AbortController().signal);
  expect(seen as unknown).toEqual({ argv: ['multica', 'runtime', 'list', '--output', 'json'], cwd: 'C:/work', env: expect.not.objectContaining({ MULTICA_TOKEN: expect.anything() }) });
  expect(result.stdout).toBe('{"runtimes":[]}'); expect(result.stderr).toBe('command-stderr'); expect(result.exitCode).toBe(0);
});

test('Multica process handles missing binary, pre-abort, timeout, nonzero, and bounded stdout', async () => {
  const missing = new BunMulticaCommandPort({ binary: 'multica', cwd: 'C:/work', which: () => null });
  expect(await missing.available(new AbortController().signal)).toBe(false); expect(await missing.run([], new AbortController().signal)).toEqual({ stdout: '', stderr: 'binary-not-found', exitCode: null });
  let spawned = false; const pending = Promise.withResolvers<number>();
  const spawn: MulticaSpawn = () => { spawned = true; return { stdout: 'x'.repeat(100_000), stderr: 'secret', exited: pending.promise, kill: () => {} }; };
  const controller = new AbortController(); controller.abort(); const port = new BunMulticaCommandPort({ binary: 'multica', cwd: 'C:/work', timeoutMs: 10, spawn, which: () => 'multica' });
  expect(await port.run([], controller.signal)).toEqual({ stdout: '', stderr: 'command-cancelled', exitCode: null }); expect(spawned).toBe(false);
  expect((await port.run([], new AbortController().signal)).stderr).toBe('command-timeout');
  const nonzero = new BunMulticaCommandPort({ binary: 'multica', cwd: 'C:/work', spawn: (_argv, _options) => ({ stdout: 'output', stderr: 'secret', exited: Promise.resolve(7), kill: () => {} }), which: () => 'multica' });
  expect(await nonzero.run([], new AbortController().signal)).toEqual({ stdout: 'output', stderr: 'command-stderr', exitCode: 7 });
});

test('Multica factory requires absolute cwd', () => { expect(() => createMulticaCommandPort({ cwd: 'relative' })).toThrow('absolute path'); });
