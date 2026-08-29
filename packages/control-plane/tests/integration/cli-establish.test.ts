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
  tmpDir = mkdtempSync(path.join(os.tmpdir(), 'control-plane-cli-establish-'));
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

describe('configs establish', () => {
  test('建立成功: valid flags + candidate JSON via --from creates exactly one supersedes=null revision with persisted trigger/evidence, prints detail block', async () => {
    const candidatePath = path.join(tmpDir, 'candidate.json');
    await Bun.write(candidatePath, VALID_CANDIDATE);

    const code = await main(['establish', '--trigger-category', 'new-scenario', '--evidence', 'session-123', '--from', candidatePath]);
    expect(code).toBe(0);
    const output = logs.join('\n');
    expect(output).toContain('Established new configuration revision');
    expect(output).toContain('Configuration: general');

    const all = await listAllRevisions();
    expect(all).toHaveLength(1);
    expect(all[0]!.triggerCategory).toBe('new-scenario');
    expect(all[0]!.evidenceRef).toBe('session-123');
    expect(all[0]!.supersedesRevisionId).toBeNull();
  });

  test('valid candidate JSON piped via stdin (no --from) is also accepted', async () => {
    const code = await withFakeStdin(createDataStdin(VALID_CANDIDATE), () =>
      main(['establish', '--trigger-category', 'known-insufficiency', '--evidence', 'stdin-session']),
    );
    expect(code).toBe(0);
    expect(logs.join('\n')).toContain('Established new configuration revision');
    expect((await listAllRevisions())).toHaveLength(1);
  });

  test('缺 trigger-category: zero writes, never even opens the database file, typed failure block, exit 1', async () => {
    const code = await main(['establish', '--evidence', 'session-123']);
    expect(code).toBe(1);
    expect(logs.join('\n')).toContain('trigger category');
    expect(existsSync(dbPath)).toBe(false);
  });

  test('缺 evidence: zero writes, typed failure block, exit 1', async () => {
    const code = await main(['establish', '--trigger-category', 'new-scenario']);
    expect(code).toBe(1);
    expect(logs.join('\n')).toContain('evidence');
    expect(existsSync(dbPath)).toBe(false);
  });

  test('候选字段类型不符 (defaultMarker not boolean): zero writes, typed "candidate is invalid" failure block, exit 1', async () => {
    const candidatePath = path.join(tmpDir, 'bad-candidate.json');
    await Bun.write(candidatePath, JSON.stringify({ configName: 'general', defaultMarker: { kind: 'known', value: 'not-a-boolean' } }));

    const code = await main(['establish', '--trigger-category', 'new-scenario', '--evidence', 'session-123', '--from', candidatePath]);
    expect(code).toBe(1);
    expect(logs.join('\n')).toContain('candidate is invalid');
    // `[Review fix]` The candidate is validated *before* the write port
    // (and therefore the on-disk db file / its migration) is ever touched.
    expect(existsSync(dbPath)).toBe(false);
  });

  test('候选字段 kind==="unknown" 但 reason 字段存在且类型错误 (数字而非字符串): zero writes, typed "candidate is invalid" failure block, exit 1', async () => {
    const candidatePath = path.join(tmpDir, 'unknown-fact-wrong-type-candidate.json');
    await Bun.write(
      candidatePath,
      JSON.stringify({
        configName: 'general',
        // `[Review fix]` `reason` is *present* but the wrong type -- must
        // be rejected outright, not silently overwritten with the
        // "unspecified" default (that degrade path is reserved for a
        // *missing* `reason`, not a malformed one).
        scopeBoundary: { kind: 'unknown', reason: 12345, observedAt: '2026-08-23T00:00:00.000Z' },
      }),
    );

    const code = await main(['establish', '--trigger-category', 'new-scenario', '--evidence', 'session-123', '--from', candidatePath]);
    expect(code).toBe(1);
    expect(logs.join('\n')).toContain('candidate is invalid');
    expect(existsSync(dbPath)).toBe(false);
  });

  test('候选字段 kind==="unknown" 但 observedAt 字段存在且类型错误 (数字而非字符串): zero writes, typed "candidate is invalid" failure block, exit 1', async () => {
    const candidatePath = path.join(tmpDir, 'unknown-fact-wrong-observedat-candidate.json');
    await Bun.write(
      candidatePath,
      JSON.stringify({
        configName: 'general',
        // `[Review fix]` Same shape as the `reason`-type-error test above,
        // but exercising `observedAt`'s twin branch in `parseFact` --
        // present but wrong-typed must reject, not silently fall back to
        // `MISSING_FIELD_OBSERVED_AT`.
        scopeBoundary: { kind: 'unknown', reason: 'a valid reason', observedAt: 12345 },
      }),
    );

    const code = await main(['establish', '--trigger-category', 'new-scenario', '--evidence', 'session-123', '--from', candidatePath]);
    expect(code).toBe(1);
    expect(logs.join('\n')).toContain('candidate is invalid');
    expect(existsSync(dbPath)).toBe(false);
  });

  test('候选内容是语法不合法的 JSON (截断/非法字符): rejected via the JSON.parse failure branch, not the field-type branch, zero writes, exit 1', async () => {
    const candidatePath = path.join(tmpDir, 'truncated-candidate.json');
    // Deliberately truncated/malformed -- not valid JSON at all (an
    // unterminated object), so this must fail inside `JSON.parse` itself
    // rather than any of `parseCandidateRevision`'s field-type checks.
    await Bun.write(candidatePath, '{ "configName": "general", "defaultMarker": { "kind": "know');

    const code = await main(['establish', '--trigger-category', 'new-scenario', '--evidence', 'session-123', '--from', candidatePath]);
    expect(code).toBe(1);
    expect(logs.join('\n')).toContain('candidate is invalid');
    expect(logs.join('\n')).toContain('JSON');
    expect(existsSync(dbPath)).toBe(false);
  });

  test('候选 JSON 里能力条目的 kind 与所在数组不匹配 (kind: "plugin" 放在 skills 数组里): rejected, zero writes, exit 1', async () => {
    const candidatePath = path.join(tmpDir, 'mismatched-kind-candidate.json');
    await Bun.write(
      candidatePath,
      JSON.stringify({
        configName: 'general',
        skills: [
          {
            kind: 'plugin',
            name: 'not-actually-a-skill',
            sourceCategory: { kind: 'known', value: 'project-capability' },
            summary: { kind: 'known', value: 'x' },
          },
        ],
      }),
    );

    const code = await main(['establish', '--trigger-category', 'new-scenario', '--evidence', 'session-123', '--from', candidatePath]);
    expect(code).toBe(1);
    expect(logs.join('\n')).toContain('candidate is invalid');
    expect(existsSync(dbPath)).toBe(false);
  });

  test('重复传 --trigger-category 两次: usage error (exit 2), same convention as an unknown flag', async () => {
    const code = await main(['establish', '--trigger-category', 'new-scenario', '--trigger-category', 'bad-case', '--evidence', 'x']);
    expect(code).toBe(2);
  });

  test('重复传 --evidence 两次: usage error (exit 2)', async () => {
    const code = await main(['establish', '--trigger-category', 'new-scenario', '--evidence', 'a', '--evidence', 'b']);
    expect(code).toBe(2);
  });

  test('重复传 --from 两次: usage error (exit 2)', async () => {
    const code = await main([
      'establish',
      '--trigger-category',
      'new-scenario',
      '--evidence',
      'x',
      '--from',
      'a.json',
      '--from',
      'b.json',
    ]);
    expect(code).toBe(2);
  });

  test('无 --from 且 stdin 为 TTY: immediate typed failure, not a hang, exit 1, zero writes', async () => {
    const started = Date.now();
    const code = await withFakeStdin(createTTYStdin(), () =>
      main(['establish', '--trigger-category', 'new-scenario', '--evidence', 'session-123']),
    );
    const elapsedMs = Date.now() - started;
    expect(code).toBe(1);
    expect(elapsedMs).toBeLessThan(2000);
    expect(logs.join('\n')).toContain('no candidate source');
    expect(existsSync(dbPath)).toBe(false);
  });

  test('missing --trigger-category is rejected before the stdin-TTY guard is ever reached, even when stdin is a TTY -- never blocks', async () => {
    const code = await withFakeStdin(createTTYStdin(), () => main(['establish', '--evidence', 'session-123']));
    expect(code).toBe(1);
    expect(logs.join('\n')).toContain('trigger category');
  });

  test('--from pointing at a nonexistent path: typed candidate failure, not a crash, exit 1, zero writes', async () => {
    const code = await main([
      'establish',
      '--trigger-category',
      'new-scenario',
      '--evidence',
      'session-123',
      '--from',
      path.join(tmpDir, 'does-not-exist.json'),
    ]);
    expect(code).toBe(1);
    expect(logs.join('\n')).toContain('candidate');
    expect(await listAllRevisions()).toEqual([]);
  });

  test('an invalid --trigger-category value (not one of the three categories) is rejected the same way as an omitted one', async () => {
    const code = await main(['establish', '--trigger-category', 'not-a-real-category', '--evidence', 'session-123']);
    expect(code).toBe(1);
    expect(logs.join('\n')).toContain('trigger category');
  });

  test('an empty --evidence value is rejected the same way as an omitted one', async () => {
    const code = await main(['establish', '--trigger-category', 'new-scenario', '--evidence', '']);
    expect(code).toBe(1);
    expect(logs.join('\n')).toContain('evidence');
  });

  test('unknown flag: exits 2 (usage error), like every other subcommand', async () => {
    const code = await main(['establish', '--trigger-category', 'new-scenario', '--evidence', 'x', '--yes']);
    expect(code).toBe(2);
  });

  // `[Review fix]` Real two-*process* concurrency (not two connections in
  // this same JS thread, which can never model genuine OS-level lock
  // contention resolving mid-wait) -- two independent `bun` subprocesses,
  // each running the actual compiled CLI entrypoint via `import.meta.main`,
  // both racing `runConfigRevisionMigrations` (via the `establish` command)
  // against the very same brand-new db file. Neither may exit non-zero
  // because of lock contention (`PRAGMA busy_timeout` plus the
  // busy/duplicate-column tolerance in `repository.ts`); both establishes
  // must land.
  test('真实并发 establish: 两个进程同时对同一全新库文件执行 establish，两者都不因锁竞争而失败退出', async () => {
    const candidatePathA = path.join(tmpDir, 'candidate-a.json');
    const candidatePathB = path.join(tmpDir, 'candidate-b.json');
    await Bun.write(candidatePathA, VALID_CANDIDATE);
    await Bun.write(candidatePathB, VALID_CANDIDATE);

    const cliEntry = path.join(import.meta.dir, '../../src/cli/index.ts');
    const spawnEstablish = (candidatePath: string, evidenceRef: string) =>
      Bun.spawn({
        cmd: [
          process.execPath,
          'run',
          cliEntry,
          'establish',
          '--trigger-category',
          'new-scenario',
          '--evidence',
          evidenceRef,
          '--from',
          candidatePath,
        ],
        env: { ...process.env, CONTROL_PLANE_DB_PATH: dbPath, CONFIGS_LANG: 'en' },
        stdout: 'pipe',
        stderr: 'pipe',
      });

    // Launched together (not awaited one at a time) so both processes open
    // the same brand-new `dbPath` at roughly the same time -- neither has
    // any migration done yet when the race starts.
    const procA = spawnEstablish(candidatePathA, 'concurrent-proc-a');
    const procB = spawnEstablish(candidatePathB, 'concurrent-proc-b');
    const [exitCodeA, exitCodeB] = await Promise.all([procA.exited, procB.exited]);

    if (exitCodeA !== 0 || exitCodeB !== 0) {
      const [stderrA, stderrB] = await Promise.all([new Response(procA.stderr).text(), new Response(procB.stderr).text()]);
      throw new Error(`process A exit=${exitCodeA} stderr=${stderrA}\nprocess B exit=${exitCodeB} stderr=${stderrB}`);
    }
    expect(exitCodeA).toBe(0);
    expect(exitCodeB).toBe(0);

    const all = await listAllRevisions();
    expect(all).toHaveLength(2);
    expect(new Set(all.map((r) => r.revisionId)).size).toBe(2);
    expect(new Set(all.map((r) => r.evidenceRef))).toEqual(new Set(['concurrent-proc-a', 'concurrent-proc-b']));
  }, 20000);
});
