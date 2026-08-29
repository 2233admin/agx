import { mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';

import { defaultDbPath } from '../../cli/db-path';
import type { ClaudeInvocationDirPort } from '../../application/ports';

/**
 * `[Story 4.3]` Root directory every fresh Claude Code spawn's isolated,
 * per-operation directory lives under -- a sibling of the SQLite database
 * and OMP's `launch-context`/`extensions` directories under the same state
 * root (`cli/db-path.ts`'s convention), never this repo's own root and
 * never `.cap/`.
 */
export function claudeInvocationRootDir(): string {
  return path.join(path.dirname(defaultDbPath()), 'claude-invocations');
}

/**
 * `[Story 4.3]` Creates (if needed) and returns the isolated directory a
 * given `operationId`'s fresh Claude Code spawn uses as both its `cwd` and
 * its `CLAUDE_CONFIG_DIR`. One directory per `operationId` -- never shared
 * across operations, and never the currently-running session's own project
 * root or global Claude Code config directory (AD-9).
 */
export class FsClaudeInvocationDirPort implements ClaudeInvocationDirPort {
  async prepare(operationId: string): Promise<string> {
    const dir = path.join(claudeInvocationRootDir(), operationId);
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  /** `[Epic 4 retro fix]` Best-effort per the port's contract -- a removal failure (e.g. a file still held open on Windows) is swallowed, never thrown. */
  async cleanup(invocationDir: string): Promise<void> {
    try {
      rmSync(invocationDir, { recursive: true, force: true });
    } catch {
      // Intentionally swallowed -- see the port's Design Notes.
    }
  }
}
