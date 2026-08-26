import { Database } from 'bun:sqlite';
// Embedded as text at bundle/compile time (Bun's `with { type: 'text' }`
// import attribute) rather than resolved at runtime via `import.meta.url` +
// `readFileSync` -- a runtime filesystem path is meaningless once this
// module is compiled into a standalone `bun build --compile` executable,
// where `import.meta.url` resolves into Bun's embedded virtual filesystem
// and no `migrations/*.sql` file exists on disk next to the binary at all.
import INIT_SQL from '../../../migrations/0001_init.sql' with { type: 'text' };
import SUPPLY_SQL from '../../../migrations/0003_supply.sql' with { type: 'text' };

import { type Fact, unknown } from '../../domain/facts';
import type { CapabilityReference, SourceCategory, StableConfigRevision } from '../../domain/config';
import type { ConfigRevisionRepository } from '../../application/ports';
import { ConfigUnsupportedError } from '../../application/queries';
import { factColumns, factColumnToFact } from './fact-columns';
import { isDatabaseLocked, openSqliteDatabase } from './connection';

/** The only `stable_config_revision.schema_version` this Story can read. */
const SUPPORTED_SCHEMA_VERSION = 1;

export interface RevisionRow {
  revision_id: string;
  config_name: string;
  schema_version: number;
  default_marker_status: string;
  default_marker_value: string | null;
  default_marker_reason: string | null;
  default_marker_observed_at: string | null;
  scope_boundary_status: string;
  scope_boundary_value: string | null;
  scope_boundary_reason: string | null;
  scope_boundary_observed_at: string | null;
  availability_status: string;
  availability_value: string | null;
  availability_reason: string | null;
  availability_observed_at: string | null;
  instructions_json: string;
  skills_json: string;
  mcp_json: string;
  hooks_json: string;
  plugins_json: string;
  /** `[Story 3.1]` NOT NULL columns added by `migrations/0003_supply.sql`. */
  trigger_category: string;
  evidence_ref: string;
  /** `[Story 3.1]` Nullable; this Story always writes/reads `null` here -- Story 3.2 populates it. */
  supersedes_revision_id: string | null;
}

/**
 * Every parsed entry must carry a non-empty string `name` -- this is the
 * only field of a `CapabilityReference` that ever flows verbatim into a
 * real subprocess argv (`buildOmpArgv` joins `skill.name` into the real
 * `omp --skills` value). Applied uniformly to every capability column
 * (instructions/skills/mcp/hooks/plugins) rather than special-cased to
 * skills alone, since this function is the single choke point all five
 * groups parse through and a future caller could start reading `name` from
 * any of them the same way. A throw here is caught by both of this
 * module's callers (`mapRowStrict` wraps it into `ConfigUnsupportedError`;
 * `mapRowLenient`'s `parseLenient` degrades the affected group to `[]`) --
 * so untrusted stored data is never silently passed through as-is.
 */
function validateCapabilityEntry(entry: unknown): asserts entry is Record<string, unknown> {
  if (entry === null || typeof entry !== 'object') {
    throw new Error('capability entry is not an object');
  }
  const name = (entry as { name?: unknown }).name;
  if (typeof name !== 'string' || name.trim().length === 0) {
    throw new Error('capability entry has a missing or empty "name" field');
  }
}

const CAPABILITY_FIELD_MISSING_OBSERVED_AT = new Date(0).toISOString();

/**
 * `[Story 3.1]` `sourceRef`/`contentFingerprint` did not exist before this
 * Story -- rows written by earlier Stories' `seed()`/`cap-fs.ts` data have
 * neither key at all. Per AD-8, an absent field degrades to `Unknown`
 * rather than throwing (a missing *name* still throws via
 * `validateCapabilityEntry` above -- that field was already required).
 * Applied uniformly to `sourceCategory`/`summary` too, so any other
 * pre-existing-but-now-missing Fact field degrades the same way instead of
 * crashing the whole revision.
 */
