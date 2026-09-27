import type { MiddlewareHandler } from 'hono'
import type { AppEnv } from '../types'

const SAFE_REQUEST_ID = /^[A-Za-z0-9._~-]{1,64}$/

/** 透传合法的 `X-Request-ID`，否则生成 UUID；响应统一回写该头 */
export const requestId = (): MiddlewareHandler<AppEnv> => {
  return async (c, next) => {
    const incoming = c.req.header('x-request-id')
    const id = incoming && SAFE_REQUEST_ID.test(incoming) ? incoming : crypto.randomUUID()
    c.set('requestId', id)
    await next()
    c.header('X-Request-ID', id)
  }
}
