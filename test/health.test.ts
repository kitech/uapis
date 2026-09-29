/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { env as cloudflareEnv } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import { runHealthChecks } from '../src/core/health'
import { ensureSchema, resetSchemaCheck } from '../src/core/bootstrap'
import { PROBE_PROVIDER, WRITE_PROBE_KEY } from '../src/core/queue'
import { REQUIRED_TABLES, REQUIRED_COLUMNS } from '../src/core/schema-contract'

const env = cloudflareEnv as unknown as Env

const dropEverything = async (): Promise<void> => {
  for (const table of [...REQUIRED_TABLES, 'd1_migrations']) {
    await env.DB.prepare(`DROP TABLE IF EXISTS ${table}`).run()
  }
  resetSchemaCheck()
}

describe('runHealthChecks', () => {
  it('schema 齐全时五段全过，status=ok', async () => {
    const report = await runHealthChecks(env)
    expect(report.status).toBe('ok')
    expect(report.d1).toBe(true)
    expect(report.schema).toBe(true)
    expect(report.warnings).toEqual([])
    expect(report.checks.connect.ok).toBe(true)
    expect(report.checks.schema.ok).toBe(true)
    expect(report.checks.schema.diff).toEqual({
      missingTables: [],
      missingColumns: {},
      missingIndexes: [],
    })
    expect(report.checks.migrations.pending).toEqual([])
    expect(report.checks.write.ok).toBe(true)
    // 队列探针只发不收，acked 首轮必为 null（没有「上一轮」可比）
    expect(report.checks.queue.ok).toBe(true)
    expect(report.checks.queue.sent).toBe(true)
    expect(report.checks.queue.acked).toBeNull()
  })

  it('consumer 回写负值后，下一轮报 acked: true', async () => {
    // 完整往返：healthz 发 → 模拟 consumer 翻负 → 再 healthz
    await runHealthChecks(env)
    const sentAt = Date.now()
    // 模拟消费端 CAS 回写
    await env.DB.prepare('UPDATE gate SET next_at = ? WHERE provider = ?')
      .bind(-sentAt, PROBE_PROVIDER)
      .run()

    const report = await runHealthChecks(env)
    expect(report.checks.queue.ok).toBe(true)
    expect(report.checks.queue.acked).toBe(true)
    expect(report.warnings).toEqual([])
  })

  it('发出后没人 ack 时报 acked: false 并进 warnings', async () => {
    // consumer 停摆的真实表现：哨兵行一直是正数
    await env.DB.prepare(
      `INSERT INTO gate (provider, next_at, fails) VALUES (?, ?, 0)
       ON CONFLICT(provider) DO UPDATE SET next_at = excluded.next_at`,
    ).bind(PROBE_PROVIDER, Date.now()).run()

    const report = await runHealthChecks(env)
    expect(report.checks.queue.acked).toBe(false)
    expect(report.warnings).toContain('queue-consumer')
    // 关键：consumer 停摆不影响 503 判定
    expect(report.status).toBe('ok')
  })

  it('超过 10 分钟没人轮询时回落 null，不误报 consumer 死了', async () => {
    const stale = Date.now() - 11 * 60_000
    await env.DB.prepare(
      `INSERT INTO gate (provider, next_at, fails) VALUES (?, ?, 0)
       ON CONFLICT(provider) DO UPDATE SET next_at = excluded.next_at`,
    ).bind(PROBE_PROVIDER, stale).run()

    const report = await runHealthChecks(env)
    expect(report.checks.queue.acked).toBeNull()
    expect(report.warnings).toEqual([])
  })

  it('写探针不留下额外残留键', async () => {
    await runHealthChecks(env)
    // 队列哨兵留 1 行（等 consumer ack），写探针的临时行必须已被自己删掉
    const rows = await env.DB.prepare('SELECT provider FROM gate WHERE provider LIKE ?')
      .bind('__healthz_probe%')
      .all<{ provider: string }>()
    expect((rows.results ?? []).map((row) => row.provider)).toEqual([PROBE_PROVIDER])
    const write = await env.DB.prepare('SELECT 1 AS n FROM gate WHERE provider = ?')
      .bind(WRITE_PROBE_KEY)
      .first<{ n: number }>()
    expect(write).toBeNull()
  })

  it('缺表时 schema 段报出具体缺哪张表，且 503 语义成立', async () => {
    await dropEverything()
    const report = await runHealthChecks(env)
    expect(report.status).toBe('degraded')
    expect(report.d1).toBe(true)
    expect(report.schema).toBe(false)
    expect(report.checks.schema.ok).toBe(false)
    expect(report.checks.schema.diff.missingTables).toEqual([...REQUIRED_TABLES])
    // 缺表时不能再写：write 段必须跳过而不是伪造一个 D1_ERROR
    expect(report.checks.write.skipped).toBe('schema incomplete')
    expect(report.checks.write.ok).toBe(false)
  })

  it('缺表时 migrations 段报出 pending', async () => {
    await dropEverything()
    const report = await runHealthChecks(env)
    expect(report.checks.migrations.ok).toBe(false)
    expect(report.checks.migrations.pending).toEqual(['0001_init.sql'])
  })

  it('缺表时 queue 失败不污染 503 之外的信息：仍在 warnings 里', async () => {
    await dropEverything()
    const report = await runHealthChecks(env)
    // 队列探针也要读 gate，缺表时必然失败 → 进 warnings
    expect(report.checks.queue.ok).toBe(false)
    expect(report.warnings).toContain('queue')
  })

  it('自举之后立刻恢复健康', async () => {
    await dropEverything()
    const before = await runHealthChecks(env)
    expect(before.schema).toBe(false)

    const boot = await ensureSchema(env)
    expect(boot.applied).toEqual(['0001_init.sql'])

    const after = await runHealthChecks(env)
    expect(after.status).toBe('ok')
    expect(after.schema).toBe(true)
    expect(after.checks.migrations.pending).toEqual([])
  })

  it('D1 整体不可用时只报 connect 失败，其余段标 skipped', async () => {
    const broken = {
      ...env,
      DB: {
        prepare: () => {
          throw new Error('D1 unavailable')
        },
      },
    } as unknown as Env

    const report = await runHealthChecks(broken)
    expect(report.status).toBe('degraded')
    expect(report.d1).toBe(false)
    expect(report.schema).toBe(false)
    // 关键：不能把「连不上」报成「schema 不全」
    expect(report.checks.schema.diff).toEqual({ missingTables: [], missingColumns: {}, missingIndexes: [] })
    expect(report.checks.write.skipped).toBe('connect failed')
    expect(report.checks.queue.error).toBe('skipped: connect failed')
  })

  it('probeQueue: false 时不探队列，也不报 queue 告警', async () => {
    // /status 用这个模式：那页面是给人排障打开看的，每看一次就发一条队列
    // 消息属于纯浪费
    const report = await runHealthChecks(env, { probeQueue: false })
    expect(report.status).toBe('ok')
    expect(report.checks.queue.ok).toBe(false)
    expect(report.checks.queue.sent).toBe(false)
    expect(report.checks.queue.error).toBe('skipped: queue probe disabled')
    expect(report.warnings).toEqual([])
  })

  it('缺列时报出具体列名，不只是「schema 不对」', async () => {
    // 重建一个缺 stale_until 的 cache 表：表名齐全、列不全
    await dropEverything()
    await ensureSchema(env)
    await env.DB.prepare('DROP TABLE cache').run()
    const columns = REQUIRED_COLUMNS.cache
      .filter((column) => column !== 'stale_until')
      .map((column) => `  ${column}`)
      .join(',\n')
    await env.DB.prepare(
      `CREATE TABLE cache (
${columns},
  PRIMARY KEY (k)
) WITHOUT ROWID`,
    ).run()

    const report = await runHealthChecks(env)
    expect(report.status).toBe('degraded')
    expect(report.schema).toBe(false)
    expect(report.checks.schema.diff.missingTables).toEqual([])
    expect(report.checks.schema.diff.missingColumns).toEqual({ cache: ['stale_until'] })
  })
})
