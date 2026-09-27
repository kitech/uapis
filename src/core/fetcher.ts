import { ApiError, ErrorCode, fail } from './errors'
import { getSetting } from './settings'
import { readCredits } from './credits'

export const DEFAULT_TIMEOUT_MS = 3_000
export const MAX_UPSTREAM_BYTES = 512 * 1024

/** SSRF 兜底：即使模板被改坏，也不允许打内网/元数据地址 */
const BLOCKED_HOSTS = [
  /^localhost$/,
  /^127\./,
  /^10\./,
  /^192\.168\./,
  /^169\.254\./,
  /^0\./,
  /^172\.(1[6-9]|2[0-9]|3[01])\./,
  /^\[?::1\]?$/,
  /^fc/,
  /^metadata\./,
  /\.internal$/,
  /\.local$/,
]

export function userAgent(env: Env): string {
  const site = (env.SITE_URL ?? '').replace(/\/+$/, '')
  return `uapis/1.0 (+${site})`
}

/** 唯一的上游出口：https + 固定 host 白名单 + 强制 UA */
export async function assertAllowedUpstream(env: Env, raw: string): Promise<URL> {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw fail(ErrorCode.InvalidParameter, `invalid upstream url: ${raw}`, 400)
  }
  if (url.protocol !== 'https:') {
    throw fail(ErrorCode.Forbidden, 'upstream must use https', 403, { host: url.hostname })
  }
  const host = url.hostname.toLowerCase().replace(/\.$/, '')
  if (BLOCKED_HOSTS.some((pattern) => pattern.test(host))) {
    throw fail(ErrorCode.Forbidden, 'upstream host blocked', 403, { host })
  }
  const allowlist = await getAllowlist(env)
  if (allowlist.length > 0 && !allowlist.includes(host)) {
    throw fail(ErrorCode.Forbidden, 'upstream host not allowlisted', 403, { host })
  }
  return url
}

export async function getAllowlist(env: Env): Promise<string[]> {
  const raw = await getSetting(env, 'upstream.allowlist')
  return raw
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter((item) => item.length > 0)
}

export interface UpstreamRequest {
  url: string
  method?: string
  headers?: Record<string, string>
  timeoutMs?: number
  retries?: number
}

export interface UpstreamResponse {
  status: number
  raw: string
  contentType: string
  attempts: number
}

const BACKOFF_MS = [200, 600, 1_500]

/** 4xx 不重试；429/5xx 指数退避重试 */
export async function fetchUpstream(
  env: Env,
  request: UpstreamRequest,
): Promise<UpstreamResponse> {
  const url = await assertAllowedUpstream(env, request.url)
  const retries = request.retries ?? 1
  const timeoutMs = request.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const headers = new Headers(request.headers ?? {})
  headers.set('user-agent', userAgent(env))
  if (!headers.has('accept')) headers.set('accept', '*/*')
  if (!headers.has('accept-language')) headers.set('accept-language', 'en')

  let attempts = 0
  let lastStatus = 502
  let lastRaw = ''

  while (attempts <= retries) {
    attempts += 1
    let response: Response
    try {
      response = await fetch(url.toString(), {
        method: request.method ?? 'GET',
        headers,
        signal: AbortSignal.timeout(timeoutMs),
        redirect: 'follow',
      })
    } catch (error) {
      lastStatus = 504
      lastRaw = error instanceof Error ? error.message : 'fetch failed'
      if (attempts > retries) break
      await sleep(BACKOFF_MS[Math.min(attempts - 1, BACKOFF_MS.length - 1)] ?? 200)
      continue
    }

    lastStatus = response.status
    if (response.ok) {
      const declared = Number.parseInt(response.headers.get('content-length') ?? '', 10)
      if (Number.isFinite(declared) && declared > MAX_UPSTREAM_BYTES) {
        throw fail(ErrorCode.FileTooLarge, 'upstream payload too large', 413, {
          bytes: declared,
        })
      }
      let raw: string
      try {
        raw = await response.text()
      } catch (error) {
        // 状态行到了、正文没到（对端挂起或中途断流）：`AbortSignal.timeout` 会在读正文时
        // 抛 TimeoutError。不接住的话它会一路冒到 onError 变成 500 INTERNAL_ERROR，
        // 而且不写负缓存——同一个 key 每次都白等一个超时。P5 接 pypi/npm 时在 Fastly
        // 前置的 CDN 上撞到过（连得上、正文不落地）。
        lastStatus = 504
        lastRaw = error instanceof Error ? error.message : 'upstream body read failed'
        if (attempts > retries) break
        await sleep(BACKOFF_MS[Math.min(attempts - 1, BACKOFF_MS.length - 1)] ?? 200)
        continue
      }
      if (raw.length > MAX_UPSTREAM_BYTES) {
        throw fail(ErrorCode.FileTooLarge, 'upstream payload too large', 413)
      }
      if (raw.length === 0) {
        // 空正文当 200 落库会缓存出一个"成功但没内容"的条目
        lastStatus = 502
        lastRaw = 'upstream returned an empty body'
        if (attempts > retries) break
        await sleep(BACKOFF_MS[Math.min(attempts - 1, BACKOFF_MS.length - 1)] ?? 200)
        continue
      }
      return {
        status: response.status,
        raw,
        contentType: response.headers.get('content-type') ?? 'application/json; charset=utf-8',
        attempts,
      }
    }

    lastRaw = await response.text().catch(() => '')
    if (response.status < 500 && response.status !== 429) break
    if (attempts > retries) break
    await sleep(BACKOFF_MS[Math.min(attempts - 1, BACKOFF_MS.length - 1)] ?? 200)
  }

  return { status: lastStatus, raw: lastRaw, contentType: 'application/json', attempts }
}

