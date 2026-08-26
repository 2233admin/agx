import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { type JournalModeCapableDatabase, enableWalMode, isDatabaseLocked, openSqliteDatabase } from '../../src/adapters/sqlite/connection';

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(tmpdir(), 'configs-connection-'));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function pragma(db: Database, name: string): unknown {
  return Object.values(db.query(`PRAGMA ${name}`).get() ?? {})[0];
}

function sqliteBusy(): Error {
  return Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY', errno: 5 });
}

/**
 * 一个 `Database` 替身：它的日志模式转换会先固定失败若干次 `SQLITE_BUSY`，然后
 * 成功——正是并发进程的转换对一个真实连接造成的效果，只是可以按需触发。
 *
 * 刻意用 fake 而不是真实进程来驱动：真实竞态依赖时序（实测约 40% 的进程对会撞
 * 上），所以基于进程的测试只有约 40% 的概率能发现回归。下面的 `真实并发打开`
 * 仍然作为冒烟测试跑真实场景；而这一组才是"重试一旦被删就必然失败"的那个。
 */
class FakeDatabase implements JournalModeCapableDatabase {
  mode = 'delete';
  execCalls = 0;
  queryCalls = 0;

  constructor(
    private readonly failures: number,
    /** 失败次数用尽后报告的模式——`'wal'` 用来模拟竞态里赢下的那一方。 */
    private readonly modeAfterFailures: string | null = null,
  ) {}

  exec(): unknown {
    this.execCalls += 1;
    if (this.execCalls <= this.failures) {
      throw sqliteBusy();
    }
    this.mode = 'wal';
    return undefined;
  }

  query(): { get(): { journal_mode?: string } | null } {
    return {
      get: () => {
        this.queryCalls += 1;
        if (this.modeAfterFailures !== null && this.execCalls >= this.failures) {
          return { journal_mode: this.modeAfterFailures };
        }
        return { journal_mode: this.mode };
      },
    };
  }
}

describe('enableWalMode', () => {
  test('converts a non-WAL database in one shot when nothing contends', () => {
    const db = new FakeDatabase(0);
    enableWalMode(db, { sleep: () => {} });
    expect(db.execCalls).toBe(1);
    expect(db.mode).toBe('wal');
  });

  test('skips the conversion entirely when the file is already WAL', () => {
    const db = new FakeDatabase(0);
    db.mode = 'wal';
    enableWalMode(db, { sleep: () => {} });
    expect(db.execCalls).toBe(0);
  });

  test('retries past SQLITE_BUSY instead of propagating it -- the regression this module exists for', () => {
    const db = new FakeDatabase(3);
    const slept: number[] = [];
    enableWalMode(db, { intervalMs: 7, sleep: (ms) => slept.push(ms) });
    expect(db.execCalls).toBe(4);
    expect(db.mode).toBe('wal');
    expect(slept).toEqual([7, 7, 7]);
  });

  test('stops as soon as a concurrent connection has already converted the file, without retrying to its own success', () => {
    // 失败一次，而此时竞争方已经把文件切成 WAL：输的一方必须观察到这一点并
    // 返回，而不是继续尝试把自己那次转换做成功。
    const db = new FakeDatabase(1, 'wal');
    let slept = 0;
    enableWalMode(db, { sleep: () => (slept += 1) });
    expect(db.execCalls).toBe(1);
    expect(slept).toBe(0);
  });

  test('gives up and rethrows the busy error once the budget is exhausted', () => {
    const db = new FakeDatabase(Number.MAX_SAFE_INTEGER);
    expect(() => enableWalMode(db, { budgetMs: 0, sleep: () => {} })).toThrow('database is locked');
  });

  test('never swallows a non-busy error', () => {
    const db = {
      exec() {
        throw new Error('disk I/O error');
      },
      query: () => ({ get: () => ({ journal_mode: 'delete' }) }),
    };
    expect(() => enableWalMode(db, { sleep: () => {} })).toThrow('disk I/O error');
  });
});

