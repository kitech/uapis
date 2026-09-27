import type { MiddlewareHandler } from 'hono'
import type { AppEnv } from '../types'
import { getCsvSetting } from './settings'

const MAX_AGE = '86400'

const EXPOSED_HEADERS = [
  'X-Request-ID',
  'X-Cache',
  'X-Quota',
  'RateLimit-Policy',
  'RateLimit',
  'X-RateLimit-Limit',
  'X-RateLimit-Remaining',
  'X-RateLimit-Reset',
  'Retry-After',
].join(', ')

/**
 * CORS 白名单，来源列表来自 D1 settings `cors.origins`（默认 `*`）。
 * 预检不消耗令牌桶额度。
 */
export const cors = (): MiddlewareHandler<AppEnv> => {
  return async (c, next) => {
    const origin = c.req.header('origin')
    const allowed = await isOriginAllowed(c.env, origin)

    if (origin !== undefined) {
      c.header('Vary', 'Origin')
      if (allowed) {
        c.header('Access-Control-Allow-Origin', origin)
        c.header('Access-Control-Expose-Headers', EXPOSED_HEADERS)
      }
    }

    if (c.req.method === 'OPTIONS') {
      c.header('Access-Control-Max-Age', MAX_AGE)
      c.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
      c.header('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Request-ID')
      c.header('Access-Control-Allow-Origin', allowed && origin !== undefined ? origin : '*')
      return c.body(null, 204)
    }

    await next()
  }
}

async function isOriginAllowed(env: Env, origin: string | undefined): Promise<boolean> {
  if (origin === undefined) return true
  const list = await getCsvSetting(env, 'cors.origins')
  if (list.includes('*')) return true
  return list.includes(origin)
}
