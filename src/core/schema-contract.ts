/**
 * D1 schema 契约：从 migrations/0001_init.sql 逐列反推。
 *
 * 为什么不能只查表名：0001_init.sql 全部用 CREATE TABLE IF NOT EXISTS，
 * 改过已应用的迁移再重跑，wrangler 认为「无待应用迁移」，表名齐全但列对不上。
 * 只探表名的健康检查会把这种半截 schema 报成健康。
 */
export const REQUIRED_COLUMNS: Record<string, readonly string[]> = {
  cache: [
    'k',
    'body',
    'encoding',
    'status',
    'content_type',
    'provider',
    'resource',
    'fetched_at',
    'expires_at',
    'stale_until',
    'size',
  ],
  settings: ['k', 'v', 'updated_at'],
  quota: ['day', 'provider', 'channel', 'used'],
  stats: ['day', 'path', 'n'],
  gate: ['provider', 'next_at', 'fails'],
}

/** cache 是写入热点表，expires_at 索引缺失会让 cron 清理退化成全表扫 */
export const REQUIRED_INDEXES = ['idx_cache_expires'] as const

/** 与 migrations/0001_init.sql 对应；d1_migrations.name 存相对 migrations_dir 的路径 */
export const EXPECTED_MIGRATIONS = ['0001_init.sql'] as const

export const REQUIRED_TABLES = Object.keys(REQUIRED_COLUMNS)

/**
 * 实际生效的结构探测层级，进 healthz 报告。
 * 生产上唯一一次踩坑就是 D1 不放行哪条 SQL，字段暴露出来就不用再猜。
 */
export type ProbeTier = 'join' | 'per_table' | 'master_only'

export type FoundSchema = {
  tables: ReadonlySet<string>
  columns: ReadonlyMap<string, ReadonlySet<string>>
  indexes: ReadonlySet<string>
  /**
   * true = 拿不到列信息，只有表和索引可信。
   * 做成 optional 是为了不打散测试和调用方的构造——缺省语义就是「没标记未知」。
   */
  columnsUnknown?: boolean
}

export type SchemaDiff = {
  missingTables: string[]
  missingColumns: Record<string, string[]>
  missingIndexes: string[]
  /**
   * false = missingColumns 不可信。
   *
   * 关键：列查不到时 missingColumns 会是个空对象，而空对象在 JSON 里
   * 和「真的没缺列」长得一模一样。线上就是踩在这里——schema 报 ok:false，
   * diff 却是空的，任何按 missingTables.length === 0 判绿的看板都会
   * 把空库显示成正常。所以「未知」必须单开一个字段表达。
   */
  columnsChecked: boolean
}

/** 纯函数，不碰 D1：契约测试和运行期探针共用 */
export function diffSchema(found: FoundSchema): SchemaDiff {
  const missingTables = REQUIRED_TABLES.filter((table) => !found.tables.has(table))

  const missingColumns: Record<string, string[]> = {}
  for (const [table, columns] of Object.entries(REQUIRED_COLUMNS)) {
    // 表整个缺失时不在这里重复报，交给 missingTables
    if (!found.tables.has(table)) continue
    const have = found.columns.get(table) ?? new Set<string>()
    const absent = columns.filter((column) => !have.has(column))
    if (absent.length > 0) missingColumns[table] = absent
  }

  const missingIndexes = REQUIRED_INDEXES.filter((index) => !found.indexes.has(index))

  return {
    missingTables,
    missingColumns,
    missingIndexes,
    columnsChecked: found.columnsUnknown !== true,
  }
}

export function schemaOk(diff: SchemaDiff): boolean {
  return (
    // 没法验证就等于没法证明完整。宁可每个请求多查一次，
    // 也不能在没看过列的情况下把「应该没问题」当成「没问题」
    diff.columnsChecked &&
    diff.missingTables.length === 0 &&
    Object.keys(diff.missingColumns).length === 0 &&
    diff.missingIndexes.length === 0
  )
}
