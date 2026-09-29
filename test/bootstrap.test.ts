/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { env as cloudflareEnv } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import { ensureSchema, resetSchemaCheck } from '../src/core/bootstrap'
import { REQUIRED_TABLES, REQUIRED_INDEXES } from '../src/core/schema-contract'

const env = cloudflareEnv as unknown as Env

const TABLES = [...REQUIRED_TABLES, 'd1_migrations']

/** 模拟「wrangler deploy 自动建了库，但迁移没跑」的生产初始状态 */
async function dropEverything(): Promise<void> {
  for (const table of TABLES) {
    await env.DB.prepare(`DROP TABLE IF EXISTS ${table}`).run()
  }
  // 手动删表不会被 isolate 内的记忆发现，必须显式清掉
  resetSchemaCheck()
}

const countTable = (name: string) =>
  env.DB.prepare(
    `SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = ?`,
  ).bind(name).first<{ n: number }>()

describe('ensureSchema', () => {
  it('表齐全时跳过，不做任何写入', async () => {
    const result = await ensureSchema(env)
    expect(result.skipped).toBe(true)
    expect(result.applied).toEqual([])
    expect(result.refused).toEqual([])
    expect(result.error).toBeUndefined()
  })

  it('d1_migrations 记着 0001_init.sql，bootstrap 与 wrangler 互相认账', async () => {
    // 决定 1 的关键：自举写进 d1_migrations 的 name 格式必须和 wrangler 一致，
    // 否则之后跑 `npm run db:migrate` 会认为没跑过而重复执行
    const row = await env.DB.prepare('SELECT name FROM d1_migrations WHERE name = ?')
      .bind('0001_init.sql')
      .first<{ name: string }>()
    expect(row?.name).toBe('0001_init.sql')
  })

  it('全新空库能被装出完整 schema（生产首次部署路径）', async () => {
    await dropEverything()
    expect((await countTable('cache'))?.n ?? 0).toBe(0)

    const result = await ensureSchema(env)
    expect(result.error).toBeUndefined()
    expect(result.applied).toEqual(['0001_init.sql'])

    for (const table of REQUIRED_TABLES) {
      expect((await countTable(table))?.n ?? 0, `${table} 没被建出来`).toBe(1)
    }
    const index = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'index' AND name = ?`,
    ).bind(REQUIRED_INDEXES[0]).first<{ n: number }>()
    expect(index?.n ?? 0).toBe(1)

    // 记账必须和建表在同一批里成功，否则下次会重复执行
    const recorded = await env.DB.prepare('SELECT name FROM d1_migrations')
      .all<{ name: string }>()
    expect((recorded.results ?? []).map((row) => row.name)).toContain('0001_init.sql')
  })

  it('重复调用幂等：第二次直接 skipped', async () => {
    await dropEverything()
    await ensureSchema(env)
    const again = await ensureSchema(env)
    expect(again.applied).toEqual([])
    expect(again.skipped).toBe(true)
  })

  it('isolate 记忆：确认过一次之后不再查 D1', async () => {
    // 稳态下中间件每请求省一次查询。一天 10 万请求 = 10 万次 D1 查询
    await dropEverything()
    await ensureSchema(env)

    let queried = 0
    const countingDb = {
      prepare: (sql: string) => {
        if (sql.includes('sqlite_master')) queried += 1
        return env.DB.prepare(sql)
      },
    } as unknown as D1Database

    const result = await ensureSchema({ ...env, DB: countingDb } as unknown as Env)
    expect(queried).toBe(0)
    expect(result.skipped).toBe(true)
  })

  it('只缺一张表时能补上（半截 schema 也要能自愈）', async () => {
    // 快路径做的是完整契约比对，不是「cache 表在不在」——
    // 否则只缺 quota 时会被判成完好，永远补不上
    await dropEverything()
    await ensureSchema(env)
    await env.DB.prepare('DROP TABLE quota').run()
    resetSchemaCheck()

    const result = await ensureSchema(env)
    expect(result.error).toBeUndefined()
    expect((await countTable('quota'))?.n ?? 0).toBe(1)
  })

  it('缺索引时能补上', async () => {
    await dropEverything()
    await ensureSchema(env)
    await env.DB.prepare('DROP INDEX idx_cache_expires').run()
    resetSchemaCheck()

    const result = await ensureSchema(env)
    expect(result.error).toBeUndefined()
    const index = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'index' AND name = ?`,
    ).bind(REQUIRED_INDEXES[0]).first<{ n: number }>()
    expect(index?.n ?? 0).toBe(1)
  })

  it('只缺列时不硬补，指路真的迁移（DDL 修不了已存在的表）', async () => {
    // CREATE TABLE IF NOT EXISTS 对已存在的表是空操作，硬跑只会白费一次 batch。
    // 正确结论是「需要非幂等迁移」，那只能走 npm run db:migrate
    await dropEverything()
    await ensureSchema(env)
    await env.DB.prepare('ALTER TABLE gate DROP COLUMN fails').run()
    resetSchemaCheck()

    const result = await ensureSchema(env)
    expect(result.applied).toEqual([])
    expect(result.refused).toContain('(missing columns require a real migration)')
    expect(result.error).toContain('fails')
  })

  it('自举出的 schema 能立刻读写业务数据', async () => {
    // 真正要保证的是「部署完马上能用」，而不是「建出同名空表」
    await dropEverything()
    await ensureSchema(env)
    await env.DB.prepare(
      'INSERT INTO gate (provider, next_at, fails) VALUES (?, ?, 0)',
    ).bind('probe', 123).run()
    const row = await env.DB.prepare('SELECT next_at FROM gate WHERE provider = ?')
      .bind('probe')
      .first<{ next_at: number }>()
    expect(row?.next_at).toBe(123)
  })
})
