import { expect, test } from 'bun:test';
import { BunGithubCommandPort, createGithubRepositoryCommandPort, type GithubSpawn } from '../../src/adapters/github/command-port';

test('direct GitHub command port executes helper argv with explicit cwd/env and captures stdout/stderr', async () => {
  const port = new BunGithubCommandPort({ binary: process.execPath, cwd: process.cwd(), command: [process.execPath, '-e', "console.log('ok'); console.error('warn')"] });
  const result = await port.run([]);
  expect(result.stdout.trim()).toBe('ok'); expect(result.stderr).toBe('command-stderr'); expect(result.exitCode).toBe(0);
});

test('direct command port bounds hung helpers and supports cancellation without shell interpolation', async () => {
  const port = new BunGithubCommandPort({ binary: process.execPath, timeoutMs: 20, command: [process.execPath, '-e', 'setTimeout(() => {}, 1000)'] });
  const result = await port.run([]);
  expect(result.exitCode).toBeNull(); expect(result.stderr).toContain('timeout');
  const controller = new AbortController(); controller.abort();
  await expect(port.run([], controller.signal)).resolves.toMatchObject({ exitCode: null });
});
test('pre-aborted command does not spawn and production factories reject unsafe cwd overrides', async () => {
  let spawned = false;
  const spawn: GithubSpawn = () => { spawned = true; throw new Error('must not spawn'); };
  const controller = new AbortController(); controller.abort();
  const port = new BunGithubCommandPort({ command: ['helper'], cwd: process.cwd(), spawn });
  await expect(port.run([], controller.signal)).resolves.toEqual({ stdout: '', stderr: 'command-cancelled', exitCode: null });
  expect(spawned).toBe(false);
  expect(() => createGithubRepositoryCommandPort({ cwd: 'relative' })).toThrow('absolute path');
});
