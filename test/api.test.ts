import { env as cloudflareEnv, exports } from 'cloudflare:workers'
import { http, HttpResponse } from 'msw'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { clearSettingsMemo, putSettings } from '../src/core/settings'
import { network } from './server'

/** miniflare 的 Cloudflare.Env 缺少 src/types.ts 里声明的 ADMIN_TOKEN，测试里做一次桥接 */
const env = cloudflareEnv as unknown as Env

const HN = 'https://hn.algolia.com'
const SE = 'https://api.stackexchange.com'
const ADMIN = { authorization: 'Bearer test-admin-token' }

/** 主 Worker 与测试同 isolate，MSW 拦截对其出站请求生效 */
function call(path: string, init?: RequestInit): Promise<Response> {
  return exports.default.fetch(`https://api.test${path}`, init)
}

let hnSearch: { calls: number; urls: string[] }
let seQuestions: { calls: number; urls: string[] }

beforeAll(async () => {
  network.enable()
  hnSearch = { calls: 0, urls: [] }
  seQuestions = { calls: 0, urls: [] }
  // 测试里不真实限速：把 provider 闸门间隔压到 0
  await putSettings(env, { 'gate.min_ms': '0' })
  clearSettingsMemo()

  network.use(
    http.get(`${HN}/api/v1/search`, ({ request }) => {
      hnSearch.calls += 1
      hnSearch.urls.push(request.url)
      return HttpResponse.json({ hits: [{ title: 'cloudflare workers' }] })
    }),
    http.get(`${SE}/2.3/questions/:id`, ({ request }) => {
      seQuestions.calls += 1
      seQuestions.urls.push(request.url)
      return HttpResponse.json({ items: [{ question_id: 123, title: 'hello' }] })
    }),
  )
})

afterEach(() => {
  hnSearch.calls = 0
  hnSearch.urls = []
  seQuestions.calls = 0
  seQuestions.urls = []
})

afterAll(() => {
  network.disable()
})

describe('元数据端点', () => {
  it('根路径返回服务信息与免责说明', async () => {
    const res = await call('/')
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.name).toBe('uapis')
    expect(String(body.disclaimer)).toContain('无任何关联')
    expect(res.headers.get('x-request-id')).toMatch(/[0-9a-f-]{36}/)
  })

  it('/openapi.json 暴露 BearerAuth 与错误结构', async () => {
    const res = await call('/openapi.json')
    expect(res.status).toBe(200)
    const doc = (await res.json()) as {
      openapi: string
      components: { securitySchemes: Record<string, unknown>; schemas: Record<string, unknown> }
    }
    expect(doc.openapi).toBe('3.1.0')
    expect(Object.keys(doc.components.securitySchemes)).toEqual(['BearerAuth'])
    expect(Object.keys(doc.components.schemas)).toContain('UApiError')
  })

  it('/llms.txt 列出全部接口', async () => {
    const text = await (await call('/llms.txt')).text()
    expect(text).toContain('/api/v1/hackernews/search')
    expect(text).toContain('/api/v1/stackexchange/question/')
  })

  it('/healthz 与 /status 可用', async () => {
    expect((await call('/healthz')).status).toBe(200)
    const body = (await (await call('/status')).json()) as {
      providers: { name: string; status: string }[]
      free_tier_budget: Record<string, number>
    }
    expect(body.providers.map((p) => p.name).sort()).toEqual(['hackernews', 'stackexchange'])
    expect(body.providers.find((p) => p.name === 'stackexchange')?.status).toBe('unconfigured')
    expect(body.free_tier_budget.requests_per_day).toBe(100_000)
  })

  it('/docs/ 未命中静态资源时回落到 404 信封（生产由 Static Assets 直出）', async () => {
    const res = await call('/docs/')
    expect(res.status).toBe(404)
    const body = (await res.json()) as { code: string; details: { openapi: string } }
    expect(body.code).toBe('NOT_FOUND')
    expect(body.details.openapi).toBe('/openapi.json')
  })

  it('未知路由返回 NOT_FOUND 信封', async () => {
    const res = await call('/nope')
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({
      code: 'NOT_FOUND',
      message: 'no route for GET /nope',
      details: { openapi: '/openapi.json' },
    })
  })
})

