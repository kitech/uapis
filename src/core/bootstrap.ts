import { rawErrorText } from './errors'
import { INIT_DDL, splitStatements } from './schema-ddl'
import {
  diffSchema,
  schemaOk,
  EXPECTED_MIGRATIONS,
  REQUIRED_TABLES,
  type FoundSchema,
  type ProbeTier,
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
  /** 结构可能没问题，但列没验证过（探测被 D1 拒了一级）。别把它当成缺表 */
  columnsUnverified?: boolean
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

/**
 * 本 isolate 上已验证可用的探测层级。
 * 二级一旦成功就不再试一级——否则每次 healthz 都要白付一次注定被
 * SQLITE_AUTH 拒掉的查询，外加一次异常构造。
 */
let workingTier: ProbeTier | undefined

/** 仅测试用：让下一次 ensureSchema 重新做完整判断 */
export function resetSchemaCheck(): void {
  verifiedInIsolate = false
  workingTier = undefined
}

/**
 * 拿全库结构。healthz 的 schema 段和自举共用它，避免两处各写一份 SQL 走偏。
 *
 * 三级降级，因为 D1 的 SQL authorizer 未必放行某一种写法：
 *   1. join        —— 一条 SQL 搞定，本地 miniflare / SQLite 走这条
 *   2. per_table   —— sqlite_master + 每表一条 pragma_table_info('字面量')
 *   3. master_only —— 只读 sqlite_master，列信息标为未知
 *
 * 生产实测一级被拒：pragma_table_info(m.name) 里 m.name 是列引用，
 * 即动态表名，authorizer 解析不出要授权哪张表，整条语句 SQLITE_AUTH。
 * 而 ensureSchema 的第一步就是它——建表逻辑先被自己的读表挡住，
 * 表永远建不出来。所以降级不是「锦上添花」，是自举能不能跑起来的前提。
 */
export async function readFoundSchema(db: D1Database): Promise<FoundSchema & { tier: ProbeTier }> {
  // 上次能用的层级先试；连它也失败说明环境变了，重置后走整条链
  if (workingTier !== undefined) {
    try {
      return await runTier(workingTier, db)
    } catch {
      workingTier = undefined
    }
  }

  let lastError: unknown
  for (const tier of TIERS) {
    try {
      const found = await runTier(tier, db)
      workingTier = tier
      return found
    } catch (error) {
      lastError = error
    }
  }
  // 三级全挂 = 连 sqlite_master 都读不到，这是真故障，保留原始原因上抛。
  // 降级本身不打日志：那属于预期路径，每次 healthz 都会走
  throw new Error(`schema probe failed: ${rawErrorText(lastError)}`)
}

const TIERS = ['join', 'per_table', 'master_only'] as const

const runTier = async (tier: ProbeTier, db: D1Database): Promise<FoundSchema & { tier: ProbeTier }> => {
  if (tier === 'join') return { ...(await tierJoin(db)), tier }
  if (tier === 'per_table') return { ...(await tierPerTable(db)), tier }
  return { ...(await tierMasterOnly(db)), tier }
}

async function readMaster(db: D1Database): Promise<{ tables: Set<string>; indexes: Set<string> }> {
  const rows = await db
    .prepare(`SELECT name, type FROM sqlite_master WHERE type IN ('table','index')`)
    .all<{ name: string; type: string }>()
  const tables = new Set<string>()
  const indexes = new Set<string>()
  for (const row of rows.results ?? []) {
    if (row.type === 'index') {
      // sqlite_autoindex_* 是 WITHOUT ROWID 主键的内部索引，不参与校验
      if (!row.name.startsWith('sqlite_autoindex_')) indexes.add(row.name)
      continue
    }
    tables.add(row.name)
  }
  return { tables, indexes }
}

async function tierJoin(db: D1Database): Promise<FoundSchema> {
  const rows = await db
    .prepare(
      `SELECT m.name AS name, m.type AS type, p.name AS col
       FROM sqlite_master m
       LEFT JOIN pragma_table_info(m.name) p
       WHERE m.type IN ('table', 'index')`,
    )
    .all<{ name: string; type: string; col: string | null }>()
  const { tables, indexes } = await readMaster(db)
  const columns = new Map<string, Set<string>>()
  for (const row of rows.results ?? []) {
    if (row.type !== 'table' || typeof row.col !== 'string') continue
    const set = columns.get(row.name) ?? new Set<string>()
    set.add(row.col)
    columns.set(row.name, set)
  }
  return { tables, columns, indexes }
}

/**
 * 拼进 SQL 的表名白名单。来源是 REQUIRED_TABLES 硬编码常量，
 * 再过一道是为了让「以后有人把它变成动态值」时直接炸，而不是静默注入。
 */
const SQL_LITERAL = /^[A-Za-z_][A-Za-z0-9_]*$/

async function tierPerTable(db: D1Database): Promise<FoundSchema> {
  const { tables, indexes } = await readMaster(db)
  const columns = new Map<string, Set<string>>()
  let checked = true
  for (const table of REQUIRED_TABLES) {
    if (!tables.has(table)) continue
    if (!SQL_LITERAL.test(table)) {
      checked = false
      continue
    }
    // 必须字面量：? 绑定同样是 TVF，一样过不了 authorizer
    const rows = await db
      .prepare(`SELECT name FROM pragma_table_info('${table}')`)
      .all<{ name: string }>()
    const names = (rows.results ?? [])
      .map((row) => row.name)
      .filter((name): name is string => typeof name === 'string')
    // 表在但查出 0 行 = 查不到，不等于「这张表一列都没有」
    if (names.length === 0) {
      checked = false
      continue
    }
    columns.set(table, new Set(names))
  }
  return { tables, columns, indexes, columnsUnknown: !checked }
}

async function tierMasterOnly(db: D1Database): Promise<FoundSchema> {
  const { tables, indexes } = await readMaster(db)
  return { tables, columns: new Map(), indexes, columnsUnknown: true }
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
  } catch (error) {
    // 不再把 SQLITE_AUTH 压成 "D1 unavailable"：原始文本才是排障线索。
    // 压掉之后线上只剩一句废话，定位要多绕一圈
    throw new Error(`schema probe failed: ${rawErrorText(error)}`)
  }

  const structurallyComplete = diff.missingTables.length === 0 && diff.missingIndexes.length === 0

  // 只缺列时补不了：CREATE TABLE IF NOT EXISTS 对已存在的表是空操作，
  // 而 ALTER TABLE ADD COLUMN 是非幂等的。这类状态只能靠真的迁移文件，
  // 所以自举不上手，交给 healthz 报出来（指路 db:migrate）。
  const onlyColumnsMissing =
    structurallyComplete && Object.keys(diff.missingColumns).length > 0

  if (schemaOk(diff)) {
    verifiedInIsolate = true
    return { applied: [], skipped: true, refused: [] }
  }

  const applied: string[] = []
  const refused = unlistedMigrations()

  if (!diff.columnsChecked) {
    // 列查不到：既没法证明完整，也没法靠 DDL 修（它对已存在的表是空操作）
    refused.push('(column verification unavailable)')
    // 结构上没缺就别跑 DDL——纯空操作，白白多一个 batch。
    // 注意这里 return 之前没有置 verifiedInIsolate：
    // 没验证过就不能记账，否则下一个请求直接 skipped 装样子
    if (structurallyComplete) return { applied, skipped: true, refused }
    // 确实缺表/缺索引则继续往下补，幂等 DDL 无论如何都安全
  }
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
  } catch (error) {
    throw new Error(`schema probe failed: ${rawErrorText(error)}`)
  }
  // columnsChecked 为 false 时 schemaOk 必为 false，所以列不可用就绝不会
  // 误置记忆——宁可每请求多查一次，也不能把「没验证过」记成「验证过」
  verifiedInIsolate = schemaOk(after)

  if (verifiedInIsolate) return { applied, skipped: false, refused }

  // 补不上的部分。两种原因要分开说，不能都推给「缺列」：
  //   columns_checked=false → 列压根没查过，说「缺列」是编的
  //   columns_checked=true  且真缺列 → 只有非幂等迁移能改
  const columnsUnknown = !after.columnsChecked
  const columnsActuallyMissing = after.columnsChecked && Object.keys(after.missingColumns).length > 0
  return {
    applied,
    skipped: false,
    refused: columnsActuallyMissing
      ? [...refused, '(missing columns require a real migration)']
      : refused,
    error: `schema still incomplete: missing_tables=${JSON.stringify(after.missingTables)}` +
      ` missing_columns=${JSON.stringify(after.missingColumns)}` +
      ` missing_indexes=${JSON.stringify(after.missingIndexes)}` +
      ` columns_checked=${after.columnsChecked}`,
    // 列没验证过就不算「结构有问题」，只是一部分信息拿不到
    ...(columnsUnknown && !columnsActuallyMissing ? { columnsUnverified: true } : {}),
  }
}
