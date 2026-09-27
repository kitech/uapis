import { runtimeFor } from '../providers'
import { consumeQueueSlot, queueBudget } from './credits'
import { logError } from './logger'
import { refreshTarget } from './refresh'
import { getIntSetting } from './settings'
import { decodeTarget } from './target'
import { endpointByOp, providerByName } from './registry'
import type { RefreshMessage } from '../types'

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
      const retryable = outcome.error.status === 503 || outcome.error.status === 504
      if (retryable) {
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
    if (message.attempts < 3) {
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
