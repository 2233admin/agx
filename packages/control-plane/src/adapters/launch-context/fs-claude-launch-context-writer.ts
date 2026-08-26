import path from 'node:path';

import { defaultDbPath } from '../../cli/db-path';
import type { ClaudeLaunchContext, ClaudeLaunchContextWriter } from '../../application/ports';
import { writeJsonLaunchContext } from './fs-json-context-writer';

/**
 * `[Story 4.3]` Writes under the same state root the SQLite database lives
 * under, in a sibling `claude-launch-context/` directory -- kept separate
 * from OMP's own `launch-context/` directory (`fs-launch-context-writer.ts`)
 * so the two clients' diagnostic artifacts never collide or get confused
 * for one another, mirroring that file's own `CONTROL_PLANE_DB_PATH`
 * override convention.
 */
export function claudeLaunchContextDir(): string {
  return path.join(path.dirname(defaultDbPath()), 'claude-launch-context');
}

export class FsClaudeLaunchContextWriter implements ClaudeLaunchContextWriter {
  async write(context: ClaudeLaunchContext): Promise<string> {
    return writeJsonLaunchContext(claudeLaunchContextDir(), context.planId, context);
  }
}
