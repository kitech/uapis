import { getIntSetting } from './settings'
import { logError } from './logger'
import { rawErrorText } from './errors'

/**
 * 第三方额度记账（D1 `quota`）。逻辑上把「每天最多 N 次回源」变成硬上限，
 * 上游是付费服务时，超额直接返回 503 而不是继续烧额度。
 */
export const QUEUE_ROW = { provider: '__queue__', channel: '__system__' } as const

export interface CreditsSnapshot {
  used: number
  limit: number
  remaining: number
}

export function today(now = Date.now()): string {
  return new Date(now).toISOString().slice(0, 10)
}

async function readRow(env: Env, provider: string, channel: string): Promise<number> {
  try {
    const row = await env.DB.prepare(
      'SELECT used FROM quota WHERE day = ? AND provider = ? AND channel = ?',
    )
      .bind(today(), provider, channel)
      .first<{ used: number }>()
    return row?.used ?? 0
  } catch (error) {
    // 以前 catch 里 return 0，等于对外声称"今天一次额度都没用过"。
    // D1 故障时这个假值比报错危险得多：记账失真意味着额度上限形同虚设。
    // 记完日志原样上抛（不 new Error 包装，包装会丢 stack）。
    logError({ event: 'quota_read_failed', provider, channel, message: rawErrorText(error) })
    throw error
  }
}

async function limitFor(env: Env, provider: string, channel: string): Promise<number> {
  const specific = await getIntSetting(env, `quota.${provider}.${channel}`)
  if (specific > 0) return specific
  return getIntSetting(env, `quota.${provider}.default`)
}

export async function readCredits(
  env: Env,
  provider: string,
  channel: string,
): Promise<CreditsSnapshot> {
  const used = await readRow(env, provider, channel)
  const limit = await limitFor(env, provider, channel)
  return { used, limit, remaining: limit > 0 ? Math.max(0, limit - used) : Number.POSITIVE_INFINITY }
}

/** 用带条件的 UPSERT 保证不超额：条件不满足时不写任何行 */
export async function consumeCredits(
  env: Env,
  provider: string,
  channel: string,
  cost = 1,
): Promise<boolean> {
  const limit = await limitFor(env, provider, channel)
  if (limit <= 0) return true

  try {
    const result = await env.DB.prepare(
      `INSERT INTO quota (day, provider, channel, used) VALUES (?, ?, ?, ?)
       ON CONFLICT(day, provider, channel) DO UPDATE SET used = used + excluded.used
       WHERE used + excluded.used <= ?`,
    )
      .bind(today(), provider, channel, cost, limit)
      .run()
    return changed(result) > 0
  } catch (error) {
    // 以前 return false，于是"D1 写失败"和"额度真的用完"返回同一个结果，
    // 对外被报成 QUOTA_EXHAUSTED——原因是错的，客户端会一直等到 UTC 日切。
    logError({ event: 'quota_consume_failed', provider, channel, message: rawErrorText(error) })
    throw error
  }
}

export async function resetCredits(
  env: Env,
  provider: string,
  channel: string,
): Promise<void> {
  await env.DB.prepare('DELETE FROM quota WHERE day = ? AND provider = ? AND channel = ?')
    .bind(today(), provider, channel)
    .run()
}

export interface QueueBudget {
  used: number
  limit: number
  softLimit: number
  exhausted: boolean
  throttled: boolean
}

export async function queueBudget(env: Env, softLimit: number): Promise<QueueBudget> {
  const [used, limit] = await Promise.all([
    readRow(env, QUEUE_ROW.provider, QUEUE_ROW.channel),
    getIntSetting(env, 'queue.daily_limit'),
  ])
  return {
    used,
    limit: limit > 0 ? limit : 3000,
    softLimit,
    exhausted: used >= (limit > 0 ? limit : 3000),
    throttled: used >= softLimit,
  }
}

export async function consumeQueueSlot(env: Env, cost = 1): Promise<boolean> {
  const limit = await getIntSetting(env, 'queue.daily_limit')
  try {
    const result = await env.DB.prepare(
      `INSERT INTO quota (day, provider, channel, used) VALUES (?, ?, ?, ?)
       ON CONFLICT(day, provider, channel) DO UPDATE SET used = used + excluded.used
       WHERE used + excluded.used <= ?`,
    )
      .bind(today(), QUEUE_ROW.provider, QUEUE_ROW.channel, cost, limit > 0 ? limit : 3000)
      .run()
    return changed(result) > 0
  } catch (error) {
    // 同 consumeCredits：false 会被 queue.ts 当成 'budget'（额度用完）
    logError({ event: 'queue_slot_consume_failed', message: rawErrorText(error) })
    throw error
  }
}

export async function readAllQuota(env: Env): Promise<
  { day: string; provider: string; channel: string; used: number }[]
> {
  const result = await env.DB.prepare(
    'SELECT day, provider, channel, used FROM quota WHERE day = ? ORDER BY used DESC',
  )
    .bind(today())
    .all<{ day: string; provider: string; channel: string; used: number }>()
  return result.results ?? []
}

function changed(result: D1Result): number {
  return result.meta !== undefined && typeof result.meta.changes === 'number'
    ? result.meta.changes
    : 1
}
