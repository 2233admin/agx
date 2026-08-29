/**
 * `[Story 3.1]` Reads the raw candidate text for `configs establish`, from
 * either `--from <path>` or stdin. Kept in its own module (same convention
 * as `confirm-prompt.ts`'s `readYesNo`/`readLine`) so tests can fake
 * `process.stdin` with a plain `EventEmitter` instead of a real pipe.
 *
 * Never called when stdin is a TTY and no `--from` was given -- that
 * combination is rejected before either of these is invoked (Boundaries &
 * Constraints: "无 --from 且 stdin 是 TTY 时立即类型化拒绝，不阻塞等待交互").
 */

/** `true` only when stdin is an interactive terminal -- never true for a pipe/redirect/closed fd. */
export function isStdinTTY(): boolean {
  return process.stdin.isTTY === true;
}

/**
 * Reads all of stdin to completion as UTF-8 text. Unlike
 * `confirm-prompt.ts`'s `readLine` (which only needs the first line), a
 * JSON candidate may span many lines, so this accumulates every chunk
 * until `'end'`.
 */
export function readStdinText(): Promise<string> {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    let data = '';
    stdin.resume();
    stdin.setEncoding('utf8');
    const cleanup = () => {
      stdin.pause();
      stdin.removeListener('data', onData);
      stdin.removeListener('end', onEnd);
      stdin.removeListener('error', onError);
    };
    const onData = (chunk: string) => {
      data += chunk;
    };
    const onEnd = () => {
      cleanup();
      resolve(data);
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    stdin.on('data', onData);
    stdin.once('end', onEnd);
    stdin.once('error', onError);
  });
}

/** Reads `--from <path>` as UTF-8 text. Any failure (missing file, permission, etc.) is surfaced to the caller as a plain `Error` -- callers translate it into a typed `InvalidCandidateError`. */
export async function readCandidateFile(filePath: string): Promise<string> {
  return await Bun.file(filePath).text();
}
