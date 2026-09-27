import { runtimeFor } from '../providers'
import { consumeCredits } from './credits'
import { encodeText, store } from './cache'
import { ApiError, ErrorCode, fail, mapUpstreamStatus } from './errors'
import { fetchUpstream, fetchViaProxy, pickChannel } from './fetcher'
import { JSON_CT } from './envelope'
import { checkGate, noteProviderFailure } from './gate'
import { endpointByOp, providerByName, type ProviderDef } from './registry'
import { getIntSetting, getSetting } from './settings'
import { buildCacheKey, policyFor, type Resource } from './ttl'
import type { ProxyChannel } from './fetcher'
import type { Target } from './target'
import { logError } from './logger'

export function cacheKeyFor(provider: string, resource: Resource, target: Target): string {
  return buildCacheKey(provider, resource, target.op, target.id, target.query)
}

export interface RefreshOutcome {
  /** 命中缓存可复用的状态码（200 或缓存的错误码） */
  status: number
  text: string
  contentType: string
  error?: ApiError
  key: string
  stored: boolean
}

/** 内联回源与队列刷新共用的核心：闸门 → 额度 → 抓取 → 落库 → 负缓存 */
export async function refreshTarget(
  env: Env,
  providerName: string,
  target: Target,
  options: { requestId?: string; skipGate?: boolean } = {},
): Promise<RefreshOutcome> {
  const provider = providerByName(providerName)
  const runtime = runtimeFor(providerName)
  if (provider === undefined || runtime === undefined) {
    throw fail(ErrorCode.NotFound, `unknown provider: ${providerName}`, 404)
  }
  const endpoint = endpointByOp(provider, target.op)
  if (endpoint === undefined) {
    throw fail(ErrorCode.NotFound, `unknown op: ${target.op}`, 404)
  }

  const key = cacheKeyFor(providerName, endpoint.resource, target)

  if (options.skipGate !== true) {
    const gate = await checkGate(env, providerName, await gateInterval(env, provider))
    if (!gate.allowed) {
      return {
        status: 503,
        text: '',
        contentType: JSON_CT,
        key,
        stored: false,
        error: fail(
          ErrorCode.RateLimited,
          `provider ${providerName} cooling down`,
          503,
          { retry_in: gate.waitSeconds },
          gate.waitSeconds,
        ),
      }
    }
  }

  // 先建 plan：buildPlan 可能因参数非法抛错，不能在它之前就扣额度
  const plan = await runtime.buildPlan(env, target)

  let channel: ProxyChannel | undefined
  if (plan.proxy !== undefined) {
    // 通道必须先由 pickChannel 定下来再记账：显式 channel > ZenRows（消耗 credits）> Jina。
    // 之前这里用 `endpoint.proxy.channel ?? 'zenrows'` 记账，auto 模式下实际走 Jina 却记在 ZenRows 上，
    // 结果是 ZenRows 额度被凭空扣光而 Jina 的用量没被统计。
    channel = await pickChannel(env, plan.proxy.channel)
    const paid = await consumeCredits(env, 'proxy', channel, 1)
    if (!paid) {
      return {
        status: 503,
        text: '',
        contentType: JSON_CT,
        key,
        stored: false,
        error: fail(
          ErrorCode.QuotaExhausted,
          `daily quota exhausted for ${providerName}`,
          503,
          { provider: providerName, channel },
          3600,
        ),
      }
    }
  }

  const response =
    plan.proxy !== undefined
      ? await fetchViaProxy(env, { ...plan.proxy, channel })
      : await fetchUpstream(env, {
          url: plan.url,
          method: plan.method,
          headers: plan.headers,
          timeoutMs: plan.timeoutMs,
          retries: plan.retries,
        })

  if (response.status < 200 || response.status >= 300) {
    const mapped = mapUpstreamStatus(response.status)
    const error = new ApiError(
      mapped.code,
      `upstream ${providerName} responded ${response.status}`,
      mapped.status,
      { provider: providerName, upstream_status: response.status },
      response.status === 429 ? 60 : undefined,
    )
    await noteProviderFailure(env, providerName)
    const stored = await writeNegative(env, provider, key, error)
    return {
      status: error.status,
      text: JSON.stringify(error.toBody()),
      contentType: JSON_CT,
      error,
      key,
      stored,
    }
  }

  // 非 passthrough 源：先转成 JSON 再落库，缓存里存的永远是本项目的输出形态
  let text = response.raw
  let contentType = response.contentType
  if (endpoint.passthrough === false && runtime.transform !== undefined) {
    const result = runtime.transform(text, target)
    text = result.text
    contentType = result.contentType
  }

  const policy = policyFor(endpoint.resource)
  const now = Date.now()
  const body = encodeText(text)
  const stored = await store(env, {
    key,
    body,
    encoding: 'identity',
    status: 200,
    contentType,
    provider: providerName,
    resource: endpoint.resource,
    fetchedAt: now,
    expiresAt: now + policy.ttlSeconds * 1000,
    staleUntil: now + (policy.ttlSeconds + policy.staleSeconds) * 1000,
    size: body.byteLength,
  })

  if (!stored) {
    logError({
      level: 'error',
      event: 'cache_store_skipped',
      key,
      provider: providerName,
      request_id: options.requestId,
    })
  }

  return { status: 200, text, contentType, key, stored }
}

/** `gate.min_ms` 可覆盖 registry 里的最小间隔（测试与运维调优用；空值 = 用 registry 值） */
async function gateInterval(env: Env, provider: ProviderDef): Promise<number> {
  const raw = await getSetting(env, 'gate.min_ms')
  if (raw.length === 0) return provider.minIntervalMs
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) ? parsed : provider.minIntervalMs
}

async function writeNegative(
  env: Env,
  provider: ProviderDef,
  key: string,
  error: ApiError,
): Promise<boolean> {
  const ttl = await getIntSetting(env, 'cache.negative_ttl')
  const seconds = ttl > 0 ? ttl : 21_600
  const now = Date.now()
  const body = encodeText(JSON.stringify(error.toBody()))
  return store(env, {
    key,
    body,
    encoding: 'identity',
    status: error.status,
    contentType: JSON_CT,
    provider: provider.name,
    resource: 'error',
    fetchedAt: now,
    expiresAt: now + seconds * 1000,
    staleUntil: now + seconds * 1000,
    size: body.byteLength,
  })
}
