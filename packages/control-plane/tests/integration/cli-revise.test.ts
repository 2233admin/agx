import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { main } from '../../src/cli/index';
import { SqliteConfigRevisionRepository } from '../../src/adapters/sqlite/repository';

let tmpDir: string;
let dbPath: string;
let logs: string[];
let originalLog: typeof console.log;

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), 'control-plane-cli-revise-'));
  dbPath = path.join(tmpDir, 'db.sqlite3');
  process.env.CONTROL_PLANE_DB_PATH = dbPath;
  process.env.CONFIGS_LANG = 'en';

  logs = [];
  originalLog = console.log;
  console.log = (...args: unknown[]) => {
    logs.push(args.map(String).join(' '));
  };
});

afterEach(() => {
  console.log = originalLog;
  delete process.env.CONTROL_PLANE_DB_PATH;
  delete process.env.CONFIGS_LANG;
  rmSync(tmpDir, { recursive: true, force: true });
});

/** Fakes non-TTY stdin that yields `text` then ends -- same convention as `tests/cli/confirm-prompt.test.ts`. */
function createDataStdin(text: string) {
  const emitter = new EventEmitter();
  return Object.assign(emitter, {
    isTTY: false,
    resume: () => {
      queueMicrotask(() => {
        emitter.emit('data', text);
        emitter.emit('end');
      });
    },
    pause: () => {},
    setEncoding: () => {},
  });
}

