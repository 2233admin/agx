import { describe, expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';

import { readYesNo } from '../../src/cli/confirm-prompt';

/**
 * `readYesNo`'s `readLine()` used to only register `stdin.once('data', ...)`
 * with no `'end'`/`'error'` handler -- so stdin closing with zero data
 * before answering (e.g. `configs use <id>` invoked non-interactively with
 * stdin redirected from a closed/empty source, without `--yes`) left the
 * returned promise permanently unsettled and the CLI hanging forever. These
 * tests pipe closed/empty (and erroring) stdin through the real code path
 * and assert it resolves promptly with a declined answer instead of hanging.
 */

function createEofStdin() {
  const emitter = new EventEmitter();
  return Object.assign(emitter, {
    resume: () => {
      // Stdin closes immediately with no data at all -- e.g. piped from
      // `/dev/null` or a closed fd.
      queueMicrotask(() => emitter.emit('end'));
    },
    pause: () => {},
    setEncoding: () => {},
  });
}

function createErroringStdin() {
  const emitter = new EventEmitter();
  return Object.assign(emitter, {
    resume: () => {
      queueMicrotask(() => emitter.emit('error', new Error('EPIPE: broken pipe')));
    },
    pause: () => {},
    setEncoding: () => {},
  });
}

async function withFakeStdin<T>(fakeStdin: unknown, fn: () => Promise<T>): Promise<T> {
  const originalStdin = process.stdin;
  Object.defineProperty(process, 'stdin', { value: fakeStdin, configurable: true });
  try {
    return await fn();
  } finally {
    Object.defineProperty(process, 'stdin', { value: originalStdin, configurable: true });
  }
}

describe('readYesNo stdin EOF handling', () => {
  test('stdin closing (EOF) with zero data resolves promptly to a declined ("no") answer instead of hanging forever', async () => {
    const started = Date.now();
    const answer = await withFakeStdin(createEofStdin(), () => readYesNo('Proceed? [y/N] '));
    const elapsedMs = Date.now() - started;

    expect(answer).toBe(false);
    // Generous bound -- this is only to prove the promise actually settled
    // via the 'end' handler rather than depending on some unrelated timer;
    // it is not a hang if it resolves anywhere near-instantly.
    expect(elapsedMs).toBeLessThan(2000);
  });

  test('a stdin error before any data resolves promptly to a declined ("no") answer instead of hanging forever', async () => {
    const started = Date.now();
    const answer = await withFakeStdin(createErroringStdin(), () => readYesNo('Proceed? [y/N] '));
    const elapsedMs = Date.now() - started;

    expect(answer).toBe(false);
    expect(elapsedMs).toBeLessThan(2000);
  });
});
