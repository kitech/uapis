/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { env as cloudflareEnv } from 'cloudflare:workers'
import { createExecutionContext, createMessageBatch, getQueueResult } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import { handleMessage, handleQueueBatch, PROBE_PROVIDER, type QueueStats } from '../src/core/queue'
import { readGate } from '../src/core/gate'

const env = cloudflareEnv as unknown as Env
const QUEUE = 'uapis-refresh'

type BatchBody = Parameters<typeof createMessageBatch>[1][number]

/** 与 health.ts 里的 body 形状保持一致：t 里带本轮时间戳 */
const probeBody = (sentAt: number) =>
  ({ v: 1 as const, k: PROBE_PROVIDER, p: PROBE_PROVIDER, t: `probe:${sentAt}` }) as unknown

function stats(): QueueStats {
  return { processed: 0, refreshed: 0, retried: 0, dropped: 0 }
}

const msg = (body: unknown): BatchBody =>
  ({ id: crypto.randomUUID(), timestamp: new Date(), attempts: 1, body }) as BatchBody

const sentinel = () =>
  env.DB.prepare('SELECT next_at FROM gate WHERE provider = ?')
    .bind(PROBE_PROVIDER)
    .first<{ next_at: number }>()

/** 模拟 healthz 发出本轮探针：正数 next_at = 已发待 ack */
const markSent = (sentAt: number) =>
  env.DB.prepare(
    `INSERT INTO gate (provider, next_at, fails) VALUES (?, ?, 0)
     ON CONFLICT(provider) DO UPDATE SET next_at = excluded.next_at`,
  ).bind(PROBE_PROVIDER, sentAt).run()

describe('healthz 队列探针的消费端', () => {
  it('ack 时把 next_at 翻成负数，healthz 据此判定 consumer 存活', async () => {
    const sentAt = Date.now()
    await markSent(sentAt)
    expect((await sentinel())?.next_at).toBe(sentAt)

    const batch = createMessageBatch(QUEUE, [msg(probeBody(sentAt))])
    const ctx = createExecutionContext()
    await handleQueueBatch(batch, env)
    const outcome = await getQueueResult(batch, ctx)

    expect(outcome.explicitAcks).toHaveLength(1)
    expect(outcome.retryMessages).toHaveLength(0)
    // 负值 = 消费端确认了本轮
    expect((await sentinel())?.next_at).toBe(-sentAt)
  })

  it('CAS：更新的一轮已经发出时，不覆盖新标记', async () => {
    const first = Date.now() - 1000
    const second = Date.now()
    await markSent(second)

    // 迟到的第一轮消息到达
    const batch = createMessageBatch(QUEUE, [msg(probeBody(first))])
    const ctx = createExecutionContext()
    await handleQueueBatch(batch, env)
    await getQueueResult(batch, ctx)

    // 不能把第二轮的「已发待 ack」盖成「已 ack」，否则会误报 consumer 存活
    expect((await sentinel())?.next_at).toBe(second)
  })

  it('不污染队列统计（dropped 虚增会淹没真实丢弃数）', async () => {
    // index.ts 会把 dropped 累加进 __queue_dropped。探针每 30s 一条，
    // 一天就是 2880 次虚增
    const sentAt = Date.now()
    await markSent(sentAt)
    const batch = createMessageBatch(QUEUE, [msg(probeBody(sentAt))])
    const counters = stats()
    await handleMessage(batch.messages[0]!, env, counters)
    expect(counters).toEqual({ processed: 0, refreshed: 0, retried: 0, dropped: 0 })
  })

  it('时间戳坏掉时按坏消息处理，不把哨兵行留在「已发未 ack」', async () => {
    const sentAt = Date.now()
    await markSent(sentAt)
    const batch = createMessageBatch(QUEUE, [msg({ v: 1, k: PROBE_PROVIDER, p: PROBE_PROVIDER, t: 'probe' })])
    const ctx = createExecutionContext()
    await handleQueueBatch(batch, env)
    const outcome = await getQueueResult(batch, ctx)

    expect(outcome.explicitAcks).toHaveLength(1)
    // 标记保持「待 ack」而不是被翻负
    expect((await sentinel())?.next_at).toBe(sentAt)
  })

  it('回写失败时 retry 而不是 ack，否则下一轮会误报 consumer 没工作', async () => {
    const sentAt = Date.now()
    await markSent(sentAt)

    // 用一个 DB 绑定替身让 UPDATE 抛错
    const brokenDb = {
      prepare: (sql: string) => {
        const stmt = env.DB.prepare(sql)
        return {
          bind: (...values: unknown[]) => ({
            run: () => {
              if (sql.startsWith('UPDATE')) throw new Error('simulated D1 failure')
              return stmt.bind(...(values as never[])).run()
            },
          }),
        }
      },
    }

    const batch = createMessageBatch(QUEUE, [msg(probeBody(sentAt))])
    const ctx = createExecutionContext()
    await handleQueueBatch(batch, { ...env, DB: brokenDb } as unknown as Env)
    const outcome = await getQueueResult(batch, ctx)

    expect(outcome.retryMessages).toHaveLength(1)
    expect(outcome.explicitAcks).toHaveLength(0)
  })

  it('readGate 会带出哨兵行，所以 /status 的过滤是必需的', async () => {
    // 钉住「readGate 不过滤」这个前提：免得后人以为 gate.ts 已处理过，
    // 把 meta.ts 里的过滤删掉，线上 /status 就多出一条假闸门
    await markSent(Date.now())
    const rows = await readGate(env)
    expect(rows.map((row) => row.provider)).toContain(PROBE_PROVIDER)
  })
})
