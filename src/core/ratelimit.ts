import type { Context, MiddlewareHandler, Next } from 'hono'
import type { AppEnv } from '../types'
import { ErrorCode, fail } from './errors'
import { errorResponse } from './envelope'
import { getIntSetting } from './settings'
import { bumpCounter } from './logger'

interface Bucket {
  count: number
  resetAt: number
}

/** 隔离实例内的固定窗口计数器；不追求跨实例精确，只做单实例防滥用 */
const buckets = new Map<string, Bucket>()
const MAX_BUCKETS = 20_000
const WINDOW_MS = 60_000

export const rateLimit = (): MiddlewareHandler<AppEnv> => {
  return async (c: Context<AppEnv>, next: Next) => {
    const ip = clientIp(c)
    const limit = await getIntSetting(c.env, 'ratelimit.rpm')
    if (limit <= 0) {
      await next()
      return
    }

    const now = Date.now()
    const bucket = takeBucket(ip, now, limit)
    const remaining = Math.max(0, limit - bucket.count)
    const resetSec = Math.ceil((bucket.resetAt - now) / 1000)

    c.header('RateLimit-Policy', `${limit};w=1`)
    c.header('RateLimit', `r=${remaining};t=${resetSec}`)
    c.header('X-RateLimit-Limit', String(limit))
    c.header('X-RateLimit-Remaining', String(remaining))
    c.header('X-RateLimit-Reset', String(resetSec))

    if (bucket.count > limit) {
      const error = fail(
        ErrorCode.RateLimited,
        'rate limit exceeded',
        429,
        { limit, window_seconds: 60 },
        resetSec,
      )
      bumpCounter('429')
      return errorResponse(c, error, c.res.headers)
    }

    await next()
  }
}

/** 仅供测试：清空窗口计数器，让每个用例从干净状态开始（限流行为由 ratelimit.test.ts 覆盖） */
export function resetRateLimitBuckets(): void {
  buckets.clear()
}

function takeBucket(key: string, now: number, limit: number): Bucket {
  const existing = buckets.get(key)
  if (existing !== undefined && existing.resetAt > now) {
    existing.count += 1
    return existing
  }
  const fresh: Bucket = { count: 1, resetAt: now + WINDOW_MS }
  buckets.set(key, fresh)
  if (buckets.size > MAX_BUCKETS) evict(now)
  return fresh
}

function evict(now: number): void {
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) buckets.delete(key)
  }
  if (buckets.size > MAX_BUCKETS) {
    const excess = buckets.size - MAX_BUCKETS
    let i = 0
    for (const key of buckets.keys()) {
      buckets.delete(key)
      if (++i >= excess) break
    }
  }
}

function clientIp(c: Context<AppEnv>): string {
  return c.req.header('cf-connecting-ip') ?? 'anonymous'
}

export function resetRateLimitState(): void {
  buckets.clear()
}