/** Fakes an interactive terminal -- `readStdinText`/`readCandidateFile` must never be reached when this is stdin and no `--from` was given. */
function createTTYStdin() {
  return { isTTY: true };
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

async function listAllRevisions() {
  const repo = new SqliteConfigRevisionRepository(dbPath);
  try {
    return await repo.listAll();
  } finally {
    repo.close();
  }
}

const VALID_CANDIDATE = JSON.stringify({
  configName: 'general',
  defaultMarker: { kind: 'known', value: true },
  scopeBoundary: { kind: 'known', value: 'a scope boundary' },
  availability: { kind: 'known', value: 'resolved' },
  skills: [
    {
      kind: 'skill',
      name: 'openspec-explore',
      sourceCategory: { kind: 'known', value: 'project-capability' },
      summary: { kind: 'known', value: 'skill reference: openspec-explore' },
    },
  ],
});

const OTHER_CONFIG_CANDIDATE = JSON.stringify({
  configName: 'other-config',
  defaultMarker: { kind: 'known', value: false },
  scopeBoundary: { kind: 'known', value: 'a different scope boundary' },
  availability: { kind: 'known', value: 'resolved' },
});

/** Establishes a baseline revision via `main(['establish', ...])` and returns its `revisionId`. */
async function establishBaseline(evidenceRef = 'session-baseline'): Promise<string> {
  const candidatePath = path.join(tmpDir, `baseline-${evidenceRef}.json`);
  await Bun.write(candidatePath, VALID_CANDIDATE);
  const code = await main(['establish', '--trigger-category', 'new-scenario', '--evidence', evidenceRef, '--from', candidatePath]);
  expect(code).toBe(0);
  logs = []; // Reset so subsequent assertions on `logs` only see `revise`'s output.
  const all = await listAllRevisions();
  const baseline = all.find((r) => r.evidenceRef === evidenceRef);
  if (baseline === undefined) {
    throw new Error(`baseline revision with evidenceRef=${evidenceRef} was not found after establish`);
  }
  return baseline.revisionId;
}

describe('configs revise', () => {
  test('修订成功: valid flags (existing --supersedes target, matching configName) + candidate JSON via --from creates exactly one new supersedes=<target> revision, prints detail block, and leaves the superseded (baseline) row completely unchanged', async () => {
    const baselineId = await establishBaseline();
    const baselineBefore = (await listAllRevisions()).find((r) => r.revisionId === baselineId)!;

    const candidatePath = path.join(tmpDir, 'revised-candidate.json');
    await Bun.write(candidatePath, VALID_CANDIDATE);

    const code = await main([
      'revise',
      '--trigger-category',
      'bad-case',
      '--evidence',
      'session-revise',
      '--supersedes',
      baselineId,
      '--from',
      candidatePath,
    ]);
    expect(code).toBe(0);
    const output = logs.join('\n');
    expect(output).toContain('Established superseding revision');
    expect(output).toContain('Configuration: general');

    const all = await listAllRevisions();
    expect(all).toHaveLength(2);
    const revised = all.find((r) => r.revisionId !== baselineId)!;
    expect(revised.supersedesRevisionId).toBe(baselineId);
    expect(revised.triggerCategory).toBe('bad-case');
    expect(revised.evidenceRef).toBe('session-revise');

    // `[Review fix]` Core insert-only invariant: `revise` must never mutate
    // the row it supersedes -- the baseline row must come back
    // field-for-field identical to before the `revise` call.
    const baselineAfter = all.find((r) => r.revisionId === baselineId)!;
    expect(baselineAfter).toEqual(baselineBefore);
  });

  test('valid candidate JSON piped via stdin (no --from) is also accepted', async () => {
    const baselineId = await establishBaseline();

    const code = await withFakeStdin(createDataStdin(VALID_CANDIDATE), () =>
      main(['revise', '--trigger-category', 'known-insufficiency', '--evidence', 'stdin-revise', '--supersedes', baselineId]),
    );
    expect(code).toBe(0);
    expect(logs.join('\n')).toContain('Established superseding revision');
    expect(await listAllRevisions()).toHaveLength(2);
  });

  test('缺 --supersedes: 零写入，不读取候选，失败块, exit 1', async () => {
    const baselineId = await establishBaseline();

    const code = await withFakeStdin(createTTYStdin(), () =>
      main(['revise', '--trigger-category', 'bad-case', '--evidence', 'session-revise']),
    );
    expect(code).toBe(1);
    expect(logs.join('\n')).toContain('supersedes');
    // Only the baseline revision exists -- revise wrote nothing.
    expect(await listAllRevisions()).toHaveLength(1);
    void baselineId;
  });

  test('--supersedes 目标不存在: 零写入，失败块, exit 1', async () => {
    await establishBaseline();

    const candidatePath = path.join(tmpDir, 'candidate.json');
    await Bun.write(candidatePath, VALID_CANDIDATE);

    const code = await main([
      'revise',
      '--trigger-category',
      'bad-case',
      '--evidence',
      'session-revise',
      '--supersedes',
      'nonexistent-revision-id',
      '--from',
      candidatePath,
    ]);
    expect(code).toBe(1);
    expect(logs.join('\n')).toContain('not found');
    expect(await listAllRevisions()).toHaveLength(1);
  });

  test('--supersedes 目标属于不同 config: 零写入，失败块, exit 1', async () => {
    const baselineId = await establishBaseline();

    const candidatePath = path.join(tmpDir, 'other-config-candidate.json');
    await Bun.write(candidatePath, OTHER_CONFIG_CANDIDATE);

    const code = await main([
      'revise',
      '--trigger-category',
      'bad-case',
      '--evidence',
      'session-revise',
      '--supersedes',
      baselineId,
      '--from',
      candidatePath,
    ]);
    expect(code).toBe(1);
    const output = logs.join('\n');
    expect(output).toContain('configuration');
    // `[Review fix]` Assert the actual `SupersedesConfigMismatchError`
    // constructor arguments were passed in the right order (revisionId,
    // expectedConfigName, actualConfigName) -- a swapped-argument bug would
    // still pass the weaker `.toContain('configuration')` check alone.
    expect(output).toContain(baselineId);
    expect(output).toContain('general'); // expected configName (from VALID_CANDIDATE)
    expect(output).toContain('other-config'); // actual configName (from OTHER_CONFIG_CANDIDATE, the target's real configName)
    expect(await listAllRevisions()).toHaveLength(1);
  });

  test('--supersedes 目标已被替代: 第二次 revise 相同目标零写入，失败块（不泄漏裸 SQLite 错误）, exit 1', async () => {
    const baselineId = await establishBaseline();

    const candidatePathA = path.join(tmpDir, 'revise-a.json');
    await Bun.write(candidatePathA, VALID_CANDIDATE);
    const codeA = await main([
      'revise',
      '--trigger-category',
      'bad-case',
      '--evidence',
      'session-revise-a',
      '--supersedes',
      baselineId,
      '--from',
      candidatePathA,
    ]);
    expect(codeA).toBe(0);
    expect(await listAllRevisions()).toHaveLength(2);

    logs = [];
    const candidatePathB = path.join(tmpDir, 'revise-b.json');
    await Bun.write(candidatePathB, VALID_CANDIDATE);
    const codeB = await main([
      'revise',
      '--trigger-category',
      'bad-case',
      '--evidence',
      'session-revise-b',
      '--supersedes',
      baselineId,
      '--from',
      candidatePathB,
    ]);
    expect(codeB).toBe(1);
    const output = logs.join('\n');
    expect(output).toContain('already been superseded');
    expect(output).not.toContain('UNIQUE constraint');
    expect(output).not.toContain('SQLITE');
    // Still only 2 -- the second, conflicting revise added zero rows.
    expect(await listAllRevisions()).toHaveLength(2);
  });

  test('缺 trigger-category: 零写入，不读取候选, exit 1', async () => {
    const baselineId = await establishBaseline();
    const code = await withFakeStdin(createTTYStdin(), () =>
      main(['revise', '--evidence', 'session-revise', '--supersedes', baselineId]),
    );
    expect(code).toBe(1);
    expect(logs.join('\n')).toContain('trigger category');
    expect(await listAllRevisions()).toHaveLength(1);
  });

  test('缺 evidence: 零写入, exit 1', async () => {
    const baselineId = await establishBaseline();
    const code = await withFakeStdin(createTTYStdin(), () =>
      main(['revise', '--trigger-category', 'bad-case', '--supersedes', baselineId]),
    );
    expect(code).toBe(1);
    expect(logs.join('\n')).toContain('evidence');
    expect(await listAllRevisions()).toHaveLength(1);
  });

  test('候选字段类型不符 (defaultMarker not boolean): 零写入，"candidate is invalid" 失败块, exit 1', async () => {
    const baselineId = await establishBaseline();

    const candidatePath = path.join(tmpDir, 'bad-candidate.json');
    await Bun.write(candidatePath, JSON.stringify({ configName: 'general', defaultMarker: { kind: 'known', value: 'not-a-boolean' } }));

    const code = await main([
      'revise',
      '--trigger-category',
      'bad-case',
      '--evidence',
      'session-revise',
      '--supersedes',
      baselineId,
      '--from',
      candidatePath,
    ]);
    expect(code).toBe(1);
    expect(logs.join('\n')).toContain('candidate is invalid');
    expect(await listAllRevisions()).toHaveLength(1);
  });

  test('无 --from 且 stdin 为 TTY: immediate typed failure, not a hang, exit 1, zero writes', async () => {
    const baselineId = await establishBaseline();
    const started = Date.now();
    const code = await withFakeStdin(createTTYStdin(), () =>
      main(['revise', '--trigger-category', 'bad-case', '--evidence', 'session-revise', '--supersedes', baselineId]),
    );
    const elapsedMs = Date.now() - started;
    expect(code).toBe(1);
    expect(elapsedMs).toBeLessThan(2000);
    expect(logs.join('\n')).toContain('no candidate source');
    expect(await listAllRevisions()).toHaveLength(1);
  });

  test('missing --trigger-category is rejected before the supersedes check and the stdin-TTY guard are ever reached, even when stdin is a TTY -- never blocks', async () => {
    const code = await withFakeStdin(createTTYStdin(), () => main(['revise', '--evidence', 'session-revise']));
    expect(code).toBe(1);
    expect(logs.join('\n')).toContain('trigger category');
    // Never even opened the db file (no baseline established in this test).
    expect(existsSync(dbPath)).toBe(false);
  });

  test('missing --evidence is rejected before the supersedes check, even when stdin is a TTY -- never blocks', async () => {
    const code = await withFakeStdin(createTTYStdin(), () => main(['revise', '--trigger-category', 'bad-case']));
    expect(code).toBe(1);
    expect(logs.join('\n')).toContain('evidence');
    expect(existsSync(dbPath)).toBe(false);
  });

  test('重复传 --supersedes 两次: usage error (exit 2), same convention as other repeated establish flags', async () => {
    const code = await main([
      'revise',
      '--trigger-category',
      'bad-case',
      '--evidence',
      'x',
      '--supersedes',
      'a',
      '--supersedes',
      'b',
    ]);
    expect(code).toBe(2);
  });

  test('重复传 --trigger-category 两次: usage error (exit 2)', async () => {
    const code = await main([
      'revise',
      '--trigger-category',
      'new-scenario',
      '--trigger-category',
      'bad-case',
      '--evidence',
      'x',
      '--supersedes',
      'a',
    ]);
    expect(code).toBe(2);
  });

  test('unknown flag: exits 2 (usage error), like every other subcommand', async () => {
    const code = await main(['revise', '--trigger-category', 'bad-case', '--evidence', 'x', '--supersedes', 'a', '--yes']);
    expect(code).toBe(2);
  });

  test('an empty --supersedes value is rejected the same way as an omitted one', async () => {
    const code = await withFakeStdin(createTTYStdin(), () =>
      main(['revise', '--trigger-category', 'bad-case', '--evidence', 'x', '--supersedes', '']),
    );
    expect(code).toBe(1);
    expect(logs.join('\n')).toContain('supersedes');
  });
});