describe('openSqliteDatabase', () => {
  test('creates the parent directory of a not-yet-existing database file', () => {
    const dbPath = path.join(tmpDir, 'nested', 'deeper', 'db.sqlite3');
    const db = openSqliteDatabase(dbPath);
    expect(existsSync(dbPath)).toBe(true);
    db.close();
  });

  test('installs WAL, foreign keys and a non-zero busy timeout on a file database', () => {
    const db = openSqliteDatabase(path.join(tmpDir, 'db.sqlite3'));
    expect(pragma(db, 'journal_mode')).toBe('wal');
    expect(pragma(db, 'foreign_keys')).toBe(1);
    expect(pragma(db, 'busy_timeout')).toBeGreaterThan(0);
    db.close();
  });

  test('a second connection to an already-WAL file opens without re-running the conversion', () => {
    const dbPath = path.join(tmpDir, 'db.sqlite3');
    const first = openSqliteDatabase(dbPath);
    const second = openSqliteDatabase(dbPath);
    expect(pragma(second, 'journal_mode')).toBe('wal');
    second.close();
    first.close();
  });

  test(':memory: is opened without touching the filesystem', () => {
    const db = openSqliteDatabase(':memory:');
    // 内存数据库不可能是 WAL——这条测的是打开它既不抛错，也不会去对
    // `':memory:'` 取 dirname 后 `mkdirSync`。
    expect(pragma(db, 'journal_mode')).toBe('memory');
    expect(pragma(db, 'foreign_keys')).toBe(1);
    db.close();
  });

  /**
   * 用真实进程对真实竞态做端到端冒烟——上面的 fake 证明重试逻辑本身正确，这条
   * 证明它确实接进了真实的连接建立路径。它本质上是概率性的（跑绿一次说明不了
   * 多少），所以是对确定性测试的补充，不是替代。
   */
  test('真实并发打开: 六个进程同时对同一全新库文件调用 openSqliteDatabase，无一因 journal_mode 锁竞争失败', async () => {
    const dbPath = path.join(tmpDir, 'race.sqlite3');
    const openerPath = path.join(tmpDir, 'opener.ts');
    const connectionModule = path.join(import.meta.dir, '..', '..', 'src', 'adapters', 'sqlite', 'connection.ts');
    await Bun.write(
      openerPath,
      `import { openSqliteDatabase } from ${JSON.stringify(connectionModule)};\n` +
        `const db = openSqliteDatabase(process.argv[2]);\n` +
        `console.log(db.query('PRAGMA journal_mode').get().journal_mode);\n` +
        `db.close();\n`,
    );

    const processes = Array.from({ length: 6 }, () =>
      Bun.spawn({ cmd: [process.execPath, 'run', openerPath, dbPath], stdout: 'pipe', stderr: 'pipe' }),
    );
    const results = await Promise.all(
      processes.map(async (proc) => ({
        exitCode: await proc.exited,
        stdout: (await new Response(proc.stdout).text()).trim(),
        stderr: (await new Response(proc.stderr).text()).trim(),
      })),
    );

    expect(results.filter((r) => r.exitCode !== 0).map((f) => f.stderr)).toEqual([]);
    // 每个进程还必须一致认为文件最终是 WAL——一次静默退回 rollback-journal
    // 模式的"成功"会让这条测试失去意义。
    expect(results.map((r) => r.stdout)).toEqual(Array(6).fill('wal'));
  }, 30000);
});

describe('isDatabaseLocked', () => {
  test('recognises bun:sqlite structured code', () => {
    expect(isDatabaseLocked(sqliteBusy())).toBe(true);
  });

  test('falls back to the message when no structured code is present', () => {
    expect(isDatabaseLocked(new Error('database is locked'))).toBe(true);
    expect(isDatabaseLocked(new Error('SQLITE_BUSY: something'))).toBe(true);
  });

  test('does not swallow unrelated errors or non-objects', () => {
    expect(isDatabaseLocked(new Error('no such table: stable_config'))).toBe(false);
    expect(isDatabaseLocked(Object.assign(new Error('x'), { code: 'SQLITE_CONSTRAINT' }))).toBe(false);
    expect(isDatabaseLocked(null)).toBe(false);
    expect(isDatabaseLocked('database is locked')).toBe(false);
  });
});
