import { runtimeFor } from '../providers'
import { ApiError, ErrorCode, rawErrorText } from './errors'
import { consumeQueueSlot, queueBudget } from './credits'
import { logError } from './logger'
import { refreshTarget } from './refresh'
import { getIntSetting } from './settings'
import { decodeTarget } from './target'
import { endpointByOp, providerByName } from './registry'
import type { RefreshMessage } from '../types'

/** 健康探针在 gate 表里的键前缀；/status 按前缀过滤掉所有探针行 */
export const PROBE_PREFIX = '__healthz_probe__'
/** 队列探针的哨兵行。next_at 正数 = 本轮已发待 ack，负数 = consumer 已确认 */
export const PROBE_PROVIDER = PROBE_PREFIX
/**
 * 写探针的临时行。必须和队列哨兵分开：写探针会立刻删掉自己那行，
 * 若共用同一个键，它会在队列探针读状态之前把 ack 记录抹掉，
 * acked 就永远不可能为 true。
 */
export const WRITE_PROBE_KEY = `${PROBE_PREFIX}:write`

export type EnqueueResult = 'sent' | 'budget' | 'error'

export function parseMessage(body: unknown): RefreshMessage | null {
  if (typeof body !== 'object' || body === null) return null
  const candidate = body as Partial<RefreshMessage>
  if (candidate.v !== 1) return null
  if (
    typeof candidate.k !== 'string' ||
    typeof candidate.p !== 'string' ||
    typeof candidate.t !== 'string'
  ) {
    return null
  }
  return { v: 1, k: candidate.k, p: candidate.p, t: candidate.t }
}

/** 入队前先看当日额度；超过软上限直接放弃入队（由调用方降级） */
export async function enqueueRefresh(
  env: Env,
  message: RefreshMessage,
  delaySeconds?: number,
): Promise<EnqueueResult> {
  const soft = await getIntSetting(env, 'queue.soft_limit')
  const budget = await queueBudget(env, soft > 0 ? soft : 2700)
  if (budget.throttled) return 'budget'
  if (!(await consumeQueueSlot(env, 1))) return 'budget'

  try {
    await env.REFRESH.send(
      message,
      delaySeconds !== undefined && delaySeconds > 0 ? { delaySeconds } : undefined,
    )
    return 'sent'
  } catch {
    return 'error'
  }
}

export interface QueueStats {
  processed: number
  refreshed: number
  retried: number
  dropped: number
}

/** 单条消费：batch_size=1，一条消息一个 key，天然互不冲突 */
export async function handleMessage(
  message: Message<unknown>,
  env: Env,
  stats: QueueStats,
): Promise<void> {
  // 探针消息最先短路。把哨兵行的 next_at 翻成负数 = 「这一轮已 ack」，
  // 下一轮 healthz 读到负值就知道 consumer 还活着。
  //
  // 不用「删掉哨兵行」：行不存在同时表达「从没发过」和「已 ack」，
  // 两种状态无法区分，acked 就永远是 null。
  //
  // 不能走下面的 parseMessage 失败分支：那条 dropped += 1，而 index.ts 会把
  // dropped 累加进 __queue_dropped 统计，30s 一次 = 每天 2880 次虚增。
  if ((message.body as { p?: unknown } | null)?.p === PROBE_PROVIDER) {
    const sentAt = Number.parseInt(String((message.body as { t?: unknown }).t ?? '').slice(6), 10)
    if (!Number.isSafeInteger(sentAt) || sentAt <= 0) {
      // 时间戳坏了就当普通坏消息处理，别把哨兵行留在「已发未 ack」状态
      stats.dropped += 1
      message.ack()
      return
    }
    try {
      // CAS：只在 next_at 还等于本轮时间戳时才翻负。命中 0 行说明
      // healthz 已经发了更新的一轮，不能把它的标记盖掉
      await env.DB.prepare(
        `UPDATE gate SET next_at = ? WHERE provider = ? AND next_at = ?`,
      )
        .bind(-sentAt, PROBE_PROVIDER, sentAt)
        .run()
      message.ack()
    } catch (error) {
      // 回写失败必须 retry 而非 ack：ack 掉会让下一轮 healthz 读到正数、
      // 误报 consumer 没工作。max_retries: 3 兜底，耗尽后进死信队列，
      // 人工可见而非静默。
      logError({ event: 'healthz_probe_ack_failed', message: rawErrorText(error) })
      message.retry({ delaySeconds: 5 })
    }
    return
  }

  const parsed = parseMessage(message.body)
  if (parsed === null) {
    stats.dropped += 1
    message.ack()
    return
  }

  const target = decodeTarget(parsed.t)
  const provider = providerByName(parsed.p)
  const runtime = runtimeFor(parsed.p)
  if (target === null || provider === undefined || runtime === undefined) {
    stats.dropped += 1
    message.ack()
    return
  }
  if (endpointByOp(provider, target.op) === undefined) {
    stats.dropped += 1
    message.ack()
    return
  }

  stats.processed += 1

  try {
    const outcome = await refreshTarget(env, parsed.p, target, { skipGate: false })
    if (outcome.error !== undefined) {
      if (shouldRetry(outcome.error)) {
        if (message.attempts < 3) {
          stats.retried += 1
          message.retry({ delaySeconds: Math.min(60, 5 * message.attempts) })
          return
        }
        stats.dropped += 1
        message.ack()
        return
      }
      stats.dropped += 1
      message.ack()
      return
    }
    stats.refreshed += 1
    message.ack()
  } catch (error) {
    logError({
      event: 'queue_refresh_failed',
      provider: parsed.p,
      key: parsed.k,
      message: error instanceof Error ? error.message : String(error),
    })
    // buildPlan 抛出的 ApiError（如 slug 非法）同样走这套判断
    const retryable = error instanceof ApiError ? shouldRetry(error) : true
    if (retryable && message.attempts < 3) {
      stats.retried += 1
      message.retry({ delaySeconds: Math.min(60, 5 * message.attempts) })
      return
    }
    stats.dropped += 1
    message.ack()
  }
}

export async function handleQueueBatch(
  batch: MessageBatch<unknown>,
  env: Env,
): Promise<QueueStats> {
  const stats: QueueStats = { processed: 0, refreshed: 0, retried: 0, dropped: 0 }
  for (const message of batch.messages) {
    await handleMessage(message, env, stats)
  }
  return stats
}

/**
 * 只重试"等一会可能会好"的错误：闸门冷却、临时上游故障。
 *
 * 额度用尽、没配通道、参数非法都重试不了——tier C 尤其明显，重试不会让
 * ZenRows 的额度长回来，只会白白占掉 3 次 attempt 和队列操作费。
 */
function shouldRetry(error: ApiError): boolean {
  if (
    error.code === ErrorCode.QuotaExhausted ||
    error.code === ErrorCode.ProviderUnconfigured
  ) {
    return false
  }
  return error.status === 503 || error.status === 504
}
