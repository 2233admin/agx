import { expect, test } from 'bun:test';
import { BunGithubCommandPort } from '../../src/adapters/github/command-port';

test('direct GitHub command port executes helper argv with explicit cwd/env and captures stdout/stderr', async () => {
  const port = new BunGithubCommandPort({ binary: process.execPath, cwd: process.cwd(), command: [process.execPath, '-e', "console.log('ok'); console.error('warn')"] });
  const result = await port.run([]);
  expect(result.stdout.trim()).toBe('ok'); expect(result.stderr?.trim()).toBe('warn'); expect(result.exitCode).toBe(0);
});

test('direct command port bounds hung helpers and supports cancellation without shell interpolation', async () => {
  const port = new BunGithubCommandPort({ binary: process.execPath, timeoutMs: 20, command: [process.execPath, '-e', 'setTimeout(() => {}, 1000)'] });
  const result = await port.run([]);
  expect(result.exitCode).toBeNull(); expect(result.stderr).toContain('timeout');
  const controller = new AbortController(); controller.abort();
  await expect(port.run([], controller.signal)).resolves.toMatchObject({ exitCode: null });
});