function normalizeCapabilityEntry(entry: Record<string, unknown>): CapabilityReference {
  const factOrMissing = (value: unknown): Fact<unknown> =>
    (value as Fact<unknown> | undefined) ?? unknown('not-captured-prior-to-story-3.1', CAPABILITY_FIELD_MISSING_OBSERVED_AT);

  return {
    kind: entry.kind as CapabilityReference['kind'],
    name: entry.name as string,
    sourceCategory: factOrMissing(entry.sourceCategory) as Fact<SourceCategory>,
    summary: factOrMissing(entry.summary) as Fact<string>,
    sourceRef: factOrMissing(entry.sourceRef) as Fact<string>,
    contentFingerprint: factOrMissing(entry.contentFingerprint) as Fact<string>,
  };
}

function parseCapabilityJson(raw: string): CapabilityReference[] {
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error('capability column did not contain a JSON array');
  }
  return parsed.map((entry) => {
    validateCapabilityEntry(entry);
    return normalizeCapabilityEntry(entry);
  });
}

/** Strict mapping used by `findById`: throws a typed error rather than guessing. */
function mapRowStrict(row: RevisionRow): StableConfigRevision {
  if (row.schema_version !== SUPPORTED_SCHEMA_VERSION) {
    throw new ConfigUnsupportedError(
      row.revision_id,
      `unsupported schema_version ${row.schema_version} (expected ${SUPPORTED_SCHEMA_VERSION})`,
    );
  }

  let instructions: CapabilityReference[];
  let skills: CapabilityReference[];
  let mcp: CapabilityReference[];
  let hooks: CapabilityReference[];
  let plugins: CapabilityReference[];
  try {
    instructions = parseCapabilityJson(row.instructions_json);
    skills = parseCapabilityJson(row.skills_json);
    mcp = parseCapabilityJson(row.mcp_json);
    hooks = parseCapabilityJson(row.hooks_json);
    plugins = parseCapabilityJson(row.plugins_json);
  } catch (error) {
    throw new ConfigUnsupportedError(
      row.revision_id,
      `stored capability data could not be parsed: ${(error as Error).message}`,
    );
  }

  return {
    configName: row.config_name,
    revisionId: row.revision_id,
    defaultMarker: factColumnToFact(
      row.default_marker_status,
      row.default_marker_value,
      row.default_marker_reason,
      row.default_marker_observed_at,
      (v) => v === 'true',
    ) as Fact<boolean>,
    scopeBoundary: factColumnToFact(
      row.scope_boundary_status,
      row.scope_boundary_value,
      row.scope_boundary_reason,
      row.scope_boundary_observed_at,
      (v) => v,
    ) as Fact<string>,
    availability: factColumnToFact(
      row.availability_status,
      row.availability_value,
      row.availability_reason,
      row.availability_observed_at,
      () => 'resolved' as const,
    ) as Fact<'resolved'>,
    instructions,
    skills,
    mcp,
    hooks,
    plugins,
    triggerCategory: row.trigger_category as StableConfigRevision['triggerCategory'],
    evidenceRef: row.evidence_ref,
    supersedesRevisionId: row.supersedes_revision_id,
  };
}

/**
 * Lenient mapping used by `listAll`: one malformed revision must not hide
 * the rest of the list. Unsupported schema/unparseable capability data
 * degrades that revision's affected fields to `Unknown` instead of
 * throwing.
 */
