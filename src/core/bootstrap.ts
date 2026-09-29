import { rawErrorText } from './errors'
import { INIT_DDL, splitStatements } from './schema-ddl'
import {
  diffSchema,
  schemaOk,
  EXPECTED_MIGRATIONS,
  type FoundSchema,
  type SchemaDiff,
} from './schema-contract'

/**
 * 与 wrangler helpers.ts getCreateMigrationsTableQuery 逐字一致，
 * 两套系统才能互相认出对方写下的记账行。
 */
const CREATE_MIGRATIONS_TABLE = `CREATE TABLE IF NOT EXISTS d1_migrations(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE,
  applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
)`

type Migration = {
  name: string
  statements: string[]
  /**
   * false = 非幂等。运行时自举只应用 idempotent: true 的迁移：
   * 0001_init.sql 全是 CREATE ... IF NOT EXISTS，重复执行安全；
   * 而加列的迁移重复跑会报 duplicate column name，必须走 CLI 的
   * npm run db:migrate。
   *
   * 这个标记只存在于代码里，SQL 里没有——所以必须有 review 纪律：
   * 新增 migration 文件时同步加进 MIGRATIONS 并显式填 idempotent。
   */
  idempotent: boolean
}

const MIGRATIONS: readonly Migration[] = [
  { name: '0001_init.sql', statements: splitStatements(INIT_DDL), idempotent: true },
]

export type BootstrapResult = {
  /** 执行过 DDL 的迁移。幂等重跑也算，所以修复漂移时这里同样非空 */
  applied: string[]
  /** 契约已完整、一个 DDL 都没跑 */
  skipped: boolean
  /** 非幂等、或契约里有但代码没登记的迁移，以及补不上的缺列 */
  refused: string[]
  error?: string
}

/** 契约里声明了但 MIGRATIONS 里没有的迁移：文件加了、代码没同步 */
function unlistedMigrations(): string[] {
  const listed = new Set(MIGRATIONS.map((migration) => migration.name))
  return EXPECTED_MIGRATIONS.filter((name) => !listed.has(name))
}

/**
 * isolate 内已确认过 schema 完整。模块级状态随 isolate 一起消失，
 * 所以新 isolate 会重新确认一次——而健康状态下永远只有一个查询。
 *
 * 没有这个记忆的话，中间件会给**每个请求**加一次 sqlite_master 查询：
 * 免费额度一天 10 万请求，就是额外 10 万次 D1 查询，
 * 而它本来只需要在 isolate 冷启动时问一次。
 */
let verifiedInIsolate = false

/** 仅测试用：让下一次 ensureSchema 重新做完整判断 */
export function resetSchemaCheck(): void {
  verifiedInIsolate = false
}

/**
 * 一次查询拿全库结构：sqlite_master 给表名与索引名，pragma_table_info 给每表列。
 * healthz 的 schema 段和自举的快路径共用它，避免两处各写一份 SQL 走偏。
 */
export async function readFoundSchema(db: D1Database): Promise<FoundSchema> {
  const rows = await db
    .prepare(
      `SELECT m.name AS name, m.type AS type, p.name AS col
       FROM sqlite_master m
       LEFT JOIN pragma_table_info(m.name) p
       WHERE m.type IN ('table', 'index')`,
    )
    .all<{ name: string; type: string; col: string | null }>()

  const tables = new Set<string>()
  const columns = new Map<string, Set<string>>()
  const indexes = new Set<string>()
  for (const row of rows.results ?? []) {
    if (row.type === 'index') {
      // sqlite_autoindex_* 是 WITHOUT ROWID 主键的内部索引，不参与校验
      if (!row.name.startsWith('sqlite_autoindex_')) indexes.add(row.name)
      continue
    }
    tables.add(row.name)
    if (typeof row.col === 'string') {
      const set = columns.get(row.name) ?? new Set<string>()
      set.add(row.col)
      columns.set(row.name, set)
    }
  }
  return { tables, columns, indexes }
}

/**
 * 一次查询就能同时回答「结构全不全」和「D1 通不通」：
 * 读得出行 → D1 可用；再比对契约决定要不要补；
 * 查询抛错 → D1 不可用，异常上抛让 healthz 报 503。
 *
 * 不能用 `SELECT 1 FROM cache`：空表的 .first() 返回 null，
 * 与「表不存在」无法区分，会导致每请求都重跑一次迁移探测。
 */