export type ProxyMode = 'raw' | 'json_html' | 'json_markdown'
export type ProxyChannel = 'zenrows' | 'jina'

export interface ProxyTarget {
  provider: string
  url: string
  mode?: ProxyMode
  channel?: ProxyChannel
  retries?: number
}

const CHANNEL_SETTING: Record<ProxyChannel, string> = {
  zenrows: 'zenrows.key',
  jina: 'jina.key',
}

/**
 * 通道选择：显式 hint > `proxy.mode` 指定 > ZenRows（有 key 且有 credits）> Jina。
 *
 * `proxy.mode` 的 off / auto 都表示"没有偏好"——它只对声明了 `proxy` 的端点有意义，
 * 不会让某个源绕过付费通道直连。写成 zenrows / jina 则是强制走那一条（没 key 就 503）。
 */
export async function pickChannel(env: Env, hint?: ProxyChannel): Promise<ProxyChannel> {
  if (hint !== undefined) return hint
  const mode = (await getSetting(env, 'proxy.mode')).toLowerCase()
  if (mode === 'zenrows' || mode === 'jina') return mode

  const zenrowsKey = await getSetting(env, CHANNEL_SETTING.zenrows)
  if (zenrowsKey.length > 0) {
    const credits = await readCredits(env, 'proxy', 'zenrows')
    if (credits.remaining > 0) return 'zenrows'
  }
  const jinaKey = await getSetting(env, CHANNEL_SETTING.jina)
  if (jinaKey.length > 0) return 'jina'
  throw fail(ErrorCode.ProviderUnconfigured, 'no proxy channel configured', 503, {
    hint: 'set zenrows.key or jina.key via /admin/settings',
  })
}

/** 通过付费通道回源；模板来自 D1 settings，绝不接受用户传入的 URL */
export async function fetchViaProxy(env: Env, target: ProxyTarget): Promise<UpstreamResponse> {
  const channel = await pickChannel(env, target.channel)
  const key = await getSetting(env, CHANNEL_SETTING[channel])
  if (key.length === 0) {
    throw fail(ErrorCode.ProviderUnconfigured, `${channel} key missing`, 503, {
      setting: CHANNEL_SETTING[channel],
    })
  }

  const mode = target.mode ?? 'raw'
  const template =
    channel === 'zenrows'
      ? await getSetting(env, 'proxy.zenrows_url')
      : await getSetting(env, 'proxy.jina_url')
  if (template.length === 0) {
    throw fail(ErrorCode.ProviderUnconfigured, `${channel} template missing`, 503, {
      setting: channel === 'zenrows' ? 'proxy.zenrows_url' : 'proxy.jina_url',
    })
  }

  const url = template
    .replaceAll('{key}', encodeURIComponent(key))
    .replaceAll('{url}', encodeURIComponent(target.url))
    .replaceAll('{mode}', mode)

  return fetchUpstream(env, { url, retries: target.retries ?? 2 })
}

export class UpstreamFailure extends Error {
  constructor(
    readonly provider: string,
    readonly status: number,
    readonly detail: string,
  ) {
    super(detail)
    this.name = 'UpstreamFailure'
  }
}

export function toApiError(error: unknown): ApiError {
  if (error instanceof ApiError) return error
  if (error instanceof UpstreamFailure) {
    return fail(ErrorCode.UpstreamError, `upstream ${error.provider} failed`, 502, {
      status: error.status,
    })
  }
  return fail(ErrorCode.InternalError, 'internal error', 500)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
