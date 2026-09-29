import { readFileSync, readdirSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { INIT_DDL, splitStatements } from '../src/core/schema-ddl'
import {
  REQUIRED_COLUMNS,
  REQUIRED_INDEXES,
  REQUIRED_TABLES,
  EXPECTED_MIGRATIONS,
  diffSchema,
  schemaOk,
  type FoundSchema,
} from '../src/core/schema-contract'

const SQL = readFileSync('migrations/0001_init.sql', 'utf8')

/** 归一化：剥整行注释、压空白、只留标识符与关键字序列 */
const normalize = (sql: string): string =>
  splitStatements(sql)
    .map((statement) => statement.replace(/\s+/g, ' ').trim())
    .join(';')

const full = (): FoundSchema => ({
  tables: new Set([...REQUIRED_TABLES, 'd1_migrations', 'sqlite_sequence']),
  columns: new Map(Object.entries(REQUIRED_COLUMNS).map(([t, c]) => [t, new Set(c)])),
  indexes: new Set(REQUIRED_INDEXES),
})

describe('内联 DDL 与 migrations/0001_init.sql 不漂移', () => {
  // 这是用 TS 常量代替 `import .sql` 的代价，必须有测试兜住：
  // 改了 .sql 忘了改 INIT_DDL，运行期自举会建出旧版 schema。
  it('语句逐条相等', () => {
    expect(normalize(INIT_DDL)).toBe(normalize(SQL))
  })

  it('切分器不会把字符串字面量里的分号或 -- 误当边界', () => {
    // splitStatements 靠分号切分 + 剥整行注释，这是它的已知局限。
    // DDL 一旦引入分号字面量（CHECK 约束等），这个测试先红，
    // 提醒改用真正的 SQL 词法切分，而不是到线上建表失败才发现。
    expect(SQL).not.toMatch(/'[^']*;[^']*'/)
    expect(SQL).not.toMatch(/'[^']*--[^']*'/)
  })
})

describe('schema 契约与 0001_init.sql 一致', () => {
  it('每张表的每一列都在迁移文件里声明', () => {
    for (const [table, columns] of Object.entries(REQUIRED_COLUMNS)) {
      const block = SQL.match(
        new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\s*\\(([\\s\\S]*?)\\n\\)`, 'i'),
      )
      expect(block, `${table} 在 0001_init.sql 里没有对应的 CREATE TABLE`).not.toBeNull()
      for (const column of columns) {
        expect(block![1], `${table}.${column} 不在迁移文件里`).toMatch(
          new RegExp(`\\b${column}\\b`),
        )
      }
    }
  })

  it('索引齐全', () => {
    for (const index of REQUIRED_INDEXES) {
      expect(SQL).toMatch(new RegExp(`CREATE INDEX IF NOT EXISTS ${index}\\b`))
    }
  })

  it('迁移清单与 EXPECTED_MIGRATIONS 一致（migrations_pattern 排除 seed.sql）', () => {
    const files = readdirSync('migrations')
      .filter((file) => /^\d.*\.sql$/.test(file))
      .sort()
    expect(files).toEqual([...EXPECTED_MIGRATIONS])
  })
})

describe('diffSchema', () => {
  it('全齐时无缺失', () => {
    expect(diffSchema(full())).toEqual({
      missingTables: [],
      missingColumns: {},
      missingIndexes: [],
      columnsChecked: true,
    })
    expect(schemaOk(diffSchema(full()))).toBe(true)
  })

  it('缺表', () => {
    const found = full()
    found.tables.delete('quota')
    found.columns.delete('quota')
    expect(diffSchema(found).missingTables).toEqual(['quota'])
  })

  it('表在但缺列（半截迁移，或 0001_init.sql 被改过后重跑）', () => {
    const found = full()
    found.columns.set('cache', new Set(REQUIRED_COLUMNS.cache.filter((c) => c !== 'stale_until')))
    expect(diffSchema(found).missingColumns).toEqual({ cache: ['stale_until'] })
    expect(schemaOk(diffSchema(found))).toBe(false)
  })

  it('缺索引（cache 是写入热点表，expires_at 索引缺失会让 prune 退化成全表扫）', () => {
    const found = full()
    found.indexes.delete('idx_cache_expires')
    expect(diffSchema(found).missingIndexes).toEqual(['idx_cache_expires'])
  })

  it('表整个缺失时不重复报列', () => {
    const found = full()
    found.tables.delete('gate')
    expect(diffSchema(found)).toEqual({
      missingTables: ['gate'],
      missingColumns: {},
      missingIndexes: [],
      columnsChecked: true,
    })
  })

  it('sqlite_autoindex_* 这类内部索引不算缺失', () => {
    const found = full()
    found.indexes.add('sqlite_autoindex_cache_1')
    expect(diffSchema(found).missingIndexes).toEqual([])
  })

  it('列查不到时 missingColumns 是空对象但不算健康', () => {
    // 线上事故的根因形态：columnsUnknown 时 missingColumns 就是个空对象，
    // 在 JSON 里和「真的没缺列」完全一样。靠 columnsChecked 才分得开。
    // 只看 missingColumns 的看板会把「没查过」显示成「没缺」
    const found = full()
    found.columns = new Map()
    found.columnsUnknown = true
    const diff = diffSchema(found)
    expect(diff.missingTables).toEqual([])
    expect(diff.missingColumns).toEqual({})
    expect(diff.columnsChecked).toBe(false)
    expect(schemaOk(diff)).toBe(false)
  })

  it('列未知但确实缺表时，照常报出缺表', () => {
    const found = full()
    found.tables.delete('quota')
    found.columnsUnknown = true
    const diff = diffSchema(found)
    expect(diff.missingTables).toEqual(['quota'])
    expect(diff.columnsChecked).toBe(false)
  })
})
