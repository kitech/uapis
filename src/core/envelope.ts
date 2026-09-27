import type { Context } from 'hono'
import type { AppEnv } from '../types'
import { ApiError } from './errors'

export const JSON_CT = 'application/json; charset=utf-8'
export const TEXT_CT = 'text/plain; charset=utf-8'

/**
 * 物化 `c.res`，让 Hono 把中间件写入的 header（X-Request-ID / CORS / 限流）
 * 合并进最终响应。handler 直接 `return new Response(...)` 时必须走这里，
 * 否则 preparedHeaders 会丢失。
 */
export function finalize(c: Context<AppEnv>, res: Response): Response {
  void c.res
  return res
}

/** 序列化裸业务对象（成功响应无信封） */
export function jsonBody(c: Context<AppEnv>, data: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers)
  headers.set('content-type', JSON_CT)
  return finalize(c, new Response(JSON.stringify(data), { ...init, headers }))
}

/** 上游原始字节直出，零解析零重编码 */
export function passthroughBody(
  c: Context<AppEnv>,
  raw: string,
  contentType: string,
  init: ResponseInit = {},
): Response {
  const headers = new Headers(init.headers)
  headers.set('content-type', contentType || JSON_CT)
  return finalize(c, new Response(raw, { ...init, headers }))
}

export function textBody(c: Context<AppEnv>, text: string, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers)
  headers.set('content-type', TEXT_CT)
  return finalize(c, new Response(text, { ...init, headers }))
}

export function errorResponse(
  c: Context<AppEnv>,
  error: ApiError,
  extraHeaders?: HeadersInit,
): Response {
  const headers = new Headers(extraHeaders)
  headers.set('content-type', JSON_CT)
  if (error.retryAfter !== undefined) {
    headers.set('Retry-After', String(error.retryAfter))
  }
  return finalize(c, new Response(JSON.stringify(error.toBody()), { status: error.status, headers }))
}

export function emptyResponse(c: Context<AppEnv>, status = 204): Response {
  return finalize(c, new Response(null, { status }))
}
