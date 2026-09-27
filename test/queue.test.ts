/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { env as cloudflareEnv } from 'cloudflare:workers'
import { createExecutionContext, createMessageBatch, getQueueResult } from 'cloudflare:test'
import { http, HttpResponse } from 'msw'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { cacheRowCount, lookup, resetRowCountCache } from '../src/core/cache'
import {
  consumeCredits,
  consumeQueueSlot,
  queueBudget,
  readCredits,
  resetCredits,
} from '../src/core/credits'
import { handleMessage, handleQueueBatch, parseMessage, type QueueStats } from '../src/core/queue'
import { cacheKeyFor } from '../src/core/refresh'
import { clearSettingsMemo, putSettings } from '../src/core/settings'
import { decodeTarget, encodeTarget } from '../src/core/target'
import { network } from './server'

const env = cloudflareEnv as unknown as Env
const QUEUE = 'uapis-refresh'

type BatchBody = Parameters<typeof createMessageBatch>[1][number]

function msg(body: unknown, attempts = 1): BatchBody {
  return { id: crypto.randomUUID(), timestamp: new Date(), attempts, body } as BatchBody
}

function stats(): QueueStats {
  return { processed: 0, refreshed: 0, retried: 0, dropped: 0 }
}

function itemBody(id: string): { v: 1; k: string; p: string; t: string } {
  const target = { op: 'item', id, query: [] as [string, string][] }
  return { v: 1, k: cacheKeyFor('hackernews', 'item', target), p: 'hackernews', t: encodeTarget(target) }
}

beforeAll(() => {
  network.enable()
})

afterAll(() => {
  network.disable()
})

beforeEach(async () => {
  resetRowCountCache()
  await env.DB.prepare('DELETE FROM cache').run()
  await env.DB.prepare('DELETE FROM settings').run()
  await env.DB.prepare('DELETE FROM quota').run()
  await env.DB.prepare('DELETE FROM gate').run()
  clearSettingsMemo()
  await putSettings(env, { 'gate.min_ms': '0', 'cache.t1': 'off' })
  clearSettingsMemo()
  network.use(
    http.get('https://hn.algolia.com/api/v1/items/:id', ({ params }) =>
      HttpResponse.json({ id: Number(params.id), title: 'from queue' }),
    ),
  )
})

afterEach(() => {
  network.resetHandlers()
})

describe('消息编解码', () => {
  it('target 描述符往返（含特殊字符 id）', () => {
    const target = { op: 'user', id: 'Some User/中文', query: [['page', '2']] as [string, string][] }
    expect(decodeTarget(encodeTarget(target))).toEqual(target)
  })

  it('parseMessage 拒绝非法消息，接受合法消息', () => {
    expect(parseMessage('garbage')).toBeNull()
    expect(parseMessage({ nope: true })).toBeNull()
    expect(parseMessage(itemBody('1'))).toEqual(itemBody('1'))
  })
})

describe('额度', () => {
  it('consumeQueueSlot 在日上限处拒绝', async () => {
    await putSettings(env, { 'queue.daily_limit': '3' })
    clearSettingsMemo()
    expect(await consumeQueueSlot(env)).toBe(true)
    expect(await consumeQueueSlot(env)).toBe(true)
    expect(await consumeQueueSlot(env)).toBe(true)
    expect(await consumeQueueSlot(env)).toBe(false)

    expect(await queueBudget(env, 2)).toMatchObject({ used: 3, limit: 3, exhausted: true, throttled: true })
  })

  it('resetCredits 把当天计数清零', async () => {
    await consumeQueueSlot(env, 5)
    await resetCredits(env, '__queue__', '__system__')
    expect((await queueBudget(env, 100)).used).toBe(0)
  })

  it('readCredits 返回 seed 的默认限额，并按 channel 覆盖', async () => {
    const seeded = await readCredits(env, 'hackernews', 'default')
    expect(seeded.limit).toBeGreaterThan(0)

    await putSettings(env, { 'quota.hackernews.default': '2' })
    clearSettingsMemo()
    expect(await consumeCredits(env, 'hackernews', 'default')).toBe(true)
    expect(await consumeCredits(env, 'hackernews', 'default')).toBe(true)
    expect(await consumeCredits(env, 'hackernews', 'default')).toBe(false)
    expect(await readCredits(env, 'hackernews', 'default')).toMatchObject({ used: 2, remaining: 0 })
  })
})

describe('队列消费', () => {
  it('正常消息回源后落库并被显式 ack', async () => {
    const batch = createMessageBatch(QUEUE, [msg(itemBody('1'))])
    const ctx = createExecutionContext()
    const result = await handleQueueBatch(batch, env)
    const outcome = await getQueueResult(batch, ctx)

    expect(result).toEqual({ processed: 1, refreshed: 1, retried: 0, dropped: 0 })
    expect(outcome.outcome).toBe('ok')
    expect(outcome.explicitAcks).toHaveLength(1)
    expect(outcome.retryMessages).toHaveLength(0)

    const found = await lookup(env, itemBody('1').k)
    expect(found?.text).toContain('from queue')
  })

  it('未知 provider 的消息被丢弃而不是重试', async () => {
    const batch = createMessageBatch(QUEUE, [msg({ v: 1, k: 'v1:ghost:item:1:q', p: 'ghost', t: 'item:1' })])
    const ctx = createExecutionContext()
    const result = await handleQueueBatch(batch, env)
    const outcome = await getQueueResult(batch, ctx)

    expect(result).toEqual({ processed: 0, refreshed: 0, retried: 0, dropped: 1 })
    expect(outcome.retryMessages).toHaveLength(0)
  })

  it('body 非法时直接丢弃', async () => {
    const batch = createMessageBatch(QUEUE, [msg('garbage')])
    const queueStats = stats()
    await handleMessage(batch.messages[0]!, env, queueStats)
    expect(queueStats.dropped).toBe(1)
  })

  it('provider 闸门冷却时改为 retry，并带退避延迟', async () => {
    await putSettings(env, { 'gate.min_ms': '60000' })
    clearSettingsMemo()

    const first = createMessageBatch(QUEUE, [msg(itemBody('7'))])
    const firstCtx = createExecutionContext()
    await handleQueueBatch(first, env)
    expect((await getQueueResult(first, firstCtx)).explicitAcks).toHaveLength(1)

    // 闸门已被首条消息推进到 60s 之后，第二条只能 retry
    const second = createMessageBatch(QUEUE, [msg(itemBody('8'))])
    const secondCtx = createExecutionContext()
    const stats2 = stats()
    await handleMessage(second.messages[0]!, env, stats2)
    const outcome = await getQueueResult(second, secondCtx)

    expect(stats2).toEqual({ processed: 1, refreshed: 0, retried: 1, dropped: 0 })
    expect(outcome.retryMessages).toHaveLength(1)
  })

  it('批量两条消息各落一行', async () => {
    const batch = createMessageBatch(QUEUE, [msg(itemBody('1')), msg(itemBody('2'))])
    const ctx = createExecutionContext()
    expect(await handleQueueBatch(batch, env)).toEqual({
      processed: 2,
      refreshed: 2,
      retried: 0,
      dropped: 0,
    })
    expect(await cacheRowCount(env)).toBe(2)
    expect((await getQueueResult(batch, ctx)).explicitAcks).toHaveLength(2)
  })
})