function mapRowLenient(row: RevisionRow): StableConfigRevision {
  const now = new Date().toISOString();

  if (row.schema_version !== SUPPORTED_SCHEMA_VERSION) {
    return {
      configName: row.config_name,
      revisionId: row.revision_id,
      defaultMarker: unknown(`unsupported schema_version ${row.schema_version}`, now),
      scopeBoundary: unknown(`unsupported schema_version ${row.schema_version}`, now),
      availability: unknown(`unsupported schema_version ${row.schema_version}`, now),
      instructions: [],
      skills: [],
      mcp: [],
      hooks: [],
      plugins: [],
      triggerCategory: row.trigger_category as StableConfigRevision['triggerCategory'],
      evidenceRef: row.evidence_ref,
      supersedesRevisionId: row.supersedes_revision_id,
    };
  }

  const parseLenient = (raw: string): CapabilityReference[] => {
    try {
      return parseCapabilityJson(raw);
    } catch {
      return [];
    }
  };

  return {
    configName: row.config_name,
    revisionId: row.revision_id,
    defaultMarker: factColumnToFact(
      row.default_marker_status,
      row.default_marker_value,
      row.default_marker_reason,
      row.default_marker_observed_at,
      (v) => v === 'true',
    ) as Fact<boolean>,
    scopeBoundary: factColumnToFact(
      row.scope_boundary_status,
      row.scope_boundary_value,
      row.scope_boundary_reason,
      row.scope_boundary_observed_at,
      (v) => v,
    ) as Fact<string>,
    availability: factColumnToFact(
      row.availability_status,
      row.availability_value,
      row.availability_reason,
      row.availability_observed_at,
      () => 'resolved' as const,
    ) as Fact<'resolved'>,
    instructions: parseLenient(row.instructions_json),
    skills: parseLenient(row.skills_json),
    mcp: parseLenient(row.mcp_json),
    hooks: parseLenient(row.hooks_json),
    plugins: parseLenient(row.plugins_json),
    triggerCategory: row.trigger_category as StableConfigRevision['triggerCategory'],
    evidenceRef: row.evidence_ref,
    supersedesRevisionId: row.supersedes_revision_id,
  };
}

const REVISION_COLUMNS = [
  'revision_id',
  'config_name',
  'schema_version',
  'default_marker_status',
  'default_marker_value',
  'default_marker_reason',
  'default_marker_observed_at',
  'scope_boundary_status',
  'scope_boundary_value',
  'scope_boundary_reason',
  'scope_boundary_observed_at',
  'availability_status',
  'availability_value',
  'availability_reason',
  'availability_observed_at',
  'instructions_json',
  'skills_json',
  'mcp_json',
  'hooks_json',
  'plugins_json',
  'created_at',
  'trigger_category',
  'evidence_ref',
  'supersedes_revision_id',
].join(', ');

/**
 * `[Story 3.1]` 由 `SqliteConfigRevisionRepository` 与
 * `adapters/sqlite/config-revision-writer.ts` 的 `SqliteConfigRevisionWriter`
 * 共用——两者打开的是同一张 `stable_config_revision` 表，无论谁先对某个数据库
 * 文件完成构造，施加的迁移都必须完全一致。
 *
 * `0001_init.sql` 天然幂等（`CREATE TABLE`／`CREATE INDEX IF NOT EXISTS`），
 * 所以每次都直接重跑一遍。`0003_supply.sql` 不是——SQLite 的
 * `ALTER TABLE ... ADD COLUMN` 没有 `IF NOT EXISTS` 写法。
 *
 * `[审查修复]` `0003_supply.sql` 里那三条 `ALTER TABLE ... ADD COLUMN` 是*逐列
 * 单独*门控的，每列一次 `pragma_table_info` 存在性检查，而不是拿
 * `trigger_category` 在不在当作"整个文件已经跑过"的代理判断。合并成一个门控 +
 * 一次批量 `db.exec(SUPPLY_SQL)` 会把三条 `ALTER` 放进同一个事务；对一个已经有
 * 三列中的一部分、但不是全部的历史库（例如某次半途中断只加了
 * `supersedes_revision_id`），批次里靠后的语句会抛 `"duplicate column name"`，
 * 把*整个*事务回滚掉——连那条语句本该合法加上的列一起回滚——而这个失败随后又被
 * 当成"别人已经迁移过了"吞掉，于是数据库缺列的状态被静默保留下来。逐列独立门控
 * 意味着半迁移的库正好补上它缺的那几列，不回滚，不吞错。
 *
 * `[审查修复]` 逐列的"先查后改"仍然是两条独立语句、不是一次原子操作——两个大约
 * 同时打开同一文件的独立连接，可能都观察到"这一列还没迁移"，进而都去执行同一条
 * `ALTER TABLE`。与其用跨进程锁去封这个竞态，这里依赖 `PRAGMA busy_timeout`
 * （由 `connection.ts` 的 `openSqliteDatabase` 设置，现在三个仓储都从这个唯一
 * 入口打开连接），让 SQLite 自己等过短暂的锁争用而不是立刻失败；再作为超出该
 * 超时的争用的兜底，把 SQLite 对竞态输家那条 `ALTER TABLE ... ADD COLUMN` 的
 * 拒绝（`"duplicate column name"`）*或*一个锁争用错误
 * （`SQLITE_BUSY`／`"database is locked"`）当作"别人已经有这一列、或正在加"的
 * 权威信号并吞掉——其余任何错误照常向上抛。
 */
