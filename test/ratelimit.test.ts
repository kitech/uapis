import { env as cloudflareEnv, exports } from 'cloudflare:workers'
import { http, HttpResponse } from 'msw'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { resetRateLimitState } from '../src/core/ratelimit'
import { clearSettingsMemo, putSettings } from '../src/core/settings'
import { network } from './server'

const env = cloudflareEnv as unknown as Env
const HOT = { 'cf-connecting-ip': '203.0.113.7' }

function call(path: string, init?: RequestInit): Promise<Response> {
  return exports.default.fetch(`https://api.test${path}`, init)
}

beforeAll(() => {
  network.enable()
  network.use(
    http.get('https://hn.algolia.com/api/v1/search', () => HttpResponse.json({ hits: [] })),
  )
})

afterAll(() => {
  network.disable()
})

beforeEach(async () => {
  resetRateLimitState()
  await env.DB.prepare('DELETE FROM settings').run()
  await env.DB.prepare('DELETE FROM gate').run()
  clearSettingsMemo()
  // 测试里不做上游限速
  await putSettings(env, { 'gate.min_ms': '0', 'cache.t1': 'off' })
  clearSettingsMemo()
  network.resetHandlers()
  network.use(
    http.get('https://hn.algolia.com/api/v1/search', () => HttpResponse.json({ hits: [] })),
  )
})

afterEach(() => {
  clearSettingsMemo()
})

describe('限流窗口', () => {
  it('默认每分钟 60 次，超出后 429 并带 Retry-After', async () => {
    const statuses: number[] = []
    for (let i = 0; i < 62; i++) {
      statuses.push((await call('/api/v1/hackernews/search?q=rl', { headers: HOT })).status)
    }
    expect(statuses.slice(0, 60).every((s) => s === 200)).toBe(true)
    expect(statuses[60]).toBe(429)
    expect(statuses[61]).toBe(429)
  })

  it('429 响应带完整限流头与错误信封', async () => {
    await putSettings(env, { 'ratelimit.rpm': '2' })
    clearSettingsMemo()
    await call('/api/v1/hackernews/search?q=rl2', { headers: HOT })
    await call('/api/v1/hackernews/search?q=rl2', { headers: HOT })

    const res = await call('/api/v1/hackernews/search?q=rl2', { headers: HOT })
    expect(res.status).toBe(429)
    expect(res.headers.get('ratelimit-policy')).toBe('2;w=1')
    expect(res.headers.get('x-ratelimit-limit')).toBe('2')
    expect(res.headers.get('x-ratelimit-remaining')).toBe('0')
    expect(res.headers.get('retry-after')).toMatch(/^\d+$/)
    expect(await res.json()).toMatchObject({
      code: 'RATE_LIMITED',
      message: 'rate limit exceeded',
      details: { limit: 2, window_seconds: 60 },
    })
  })

  it('不同来源 IP 各自计数', async () => {
    await putSettings(env, { 'ratelimit.rpm': '2' })
    clearSettingsMemo()
    await call('/api/v1/hackernews/search?q=rl3', { headers: HOT })
    await call('/api/v1/hackernews/search?q=rl3', { headers: HOT })
    const blocked = await call('/api/v1/hackernews/search?q=rl3', { headers: HOT })
    const other = await call('/api/v1/hackernews/search?q=rl3', {
      headers: { 'cf-connecting-ip': '198.51.100.9' },
    })
    expect(blocked.status).toBe(429)
    expect(other.status).toBe(200)
  })

  it('ratelimit.rpm=0 时不限流', async () => {
    resetRateLimitState()
    await putSettings(env, { 'ratelimit.rpm': '0' })
    clearSettingsMemo()
    const res = await call('/api/v1/hackernews/search?q=open', { headers: HOT })
    expect(res.status).toBe(200)
    expect(res.headers.get('ratelimit-policy')).toBeNull()
  })
})

describe('管理端点', () => {
  it('管理端点同样受入口限流保护', async () => {
    const admin = { 'cf-connecting-ip': '198.51.100.20' }
    await putSettings(env, { 'ratelimit.rpm': '2' })
    clearSettingsMemo()
    expect((await call('/admin/settings', { headers: admin })).status).toBe(401)
    expect((await call('/admin/settings', { headers: admin })).status).toBe(401)
    expect((await call('/admin/settings', { headers: admin })).status).toBe(429)
  })
})
