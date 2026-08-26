import os from 'node:os';
import path from 'node:path';

/**
 * Resolves the file holding self-update scheduling state (see
 * `adapters/self-update/check-state.ts`). Overridable via
 * `CONFIGS_SELF_UPDATE_STATE_PATH` (tests, and anyone who needs the
 * background checker's throttle to live elsewhere); defaults under the
 * same `$HOME/.agent-system-state/control-plane/` root as the SQLite file
 * (`db-path.ts`).
 */
export function defaultSelfUpdateStatePath(): string {
  const override = process.env.CONFIGS_SELF_UPDATE_STATE_PATH;
  if (override !== undefined && override.length > 0) {
    return override;
  }
  return path.join(os.homedir(), '.agent-system-state', 'control-plane', 'self-update.json');
}