const SUPPLY_ADD_COLUMN_RE = /^ALTER TABLE\s+stable_config_revision\s+ADD COLUMN\s+(\w+)/i;

/** Splits a `.sql` file's text into individual statements, comments stripped. */
function splitSqlStatements(sql: string): string[] {
  return sql
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n')
    .split(';')
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
}

function columnExists(db: Database, table: string, column: string): boolean {
  return (
    (db
      .query<{ present: number }, [string]>(`SELECT COUNT(*) AS present FROM pragma_table_info('${table}') WHERE name = ?`)
      .get(column)?.present ?? 0) > 0
  );
}

/**
 * 另一个连接正在跑同一次迁移造成的竞态——熬过 `PRAGMA busy_timeout` 的锁争用，
 * 或者 `duplicate column name` 竞态里输掉的那一方——不是真的失败。
 */
function isConcurrentMigrationRace(error: unknown): boolean {
  // `[deferred-work 项修复]` busy 那一半现在走 `connection.ts` 共用的
  // `isDatabaseLocked`：优先用 `bun:sqlite` 的结构化 `code === 'SQLITE_BUSY'`
  // 而不是子串匹配，message 判断只留作兜底。`duplicate column name` 没有对应的
  // 结构化 code（它是通用的 `SQLITE_ERROR`），所以仍然按 message 匹配。
  const message = ((error as Error).message ?? '').toLowerCase();
  return message.includes('duplicate column name') || isDatabaseLocked(error);
}

export function runConfigRevisionMigrations(db: Database): void {
  db.transaction(() => {
    db.exec(INIT_SQL);
  })();

  for (const statement of splitSqlStatements(SUPPLY_SQL)) {
    const addColumnMatch = SUPPLY_ADD_COLUMN_RE.exec(statement);
    try {
      if (addColumnMatch === null) {
        // `CREATE UNIQUE INDEX IF NOT EXISTS ...` -- idempotent at the SQL
        // level (no existence pre-check needed), but this loop now runs on
        // *every* construction (not just the first-ever migration, since
        // the single `alreadyMigrated` early-return above was removed by
        // the per-column gating refactor) -- so it needs the same
        // lock-contention tolerance as the `ADD COLUMN` branch below,
        // otherwise `SQLITE_BUSY`/"database is locked" landing on an index
        // statement would still propagate uncaught on every launch.
        db.exec(statement);
        continue;
      }
      const column = addColumnMatch[1]!;
      if (columnExists(db, 'stable_config_revision', column)) {
        continue;
      }
      db.exec(statement);
    } catch (error) {
      if (!isConcurrentMigrationRace(error)) {
        throw error;
      }
      // 另一个连接赢下了这一列／这个索引的竞态——幂等空操作，不是失败。
    }
  }
}

/**
 * `bun:sqlite` STRICT repository. Every query uses parameterized SQL and
 * explicit columns; no `SELECT *`. Runs the migration inside a transaction
 * on construction so the schema is always present before use.
 */
export class SqliteConfigRevisionRepository implements ConfigRevisionRepository {
  private readonly db: Database;

  constructor(dbPath: string) {
    this.db = openSqliteDatabase(dbPath);
    runConfigRevisionMigrations(this.db);
  }

  async listAll(): Promise<readonly StableConfigRevision[]> {
    const rows = this.db
      .query<RevisionRow, []>(`SELECT ${REVISION_COLUMNS} FROM stable_config_revision ORDER BY config_name, revision_id`)
      .all();
    return rows.map(mapRowLenient);
  }