describe('读路径：透传 + 缓存', () => {
  it('首次 REFRESH，二次命中缓存，且不再回源', async () => {
    const first = await call('/api/v1/hackernews/search?q=workers')
    expect(first.status).toBe(200)
    expect(first.headers.get('x-cache')).toBe('REFRESH')
    expect(await first.json()).toEqual({ hits: [{ title: 'cloudflare workers' }] })

    const second = await call('/api/v1/hackernews/search?q=workers')
    expect(second.status).toBe(200)
    expect(['HIT', 'HIT-T1']).toContain(second.headers.get('x-cache'))
    expect(await second.json()).toEqual({ hits: [{ title: 'cloudflare workers' }] })
    expect(hnSearch.calls).toBe(1)
  })

  it('不同 query 是不同缓存条目', async () => {
    await call('/api/v1/hackernews/search?q=a')
    await call('/api/v1/hackernews/search?q=b')
    expect(hnSearch.calls).toBe(2)
  })

  it('query 默认值进入缓存键', async () => {
    await call('/api/v1/hackernews/search?q=defaults')
    await call('/api/v1/hackernews/search?q=defaults&hitsPerPage=20')
    expect(hnSearch.calls).toBe(1)
  })

  it('上游 404 映射为 NOT_FOUND', async () => {
    network.use(
      http.get(`${HN}/api/v1/items/404404`, () => new HttpResponse(null, { status: 404 })),
    )
    const res = await call('/api/v1/hackernews/item/404404')
    expect(res.status).toBe(404)
    expect(((await res.json()) as { code: string }).code).toBe('NOT_FOUND')
  })

  it('上游 5xx 记负缓存：第二次直接回放且不再回源', async () => {
    let calls = 0
    network.use(
      http.get(`${HN}/api/v1/search`, ({ request }) => {
        if (new URL(request.url).searchParams.get('query') !== 'negative') {
          return HttpResponse.json({ hits: [] })
        }
        calls += 1
        return HttpResponse.json({ message: 'upstream down' }, { status: 503 })
      }),
    )

    const first = await call('/api/v1/hackernews/search?q=negative')
    expect(first.status).toBe(502)
    expect(first.headers.get('x-cache')).toBe('MISS')
    // fetchUpstream 对 5xx 退避重试一次，因此一次请求会打上游两次
    const callsAfterFirst = calls
    expect(callsAfterFirst).toBe(2)

    const second = await call('/api/v1/hackernews/search?q=negative')
    expect(second.status).toBe(502)
    expect(second.headers.get('x-cache')).toBe('NEGATIVE')
    expect(calls).toBe(callsAfterFirst)
  })
})

describe('参数校验', () => {
  it('未声明的 query 参数直接 400', async () => {
    const res = await call('/api/v1/hackernews/search?q=x&bogus=1')
    expect(res.status).toBe(400)
    const body = (await res.json()) as { code: string; details: { allowed: string[] } }
    expect(body.code).toBe('INVALID_PARAMETER')
    expect(body.details.allowed).toContain('q')
    expect(hnSearch.calls).toBe(0)
  })

  it('整数参数越界 400', async () => {
    const res = await call('/api/v1/hackernews/search?hitsPerPage=999')
    expect(res.status).toBe(400)
    expect(((await res.json()) as { details: { maximum: number } }).details.maximum).toBe(100)
  })

  it('非整数参数 400', async () => {
    expect((await call('/api/v1/hackernews/search?hitsPerPage=abc')).status).toBe(400)
  })

  it('路径 id 非法 400', async () => {
    const res = await call('/api/v1/hackernews/item/not-a-number')
    expect(res.status).toBe(400)
    expect(((await res.json()) as { code: string }).code).toBe('INVALID_PARAMETER')
  })
})

