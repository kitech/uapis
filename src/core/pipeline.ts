import type { Context } from 'hono'
import type { AppEnv } from '../types'
import { bumpCounter, logError } from './logger'
import { ApiError, ErrorCode, fail } from './errors'
import { errorResponse, passthroughBody , finalize } from './envelope'
import { enqueueRefresh } from './queue'
import { cacheKeyFor, refreshTarget } from './refresh'
import { lookup, type CacheLookup, type CacheRecord } from './cache'
import { getBoolSetting, getSetting } from './settings'
import { encodeTarget, type Target } from './target'
import type { EndpointDef, ProviderDef } from './registry'

export interface ServeOptions {
  /** 上游缺数据时是否允许内联回源（仅 passthrough 源） */
  inline: boolean
}

const asyncHint = (c: Context<AppEnv>): boolean =>
  (c.req.header('prefer') ?? '').toLowerCase().includes('respond-async')

function buildMessage(provider: string, key: string, target: Target) {
  return { v: 1 as const, k: key, p: provider, t: encodeTarget(target) }
}

/**
 * 统一读路径：T1 → T2 → 回源。
 * - 新鲜命中：直接返回，零解析
 * - stale 窗口内：返回旧值，waitUntil 入队刷新
 * - 完全过期或缺失：能内联就内联；否则入队，按 `Prefer: respond-async`
 *   返回 202，否则 503 REBUILDING + Retry-After
 */
export async function serveResource(
  c: Context<AppEnv>,
  provider: ProviderDef,
  endpoint: EndpointDef,
  target: Target,
  options: ServeOptions,
): Promise<Response> {
  const key = cacheKeyFor(provider.name, endpoint.resource, target)
  const found = await lookup(c.env, key)

  if (found !== null && found.record.status === 200 && found.state === 'HIT') {
    return serveHit(c, found, 'HIT')
  }

  if (found !== null && found.record.status === 200 && found.state === 'STALE') {
    c.executionCtx.waitUntil(refreshInBackground(c, provider, key, target))
    return serveHit(c, found, 'STALE')
  }

  // 负缓存：原样回放上游错误状态
  if (found !== null && found.record.status !== 200) {
    bumpCounter('negative')
    return finalize(c, new Response(found.text, {
      status: found.record.status,
      headers: { 'content-type': found.record.contentType, 'X-Cache': 'NEGATIVE' },
    }))
  }

  // 超出 stale 窗口的旧值：仅作为回源失败时的兜底
  const fallback: CacheLookup | null = found

  if (fallback === null && provider.auth !== undefined && endpoint.auth !== 'optional') {
    const configured = (await getSetting(c.env, provider.auth.settingKey)).length > 0
    if (!configured) {
      return errorResponse(
        c,
        fail(ErrorCode.ProviderUnconfigured, `${provider.displayName} 未配置凭据`, 503, {
          provider: provider.name,
          setting: provider.auth.settingKey,
          signup: provider.auth.signupUrl,
        }),
      )
    }
  }

  // 付费通道：两条通道任一可用即可，全空时直接 503，
  // 别让请求进队列白烧一次 refresh 额度
  if (fallback === null && (provider.requiredAnyOf ?? []).length > 0) {
    const keys = provider.requiredAnyOf ?? []
    const configured = await Promise.all(keys.map((key) => getSetting(c.env, key)))
    if (configured.every((value) => value.length === 0)) {
      return errorResponse(
        c,
        fail(ErrorCode.ProviderUnconfigured, `${provider.displayName} 未配置可用通道`, 503, {
          provider: provider.name,
          any_of: keys,
          hint: 'set any of these via /admin/settings',
        }),
      )
    }
  }

  if (fallback === null) {
    const maintenance = (await getSetting(c.env, 'maintenance.mode')).toLowerCase()
    if (maintenance !== 'active') {
      return errorResponse(
      c,
        fail(ErrorCode.ServiceUnavailable, `maintenance mode: ${maintenance}`, 503, {
          mode: maintenance,
        }),
      )
    }
  }

  const inlineAllowed =
    options.inline &&
    endpoint.inline &&
    endpoint.proxy === undefined &&
    (await getBoolSetting(c.env, 'cache.inline'))

  if (inlineAllowed) {
    const outcome = await refreshTarget(c.env, provider.name, target, {
      requestId: c.get('requestId'),
    })
    if (outcome.error === undefined) {
      bumpCounter('refresh')
      return passthroughBody(c, outcome.text, outcome.contentType, {
        status: 200,
        headers: { 'X-Cache': 'REFRESH' },
      })
    }
    if (fallback !== null) {
      return serveHit(c, fallback, 'STALE-FALLBACK')
    }
    return errorResponse(c, outcome.error, { 'X-Cache': 'MISS' })
  }

  const queued = await enqueueRefresh(c.env, buildMessage(provider.name, key, target))

  if (queued === 'sent') {
    if (asyncHint(c)) {
      return errorResponse(
      c,
        new ApiError('ACCEPTED', 'refresh queued', 202, { key, provider: provider.name }),
        { 'X-Cache': 'QUEUED' },
      )
    }
    return errorResponse(
      c,
      fail(ErrorCode.Rebuilding, 'no cached data yet, refresh queued', 503, { key }, 1),
      { 'X-Cache': 'QUEUED' },
    )
  }

  logError({ event: 'queue_budget_exhausted', provider: provider.name, key, result: queued })
  if (fallback !== null) {
    return serveHit(c, fallback, 'STALE-FALLBACK')
  }
  return errorResponse(
      c,
    fail(ErrorCode.QuotaExhausted, 'daily refresh budget exhausted', 503, { provider: provider.name }, 3600),
    { 'X-Quota': 'exhausted' },
  )
}

async function refreshInBackground(
  c: Context<AppEnv>,
  provider: ProviderDef,
  key: string,
  target: Target,
): Promise<void> {
  const result = await enqueueRefresh(c.env, buildMessage(provider.name, key, target))
  if (result !== 'sent') {
    logError({ event: 'stale_refresh_not_queued', provider: provider.name, key, result })
  }
}

function serveHit(c: Context<AppEnv>, hit: CacheLookup, label: string): Response {
  const resource: CacheRecord = hit.record
  bumpCounter(label === 'HIT' ? `hit:${resource.resource}` : 'stale')
  return passthroughBody(c, hit.text, resource.contentType, {
    status: 200,
    headers: {
      'X-Cache': label,
      'X-Cache-Age': String(Math.max(0, Math.floor((Date.now() - resource.fetchedAt) / 1000))),
    },
  })
}
