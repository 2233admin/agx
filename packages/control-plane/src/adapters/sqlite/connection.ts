import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

/**
 * `[并发缺陷修复 2026-08-24]` 本包内每个 `bun:sqlite` 仓储
 * （`repository.ts`、`config-revision-writer.ts`、`launch-repository.ts`）
 * 共用的连接建立逻辑。三者此前各自手写一份 `mkdirSync` + `new Database` +
 * 同一串 PRAGMA 来打开同一个 `.sqlite3` 文件，而且副本已经漂移过：
 * `launch-repository.ts` 根本没设 `busy_timeout`（Epic 1 回顾把它按"MVP 是
 * 单操作者本地 CLI，并发窗口小"记为 defer），可它和 `repository.ts` 打开的
 * 是同一个文件——见 `cli/index.ts` 的 `openDeps()`，两个仓储对同一路径先后
 * 构造。
 *
 * 收拢到一处也让 `PRAGMA journal_mode = WAL` 只剩一个正确实现，为什么此前
 * 那个不正确见 `enableWalMode`。
 */

/** 某条语句遇到其他连接持有的锁时，SQLite 放弃前愿意等待的时长。 */
const BUSY_TIMEOUT_MS = 5000;

/**
 * `enableWalMode` 的重试预算。刻意与 `BUSY_TIMEOUT_MS` 取同一个值：既然调用方
 * 愿意为一条争用的语句等 5 秒，就该为它之前那次日志模式切换等同样久，这样两者
 * 不会被调成互相矛盾。
 */
const WAL_RETRY_BUDGET_MS = BUSY_TIMEOUT_MS;

/** `enableWalMode` 两次重试之间的轮询间隔。 */
const WAL_RETRY_INTERVAL_MS = 20;

/**
 * 判断错误是否只是"另一个连接正持有锁"，而不是真的失败。`bun:sqlite` 抛出的
 * `SQLiteError` 带结构化 `code`（`'SQLITE_BUSY'`，errno 5），message 为
 * `database is locked`；以 `code` 为准，message 只作为不填 `code` 的驱动或
 * 版本的兜底。
 */
export function isDatabaseLocked(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }
  if ((error as { code?: unknown }).code === 'SQLITE_BUSY') {
    return true;
  }
  const message = String((error as { message?: unknown }).message ?? '').toLowerCase();
  return message.includes('sqlite_busy') || message.includes('database is locked');
}

/**
 * `enableWalMode` 实际用到的 `bun:sqlite` `Database` 子集。声明成结构类型是为了
 * 让测试能用 fake 驱动这段重试逻辑——它防的那个竞态依赖时序，用真实进程复现不出
 * 确定性结果。
 */
export interface JournalModeCapableDatabase {
  exec(sql: string): unknown;
  query(sql: string): { get(): { journal_mode?: string } | null | undefined };
}

/** 数据库当前的日志模式，小写（如 `'wal'`、`'delete'`、`'memory'`）。 */
function journalMode(db: JournalModeCapableDatabase): string {
  return String(db.query('PRAGMA journal_mode').get()?.journal_mode ?? '').toLowerCase();
}

/**
 * `[并发缺陷修复 2026-08-24]` 把数据库切到 WAL，并容忍另一个连接同时在做同一次
 * 切换。
 *
 * 这里的重试不是保险起见加的，它是唯一有效的手段——因为 `PRAGMA busy_timeout`
 * 可证明覆盖不到这一种情况。在本仓实测：
 *
 *   - `PRAGMA journal_mode = WAL` 与一个普通的、已持有的写锁（另一进程里的
 *     `BEGIN EXCLUSIVE`）争用时，**会**走 busy handler：锁持有 2000ms，该语句
 *     等了 2021ms 然后成功。
 *   - `PRAGMA journal_mode = WAL` 与**另一个连接正在做的日志模式转换**争用时，
 *     **不会**：在 `busy_timeout` 已设为 5000ms 的前提下，2ms 就抛
 *     `SQLITE_BUSY`。同时打开同一个全新文件的进程对里约 40% 会撞上。
 *
 * 所以此前那套做法——先设 `busy_timeout`，理由写的是"两个全新进程并发打开同一个
 * 数据库时 `PRAGMA journal_mode = WAL` 自身也会争用"——竞态判断是对的，但选的
 * 缓解手段在结构上就覆盖不到它，超时值调多大都没用。
 * `runConfigRevisionMigrations` 里的 `isConcurrentMigrationRace` 容忍也接不住，
 * 因为这条 PRAGMA 跑在连接建立阶段，在那个函数之外。于是两个 `configs` 进程对
 * 全新数据库并发时会以 `configs: unexpected failure: database is locked` 失败
 * ——表现为 `cli-establish.test.ts` 的"真实并发 establish"偶发失败，而
 * `spec-3-2-修订现有配置-configs-revise.md` 把它记成了 Windows 锁竞争*超时*
 * （恰好相反：它根本没等）。
 *
 * 日志模式是持久化在数据库文件里的，所以竞态里输掉的那个连接不需要再赢一次，
 * 它只需要观察到赢家已经把文件转换完了。
 */
export function enableWalMode(
  db: JournalModeCapableDatabase,
  options: { budgetMs?: number; intervalMs?: number; sleep?: (ms: number) => void } = {},
): void {
  const budgetMs = options.budgetMs ?? WAL_RETRY_BUDGET_MS;
  const intervalMs = options.intervalMs ?? WAL_RETRY_INTERVAL_MS;
  const sleep = options.sleep ?? ((ms: number) => Bun.sleepSync(ms));

  // 已经是 WAL——第一个连接之后的每个连接都走这条路。不转换、不取独占锁、
  // 没有可争用的东西。
  if (journalMode(db) === 'wal') {
    return;
  }

  const deadline = Date.now() + budgetMs;
  for (;;) {
    try {
      db.exec('PRAGMA journal_mode = WAL;');
      return;
    } catch (error) {
      if (!isDatabaseLocked(error)) {
        throw error;
      }
      // 与上面那次转换不同，这里的读是一条普通语句，会走 busy handler，
      // 因此 `busy_timeout` 覆盖得到。
      if (journalMode(db) === 'wal') {
        return;
      }
      if (Date.now() >= deadline) {
        throw error;
      }
      sleep(intervalMs);
    }
  }
}

/**
 * 按需创建父目录、打开 `dbPath`，并装上本包每个仓储都依赖的连接级策略。
 * 各自的迁移由调用方随后自行执行。
 *
 * 顺序有讲究：先 `busy_timeout`，好让 `enableWalMode` 内部那次日志模式探测能等
 * 出并发写者；再 WAL；最后外键（SQLite 默认按连接关闭外键约束——不设这条，
 * `stable_config_revision` 的 `REFERENCES stable_config` 只是摆设）。
 */
export function openSqliteDatabase(dbPath: string): Database {
  if (dbPath !== ':memory:') {
    mkdirSync(path.dirname(dbPath), { recursive: true });
  }
  const db = new Database(dbPath, { create: true });
  db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS};`);
  enableWalMode(db);
  db.exec('PRAGMA foreign_keys = ON;');
  return db;
}