export async function ensureSchema(env: Env): Promise<BootstrapResult> {
  if (verifiedInIsolate) return { applied: [], skipped: true, refused: [] }

  // 冷路径：这里做完整契约比对而不是「cache 表在不在」。快路径每个 isolate
  // 只跑一次，多花一次查询完全值得——只看表名会漏掉「表在但缺列/缺索引」
  // 的半截状态，而那种状态恰恰是自举最该修的。
  let diff: SchemaDiff
  try {
    diff = diffSchema(await readFoundSchema(env.DB))
  } catch {
    throw new Error('D1 unavailable during schema probe')
  }

  // 只缺列时补不了：CREATE TABLE IF NOT EXISTS 对已存在的表是空操作，
  // 而 ALTER TABLE ADD COLUMN 是非幂等的。这类状态只能靠真的迁移文件，
  // 所以自举不上手，交给 healthz 报出来（指路 db:migrate）。
  const onlyColumnsMissing =
    diff.missingTables.length === 0 &&
    diff.missingIndexes.length === 0 &&
    Object.keys(diff.missingColumns).length > 0

  if (schemaOk(diff)) {
    verifiedInIsolate = true
    return { applied: [], skipped: true, refused: [] }
  }

  const applied: string[] = []
  const refused = unlistedMigrations()
  if (onlyColumnsMissing) refused.push('(missing columns require a real migration)')

  // 记账表必须先单独建好，才能查它里面有没有记录。
  // 空库上此刻它还不存在，直接 SELECT 会抛 "no such table: d1_migrations"，
  // 整个自举挂在第一次查询上，永远装不上。
  try {
    await env.DB.prepare(CREATE_MIGRATIONS_TABLE).run()
  } catch (error) {
    return { applied, skipped: false, refused, error: rawErrorText(error) }
  }

  for (const migration of MIGRATIONS) {
    // 缺列时不要重跑整份 DDL：对已存在的表它是空操作，只会白白多一次 batch
    if (onlyColumnsMissing) break

    // 非幂等迁移**永不**自动执行。条件不是「没记账」，而是「一律不跑」：
    // 加列这类迁移重复执行会报 duplicate column name，只能走 db:migrate。
    if (!migration.idempotent) {
      refused.push(migration.name)
      continue
    }

    // 幂等迁移在这里**不查 d1_migrations**。查了反而修不了漂移：
    // 记账说「跑过了」，但表被人手工删掉 / 半截安装时，DDL 就再也不会重跑，
    // 缺口永远补不上。能走到这个分支说明契约已经不完整，而幂等 DDL 重跑
    // 本来就是安全且正是「修复」动作本身。
    //
    // DDL 与记账同批：batch() 本身即 SQL 事务（D1 文档明确失败回滚整批），
    // 不另包 BEGIN/COMMIT，少两条语句少一个失败点。记账用 INSERT OR IGNORE，
    // 已有记录时是空操作，不会产生重复行。
    const statements = [
      ...migration.statements.map((sql) => env.DB.prepare(sql)),
      env.DB.prepare(
        "INSERT OR IGNORE INTO d1_migrations (name, applied_at) VALUES (?, datetime('now'))",
      ).bind(migration.name),
    ]
    try {
      await env.DB.batch(statements)
      applied.push(migration.name)
    } catch (error) {
      return { applied, skipped: false, refused, error: rawErrorText(error) }
    }
  }

  // 重新比对，而不是假定「跑过 DDL 就一定好了」：
  // diff 里可能同时有缺表和缺列（比如 quota 表在但少一列）。DDL 修得了缺表，
  // 修不了缺列，所以只有复测通过才置位。
  let after: SchemaDiff
  try {
    after = diffSchema(await readFoundSchema(env.DB))
  } catch {
    throw new Error('D1 unavailable during schema probe')
  }
  verifiedInIsolate = schemaOk(after)

  if (verifiedInIsolate) return { applied, skipped: false, refused }

  // 补不上的部分：列缺失只有真的迁移文件能改，而那是非幂等的
  return {
    applied,
    skipped: false,
    refused: [...refused, '(missing columns require a real migration)'],
    error: `schema still incomplete: missing_tables=${JSON.stringify(after.missingTables)}` +
      ` missing_columns=${JSON.stringify(after.missingColumns)}` +
      ` missing_indexes=${JSON.stringify(after.missingIndexes)}`,
  }
}