describe('凭据与队列降级', () => {
  it('未配置 se.key 时返回 PROVIDER_UNCONFIGURED', async () => {
    const res = await call('/api/v1/stackexchange/question/123')
    expect(res.status).toBe(503)
    const body = (await res.json()) as { code: string; details: { setting: string } }
    expect(body.code).toBe('PROVIDER_UNCONFIGURED')
    expect(body.details.setting).toBe('se.key')
    expect(seQuestions.calls).toBe(0)
  })

  it('配置 se.key 后透传上游，并带上 key 与 site', async () => {
    await putSettings(env, { 'se.key': 'TESTKEY' })
    clearSettingsMemo()

    const res = await call('/api/v1/stackexchange/question/123?site=stackoverflow')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ items: [{ question_id: 123, title: 'hello' }] })
    expect(seQuestions.urls[0]).toContain('key=TESTKEY')
    expect(seQuestions.urls[0]).toContain('site=stackoverflow')

    await putSettings(env, { 'se.key': '' })
    clearSettingsMemo()
  })

  it('关闭内联回源后走队列：503 REBUILDING，Prefer 头则 202', async () => {
    await putSettings(env, { 'cache.inline': 'off' })
    clearSettingsMemo()

    const first = await call('/api/v1/hackernews/item/999')
    expect(first.status).toBe(503)
    expect(first.headers.get('x-cache')).toBe('QUEUED')
    expect(first.headers.get('retry-after')).toBe('1')

    const second = await call('/api/v1/hackernews/item/999', {
      headers: { prefer: 'respond-async' },
    })
    expect(second.status).toBe(202)
    expect(((await second.json()) as { code: string }).code).toBe('ACCEPTED')

    await putSettings(env, { 'cache.inline': 'on' })
    clearSettingsMemo()
  })
})

describe('请求头与 CORS', () => {
  it('透传合法的 X-Request-ID，非法值被替换', async () => {
    const kept = await call('/', { headers: { 'x-request-id': 'trace-abc.1' } })
    expect(kept.headers.get('x-request-id')).toBe('trace-abc.1')

    const replaced = await call('/', { headers: { 'x-request-id': 'bad id with spaces' } })
    expect(replaced.headers.get('x-request-id')).toMatch(/[0-9a-f-]{36}/)
  })

  it('预检返回 204 与白名单相关头', async () => {
    const res = await call('/api/v1/hackernews/search', {
      method: 'OPTIONS',
      headers: { origin: 'https://example.com' },
    })
    expect(res.status).toBe(204)
    expect(res.headers.get('access-control-allow-origin')).toBe('https://example.com')
    expect(res.headers.get('access-control-max-age')).toBe('86400')
    expect(res.headers.get('vary')).toBe('Origin')
  })

  it('限流响应头齐全', async () => {
    const res = await call('/api/v1/hackernews/search?q=headers')
    expect(res.headers.get('ratelimit-policy')).toMatch(/^\d+;w=1$/)
    expect(res.headers.get('x-ratelimit-limit')).toBe('60')
    expect(res.headers.get('ratelimit')).toMatch(/^r=\d+;t=\d+$/)
  })
})

describe('管理端点', () => {
  it('缺少或错误 token 一律 401', async () => {
    expect((await call('/admin/settings')).status).toBe(401)
    const wrong = await call('/admin/settings', { headers: { authorization: 'Bearer nope' } })
    expect(wrong.status).toBe(401)
    expect(((await wrong.json()) as { code: string }).code).toBe('UNAUTHORIZED')
  })

  it('凭据类设置读取时脱敏', async () => {
    await putSettings(env, { 'jina.key': 'super-secret' })
    const body = (await (await call('/admin/settings', { headers: ADMIN })).json()) as {
      settings: Record<string, string>
    }
    expect(body.settings['jina.key']).toBe('***set***')
    expect(body.settings['ratelimit.rpm']).toBe('60')
  })

  it('非法设置键被拒', async () => {
    const res = await call('/admin/settings', {
      method: 'PUT',
      headers: { ...ADMIN, 'content-type': 'application/json' },
      body: JSON.stringify({ 'bad key!': 'x' }),
    })
    expect(res.status).toBe(400)
  })

  it('providers 列表带 allowlist 与配置状态', async () => {
    const body = (await (await call('/admin/providers', { headers: ADMIN })).json()) as {
      allowlist: string[]
      providers: { name: string; configured: boolean }[]
    }
    expect(body.allowlist).toContain('hn.algolia.com')
    expect(body.providers.find((p) => p.name === 'hackernews')?.configured).toBe(true)
  })

  it('rebuild 会清理缓存并入队', async () => {
    const res = await call('/admin/rebuild', {
      method: 'POST',
      headers: { ...ADMIN, 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'hackernews', op: 'item', id: '42' }),
    })
    const body = (await res.json()) as { key: string; queued: boolean }
    expect(body.key).toBe('v1:hackernews:item:42:q')
    expect(body.queued).toBe(true)
  })

  it('kill 会冻结 provider 闸门', async () => {
    const res = await call('/admin/kill?provider=hackernews&minutes=5', { method: 'POST', headers: ADMIN })
    const body = (await res.json()) as { until: string }
    expect(new Date(body.until).getTime()).toBeGreaterThan(Date.now())
  })
})
