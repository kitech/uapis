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

export type FoundSchema = {
  tables: ReadonlySet<string>
  columns: ReadonlyMap<string, ReadonlySet<string>>
  indexes: ReadonlySet<string>
}

export type SchemaDiff = {
  missingTables: string[]
  missingColumns: Record<string, string[]>
  missingIndexes: string[]
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

  return { missingTables, missingColumns, missingIndexes }
}

export function schemaOk(diff: SchemaDiff): boolean {
  return (
    diff.missingTables.length === 0 &&
    Object.keys(diff.missingColumns).length === 0 &&
    diff.missingIndexes.length === 0
  )
}

export const emptyDiff = (): SchemaDiff => ({
  missingTables: [],
  missingColumns: {},
  missingIndexes: [],
})
