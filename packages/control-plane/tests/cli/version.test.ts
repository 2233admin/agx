import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { main } from '../../src/cli/index';
import { CONFIGS_VERSION } from '../../src/cli/version';

/**
 * `--version` is intercepted before `openDeps()`/`parseCommand()` -- it
 * must never open or create the SQLite database file, matching the
 * existing zero-arg/usage-error convention. `CONTROL_PLANE_DB_PATH` (see
 * `src/cli/db-path.ts`) is redirected to a path inside a fresh, empty temp
 * directory so this test can assert on that exact file's absence rather
 * than relying on whatever the developer's real db path happens to
 * contain.
 */
describe('configs --version', () => {
  test('prints CONFIGS_VERSION, exits 0, and never creates the database file', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'configs-version-test-'));
    const dbPath = join(tempDir, 'control-plane.sqlite3');
    const originalDbPath = process.env.CONTROL_PLANE_DB_PATH;
    process.env.CONTROL_PLANE_DB_PATH = dbPath;

    const originalLog = console.log;
    const logged: string[] = [];
    console.log = (...args: unknown[]) => {
      logged.push(args.join(' '));
    };

    try {
      const exitCode = await main(['--version']);

      expect(exitCode).toBe(0);
      // Pins the actual committed placeholder value -- comparing only
      // against the imported `CONFIGS_VERSION` would still pass even if
      // that literal were accidentally changed away from `'dev'`, since
      // it'd just be comparing the constant against itself.
      expect(logged).toEqual(['dev']);
      expect(CONFIGS_VERSION).toBe('dev');
      expect(logged).toEqual([CONFIGS_VERSION]);
      expect(existsSync(dbPath)).toBe(false);
    } finally {
      console.log = originalLog;
      if (originalDbPath === undefined) {
        delete process.env.CONTROL_PLANE_DB_PATH;
      } else {
        process.env.CONTROL_PLANE_DB_PATH = originalDbPath;
      }
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
