import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/**
 * `[Epic 4 retro fix]` Shared write primitive behind `FsLaunchContextWriter`
 * (OMP) and `FsClaudeLaunchContextWriter` (Claude) -- the two were
 * near-identical duplicates of this same four-line body. Writes `context`
 * as pretty JSON to `<dir>/<planId>.json`, creating `dir` if needed, and
 * returns the file's absolute path. No atomic temp-file-then-rename
 * discipline here (unlike AD-9's invocation-dir content): this is a
 * diagnostic artifact for the CLI's own operator, never read by another
 * process while being written.
 */
export function writeJsonLaunchContext(dir: string, planId: string, context: unknown): string {
  mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `${planId}.json`);
  writeFileSync(filePath, JSON.stringify(context, null, 2), 'utf8');
  return filePath;
}