  async findById(revisionId: string): Promise<StableConfigRevision | null> {
    const row = this.db
      .query<RevisionRow, [string]>(`SELECT ${REVISION_COLUMNS} FROM stable_config_revision WHERE revision_id = ?`)
      .get(revisionId);
    if (row === null) {
      return null;
    }
    return mapRowStrict(row);
  }

  /**
   * Development-only seed helper (not part of the read-only port). Used by
   * tests to populate SQLite fixtures. `[Story 4.7]` Previously also used by
   * `scripts/seed-from-cap.ts`, a developer-only script that seeded this
   * repository from the real repo `.cap/` directory; that script was
   * deleted when `.cap/` was retired (`configs establish`/`configs revise`,
   * Story 3.1/3.2, are the supported non-interactive supply path now).
   * Replaces the full contents of both tables inside one transaction.
   */
  seed(revisions: readonly StableConfigRevision[]): void {
    const insertConfig = this.db.query<unknown, [string]>(
      'INSERT OR IGNORE INTO stable_config (config_name) VALUES (?)',
    );
    const insertRevision = this.db.query<
      unknown,
      [
        string,
        string,
        number,
        string,
        string | null,
        string | null,
        string | null,
        string,
        string | null,
        string | null,
        string | null,
        string,
        string | null,
        string | null,
        string | null,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string | null,
      ]
    >(
      `INSERT OR REPLACE INTO stable_config_revision (${REVISION_COLUMNS})
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    this.db.transaction(() => {
      this.db.exec('DELETE FROM stable_config_revision');
      this.db.exec('DELETE FROM stable_config');
      for (const revision of revisions) {
        insertConfig.run(revision.configName);

        const defaultMarker = factColumns(revision.defaultMarker);
        const scopeBoundary = factColumns(revision.scopeBoundary);
        const availability = factColumns(revision.availability);

        insertRevision.run(
          revision.revisionId,
          revision.configName,
          SUPPORTED_SCHEMA_VERSION,
          defaultMarker.status,
          defaultMarker.value,
          defaultMarker.reason,
          defaultMarker.observedAt,
          scopeBoundary.status,
          scopeBoundary.value,
          scopeBoundary.reason,
          scopeBoundary.observedAt,
          availability.status,
          availability.value,
          availability.reason,
          availability.observedAt,
          JSON.stringify(revision.instructions),
          JSON.stringify(revision.skills),
          JSON.stringify(revision.mcp),
          JSON.stringify(revision.hooks),
          JSON.stringify(revision.plugins),
          new Date().toISOString(),
          revision.triggerCategory,
          revision.evidenceRef,
          revision.supersedesRevisionId,
        );
      }
    })();
  }

  /** Test-only escape hatch: insert a row without going through `seed()`'s validation. */
  insertRawRow(row: RevisionRow): void {
    const insertConfig = this.db.query<unknown, [string]>(
      'INSERT OR IGNORE INTO stable_config (config_name) VALUES (?)',
    );
    const insertRevision = this.db.query<
      unknown,
      [
        string,
        string,
        number,
        string,
        string | null,
        string | null,
        string | null,
        string,
        string | null,
        string | null,
        string | null,
        string,
        string | null,
        string | null,
        string | null,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string | null,
      ]
    >(
      `INSERT OR REPLACE INTO stable_config_revision (${REVISION_COLUMNS})
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.db.transaction(() => {
      insertConfig.run(row.config_name);
      insertRevision.run(
        row.revision_id,
        row.config_name,
        row.schema_version,
        row.default_marker_status,
        row.default_marker_value,
        row.default_marker_reason,
        row.default_marker_observed_at,
        row.scope_boundary_status,
        row.scope_boundary_value,
        row.scope_boundary_reason,
        row.scope_boundary_observed_at,
        row.availability_status,
        row.availability_value,
        row.availability_reason,
        row.availability_observed_at,
        row.instructions_json,
        row.skills_json,
        row.mcp_json,
        row.hooks_json,
        row.plugins_json,
        new Date().toISOString(),
        row.trigger_category,
        row.evidence_ref,
        row.supersedes_revision_id,
      );
    })();
  }

  close(): void {
    this.db.close();
  }
}
