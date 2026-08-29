import os from 'node:os';
import path from 'node:path';

/**
 * Resolves the SQLite file backing the read-only repository. Overridable
 * via `CONTROL_PLANE_DB_PATH` (used by tests and the seed script);
 * defaults under the same `$HOME/.agent-system-state/` root the rest of
 * this repo's persistent state already lives under.
 */
export function defaultDbPath(): string {
  const override = process.env.CONTROL_PLANE_DB_PATH;
  if (override !== undefined && override.length > 0) {
    return override;
  }
  return path.join(os.homedir(), '.agent-system-state', 'control-plane', 'control-plane.sqlite3');
}
