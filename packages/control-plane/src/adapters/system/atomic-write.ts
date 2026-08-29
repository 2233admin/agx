import { writeFile } from 'node:fs/promises';

/**
 * `[Epic 4 retro fix]` The one piece of AD-9's same-directory
 * temp-file-then-rename discipline that `adapters/clients/claude/
 * content-materializer.ts`'s `writeFileAtomic` and `adapters/self-update/
 * github-release-updater.ts`'s `replaceBinary` genuinely shared (both had
 * independently reimplemented this exact temp-name scheme). Deliberately
 * does *not* also perform the final `rename` onto the real destination:
 * `replaceBinary` must rename the existing file out to a backup path
 * *between* this write and that final rename, so the rename choreography
 * stays each caller's own responsibility -- collapsing it in here would
 * silently change `replaceBinary`'s behavior (clobbering the binary before
 * it is backed up).
 *
 * `tempSuffix` defaults to a per-process/per-call-unique suffix (the scheme
 * `content-materializer.ts` already used, needed there because multiple
 * references can be written concurrently within one launch). `replaceBinary`
 * instead passes its own fixed `.download` suffix explicitly, preserving
 * its pre-existing exact temp path (`tests/adapters/self-update.test.ts`
 * depends on that literal path to simulate a write failure).
 */
export async function writeToSameDirTempFile(
  destPath: string,
  data: string | Uint8Array,
  options?: { readonly mode?: number; readonly tempSuffix?: string },
): Promise<string> {
  const tempPath = `${destPath}${options?.tempSuffix ?? `.${process.pid}.${Date.now()}.tmp`}`;
  await writeFile(tempPath, data, options?.mode !== undefined ? { mode: options.mode } : undefined);
  return tempPath;
}
