/**
 * Reads one line of interactive `y`/`n` confirmation from stdin. Used by
 * `configs use`/`configs switch` when `--yes` is not passed. Case
 * insensitive; only `y`/`yes` are treated as an affirmative answer --
 * everything else (including empty input) is a rejection.
 */
export async function readYesNo(promptText: string): Promise<boolean> {
  process.stdout.write(promptText);
  const line = await readLine();
  const normalized = line.trim().toLowerCase();
  return normalized === 'y' || normalized === 'yes';
}

/**
 * Resolves with the first line read from stdin, or `''` (treated as a
 * declined confirmation by `readYesNo`) if stdin ends or errors before any
 * data arrives -- e.g. `configs use <id>` invoked non-interactively with
 * stdin redirected from a closed/empty source, without `--yes`. Without
 * the `'end'`/`'error'` handlers below, that scenario left the returned
 * promise permanently unsettled and the CLI hanging forever instead of
 * failing fast on ambiguous/absent input.
 */
function readLine(): Promise<string> {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    stdin.resume();
    stdin.setEncoding('utf8');
    const cleanup = () => {
      stdin.pause();
      stdin.removeListener('data', onData);
      stdin.removeListener('end', onEnd);
      stdin.removeListener('error', onError);
    };
    const onData = (chunk: string) => {
      cleanup();
      resolve(chunk.split('\n')[0] ?? '');
    };
    const onEnd = () => {
      cleanup();
      resolve('');
    };
    const onError = () => {
      cleanup();
      resolve('');
    };
    stdin.once('data', onData);
    stdin.once('end', onEnd);
    stdin.once('error', onError);
  });
}
