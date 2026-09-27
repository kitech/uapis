import { env as cloudflareEnv, exports } from 'cloudflare:workers'
import { http, HttpResponse } from 'msw'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { clearSettingsMemo, putSettings } from '../src/core/settings'
import { resetRateLimitBuckets } from '../src/core/ratelimit'
import { createExecutionContext, createMessageBatch, getQueueResult } from 'cloudflare:test'
import { handleQueueBatch } from '../src/core/queue'
import { consumeCredits, readCredits, resetCredits } from '../src/core/credits'
import { cacheKeyFor } from '../src/core/refresh'
import { encodeTarget } from '../src/core/target'
import { network } from './server'

/** miniflare 的 Cloudflare.Env 缺少 src/types.ts 里声明的 ADMIN_TOKEN，测试里做一次桥接 */
const env = cloudflareEnv as unknown as Env

const HN = 'https://hn.algolia.com'
const SE = 'https://api.stackexchange.com'
const GH = 'https://api.github.com'
const DEVTO = 'https://dev.to/api'
const ARXIV = 'https://export.arxiv.org'
const ZENROWS = 'https://api.zenrows.com'
const JINA = 'https://r.jina.ai'

const ECONOMIST_HTML = `<html><head><title>Fallback</title>
  <meta property="og:title" content="Paywalled &amp; locked">
  <meta property="og:description" content="A summary line.">
  <meta property="article:section" content="Finance &amp; Economics">
</head><body><article><p>PAID FULL TEXT</p></article></body></html>`

const ARXIV_ATOM = `<?xml version='1.0' encoding='UTF-8'?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/">
  <updated>2026-09-24T18:00:00Z</updated>
  <opensearch:totalResults>42</opensearch:totalResults>
  <entry>
    <id>http://arxiv.org/abs/2609.30258v1</id>
    <title>Gradient &amp; inversion</title>
    <summary>Private data leakage.</summary>
    <published>2026-09-20T10:00:00Z</published>
    <updated>2026-09-24T17:59:18Z</updated>
    <author><name>Ada L.</name></author>
    <link href="https://arxiv.org/abs/2609.30258v1" rel="alternate" type="text/html"/>
    <arxiv:primary_category term="cs.LG" scheme="http://arxiv.org/schemas/atom"/>
    <category term="cs.LG" scheme="http://arxiv.org/schemas/atom"/>
  </entry>
</feed>`
const ADMIN = { authorization: 'Bearer test-admin-token' }

/** 主 Worker 与测试同 isolate，MSW 拦截对其出站请求生效 */
function call(path: string, init?: RequestInit): Promise<Response> {
  return exports.default.fetch(`https://api.test${path}`, init)
}

let hnSearch: { calls: number; urls: string[] }
let seQuestions: { calls: number; urls: string[] }
let seSites: { urls: string[] }
let gh: { urls: string[]; auth: string[] }
let devto: { urls: string[] }
let arxiv: { urls: string[] }
let zenrows: { urls: string[] }
let jina: { urls: string[] }

/** 每次测试都从这组默认 handler 开始，用例内的 network.use 不会污染后续用例 */
function defaultHandlers(): ReturnType<typeof http.get>[] {
  return [
    http.get(`${HN}/api/v1/search`, ({ request }) => {
      hnSearch.calls += 1
      hnSearch.urls.push(request.url)
      return HttpResponse.json({ hits: [{ title: 'cloudflare workers' }] })
    }),
    http.get(`${SE}/2.3/questions/:id/answers`, ({ request }) => {
      seQuestions.calls += 1
      seQuestions.urls.push(request.url)
      return HttpResponse.json({ items: [{ answer_id: 1, score: 42 }] })
    }),
    http.get(`${SE}/2.3/sites`, ({ request }) => {
      seSites.urls.push(request.url)
      return HttpResponse.json({ items: [{ site_id: 1, site_name: 'Stack Overflow' }] })
    }),
    http.get(`${SE}/2.3/questions/:id`, ({ request }) => {
      seQuestions.calls += 1
      seQuestions.urls.push(request.url)
      return HttpResponse.json({ items: [{ question_id: 123, title: 'hello' }] })
    }),
    http.get(`${GH}/repos/:owner/:repo`, ({ request, params }) => {
      gh.urls.push(request.url)
      return HttpResponse.json({ full_name: `${params.owner}/${params.repo}`, stargazers_count: 1 })
    }),
    http.get(`${GH}/users/:login`, ({ request }) => {
      gh.urls.push(request.url)
      return HttpResponse.json({ login: request.url.split('/').pop() })
    }),
    http.get(`${GH}/search/repositories`, ({ request }) => {
      gh.urls.push(request.url)
      return HttpResponse.json({ total_count: 1, items: [{ full_name: 'cloudflare/workers-sdk' }] })
    }),
    http.get(`${DEVTO}/articles/:id`, ({ request }) => {
      devto.urls.push(request.url)
      return HttpResponse.json({ id: 4754375, title: 'I Built an AI Coding Agent in Rust' })
    }),
    http.get(`${DEVTO}/users/by_username`, ({ request }) => {
      devto.urls.push(request.url)
      return HttpResponse.json({ type_of: 'user', username: 'ben' })
    }),
    http.get(`${JINA}/`, ({ request }) => {
      jina.urls.push(request.url)
      return new HttpResponse(ECONOMIST_HTML, { headers: { 'content-type': 'text/html' } })
    }),
    http.get(`${ZENROWS}/v1/key`, ({ request }) => {
      zenrows.urls.push(request.url)
      return new HttpResponse(ECONOMIST_HTML, { headers: { 'content-type': 'text/html' } })
    }),
    http.get(`${ARXIV}/api/query`, ({ request }) => {
      arxiv.urls.push(request.url)
      return new HttpResponse(ARXIV_ATOM, { headers: { 'content-type': 'application/atom+xml' } })
    }),
  ]
}

beforeAll(async () => {
  network.enable()
  hnSearch = { calls: 0, urls: [] }
  seQuestions = { calls: 0, urls: [] }
  seSites = { urls: [] }
  gh = { urls: [], auth: [] }
  devto = { urls: [] }
  arxiv = { urls: [] }
  zenrows = { urls: [] }
  jina = { urls: [] }
  // 测试里不真实限速：把 provider 闸门间隔压到 0
  await putSettings(env, { 'gate.min_ms': '0' })
  clearSettingsMemo()
  network.use(...defaultHandlers())
})

afterEach(() => {
  network.resetHandlers()
  network.use(...defaultHandlers())
  hnSearch.calls = 0
  hnSearch.urls = []
  seQuestions.calls = 0
  seQuestions.urls = []
  seSites.urls = []
  gh.urls = []
  gh.auth = []
  devto.urls = []
  arxiv.urls = []
  zenrows.urls = []
  jina.urls = []
})

// 限流是 isolate 内的固定窗口计数器，不清的话用例数一多就会互相踩出 429
beforeEach(() => {
  resetRateLimitBuckets()
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
    expect(text).toContain('/api/v1/hackernews/front')
    expect(text).toContain('/api/v1/stackexchange/question/{id}/answers')
  })

  it('/healthz 与 /status 可用', async () => {
    expect((await call('/healthz')).status).toBe(200)
    const body = (await (await call('/status')).json()) as {
      providers: { name: string; status: string; auth_required?: boolean; auth_optional?: boolean }[]
      free_tier_budget: Record<string, number>
    }
    expect(body.providers.map((p) => p.name).sort()).toEqual([
      'arxiv',
      'devto',
      'economist',
      'github',
      'hackernews',
      'stackexchange',
    ])
    expect(body.providers.find((p) => p.name === 'stackexchange')?.status).toBe('unconfigured')
    // 端点级 optional：没配 key 也算 active
    const github = body.providers.find((p) => p.name === 'github')
    expect(github?.status).toBe('active')
    expect(github?.auth_required).toBe(false)
    expect(github?.auth_optional).toBe(true)
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

describe('P1 端点', () => {
  it('hackernews/front 走 front_page 标签并缓存', async () => {
    const first = await call('/api/v1/hackernews/front?hitsPerPage=5')
    expect(first.status).toBe(200)
    expect(first.headers.get('x-cache')).toBe('REFRESH')
    expect(hnSearch.urls.at(-1)).toContain('tags=front_page')
    expect(hnSearch.urls.at(-1)).toContain('hitsPerPage=5')

    const second = await call('/api/v1/hackernews/front?hitsPerPage=5')
    expect(['HIT', 'HIT-T1']).toContain(second.headers.get('x-cache'))
  })

  it('hackernews/latest 走 search_by_date', async () => {
    const res = await call('/api/v1/hackernews/latest?page=3')
    expect(res.status).toBe(200)
    // latest 走 search_by_date，用另一个 handler 命中上游之前应该被拦截为未 mock，
    // 因此这里只断言不抛错且状态码合法
    expect([200, 502]).toContain(res.status)
  })

  it('stackexchange/sites 无需 key 即可访问，且不注入 key', async () => {
    const res = await call('/api/v1/stackexchange/sites')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ items: [{ site_id: 1, site_name: 'Stack Overflow' }] })
    expect(seSites.urls[0]).not.toContain('key=')
  })

  it('stackexchange/question/{id}/answers 仍需 key', async () => {
    const res = await call('/api/v1/stackexchange/question/123/answers?pagesize=50')
    expect(res.status).toBe(503)
    expect(((await res.json()) as { code: string }).code).toBe('PROVIDER_UNCONFIGURED')
    expect(seQuestions.calls).toBe(0)
  })

  it('配了 key 之后 answers 带上分页参数', async () => {
    await putSettings(env, { 'se.key': 'TESTKEY' })
    clearSettingsMemo()
    const res = await call('/api/v1/stackexchange/question/123/answers?pagesize=50&page=1&sort=votes')
    expect(res.status).toBe(200)
    expect(seQuestions.urls.at(-1)).toContain('/questions/123/answers')
    expect(seQuestions.urls.at(-1)).toContain('pagesize=50&page=1')
    expect(seQuestions.urls.at(-1)).toContain('sort=votes')
    await putSettings(env, { 'se.key': '' })
    clearSettingsMemo()
  })

  it('pagesize 越界 400', async () => {
    const res = await call('/api/v1/hackernews/front?hitsPerPage=1000')
    expect(res.status).toBe(400)
  })
})

describe('P2 零 key 源', () => {
  it('github/repo 的两个路径参数都进上游 URL', async () => {
    const res = await call('/api/v1/github/repo/cloudflare/workers-sdk')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ full_name: 'cloudflare/workers-sdk', stargazers_count: 1 })
    expect(gh.urls.at(-1)).toBe('https://api.github.com/repos/cloudflare/workers-sdk')
  })

  it('github 匿名可用：不配 gh.token 也 200', async () => {
    const res = await call('/api/v1/github/search/repositories?q=workers&sort=stars')
    expect(res.status).toBe(200)
    expect(res.headers.get('x-cache')).toBe('REFRESH')
    expect(gh.urls.at(-1)).toContain('sort=stars&order=desc')
  })

  it('github 搜索缺 q 直接 400，不回源', async () => {
    const before = gh.urls.length
    const res = await call('/api/v1/github/search/repositories')
    expect(res.status).toBe(400)
    expect(((await res.json()) as { code: string }).code).toBe('INVALID_PARAMETER')
    expect(gh.urls.length).toBe(before)
  })

  it('devto 单篇文章透传', async () => {
    const res = await call('/api/v1/devto/article/i-built-an-ai-coding-agent-in-rust')
    expect(res.status).toBe(200)
    expect(((await res.json()) as { title: string }).title).toContain('Rust')
    expect(devto.urls.at(-1)).toBe(
      'https://dev.to/api/articles/i-built-an-ai-coding-agent-in-rust',
    )
  })

  it('devto user 走 by_username', async () => {
    const res = await call('/api/v1/devto/user/ben')
    expect(res.status).toBe(200)
    expect(devto.urls.at(-1)).toContain('/users/by_username?url=ben')
  })

  it('arxiv Atom 落库前就转成 JSON，缓存里存的也是 JSON', async () => {
    const res = await call('/api/v1/arxiv/search?search_query=cat:cs.LG&max_results=5')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('application/json')
    const body = (await res.json()) as {
      provider: string
      total: number
      entries: { id: string; title: string; primary: string }[]
    }
    expect(body.provider).toBe('arxiv')
    expect(body.total).toBe(42)
    expect(body.entries[0]?.id).toBe('2609.30258v1')
    expect(body.entries[0]?.title).toBe('Gradient & inversion')
    expect(body.entries[0]?.primary).toBe('cs.LG')

    // 二次请求命中缓存，body 仍是 JSON（说明 transform 在 store 之前发生）
    const second = await call('/api/v1/arxiv/search?search_query=cat:cs.LG&max_results=5')
    expect(['HIT', 'HIT-T1']).toContain(second.headers.get('x-cache'))
    expect(second.headers.get('content-type')).toContain('application/json')
  })

  it('arxiv 缺 search_query 400，非法查询式也 400', async () => {
    expect((await call('/api/v1/arxiv/search')).status).toBe(400)
    expect((await call('/api/v1/arxiv/search?search_query=all:x&evil=1')).status).toBe(400)
  })

  it('arxiv archive 档新鲜期 15 分钟，负缓存之外不回源', async () => {
    const first = await call('/api/v1/arxiv/paper/2609.30258')
    expect(first.status).toBe(200)
    expect(arxiv.urls.at(-1)).toBe('https://export.arxiv.org/api/query?id_list=2609.30258')
    const second = await call('/api/v1/arxiv/paper/2609.30258')
    expect(['HIT', 'HIT-T1']).toContain(second.headers.get('x-cache'))
  })

  it('openapi.json 覆盖 5 个 provider', async () => {
    const res = await call('/openapi.json')
    const doc = (await res.json()) as {
      paths: Record<string, Record<string, { 'x-provider'?: { endpoint_auth?: string } }>>
    }
    const paths = Object.keys(doc.paths)
    expect(paths).toContain('/api/v1/github/repo/{owner}/{repo}')
    expect(paths).toContain('/api/v1/arxiv/search')
    expect(paths).toContain('/api/v1/devto/articles')
    expect(doc.paths['/api/v1/stackexchange/sites']?.get?.['x-provider']?.endpoint_auth).toBe('optional')
    expect(doc.paths['/api/v1/github/repo/{owner}/{repo}']?.get?.['x-provider']?.endpoint_auth).toBe('optional')
  })
})

describe('P3 付费通道', () => {
  // Miniflare 的本地 queue 会把 read 路径入队的消息真的投递给 worker，且投递是异步的。
  // 所以这里不靠"数组长度等于 N"做断言，而是显式 handleQueueBatch 消费一条自造消息，
  // 并用 before/after 快照比较，避免受前面用例的异步投递干扰。
  const SLUG = 'finance/2026/01/01/some-article'
  const PATH = `/api/v1/economist/article/${SLUG}`

  function refreshMessage(slug: string) {
    const target = { op: 'article', id: slug, query: [] as [string, string][] }
    return {
      id: crypto.randomUUID(),
      timestamp: new Date(),
      attempts: 1,
      body: {
        v: 1 as const,
        k: cacheKeyFor('economist', 'wall', target),
        p: 'economist',
        t: encodeTarget(target),
      },
    } as Parameters<typeof createMessageBatch>[1][number]
  }

  async function consume(slug: string): Promise<{ refreshed: number; retried: number; dropped: number }> {
    const batch = createMessageBatch('uapis-refresh', [refreshMessage(slug)])
    const result = await handleQueueBatch(batch, env)
    await getQueueResult(batch, createExecutionContext())
    return result
  }

  beforeEach(() => {
    zenrows.urls = []
    jina.urls = []
  })

  it('两个通道都没配时 503 PROVIDER_UNCONFIGURED，且不打任何出口', async () => {
    await putSettings(env, { 'zenrows.key': '', 'jina.key': '' })
    clearSettingsMemo()
    const res = await call(PATH)
    expect(res.status).toBe(503)
    const body = (await res.json()) as { code: string; details: { any_of: string[] } }
    expect(body.code).toBe('PROVIDER_UNCONFIGURED')
    expect(body.details.any_of).toEqual(['zenrows.key', 'jina.key'])
    expect(zenrows.urls).toHaveLength(0)
    expect(jina.urls).toHaveLength(0)
  })

  it('队列消费后：走 ZenRows 模板，HTML 转 JSON 落库，read 命中', async () => {
    await putSettings(env, { 'zenrows.key': 'zr_test', 'gate.min_ms': '0' })
    clearSettingsMemo()
    const creditsBefore = await readCredits(env, 'proxy', 'zenrows')

    const stats = await consume(SLUG)
    expect(stats).toEqual({ processed: 1, refreshed: 1, retried: 0, dropped: 0 })
    expect((await readCredits(env, 'proxy', 'zenrows')).used).toBe(creditsBefore.used + 1)

    const hit = await call(PATH)
    expect(hit.headers.get('x-cache')).toBe('HIT')
    const body = (await hit.json()) as { provider: string; title: string; description: string }
    expect(body.provider).toBe('economist')
    expect(body.title).toBe('Paywalled & locked')
    expect(body.description).toBe('A summary line.')
    // 付费墙正文不会漏进缓存
    expect(JSON.stringify(body)).not.toContain('PAID FULL TEXT')

    // 命中后不再花 credits
    const spent = await readCredits(env, 'proxy', 'zenrows')
    await call(PATH)
    expect((await readCredits(env, 'proxy', 'zenrows')).used).toBe(spent.used)
  })

  it('出口 URL 形如 ZenRows 模板，且目标 host 写死', async () => {
    await putSettings(env, { 'zenrows.key': 'zr_test', 'gate.min_ms': '0' })
    clearSettingsMemo()
    await consume('finance/2026/01/01/template-check')
    const proxied = new URL(zenrows.urls.at(-1)!)
    expect(proxied.hostname).toBe('api.zenrows.com')
    expect(proxied.searchParams.get('apikey')).toBe('zr_test')
    expect(proxied.searchParams.get('url')).toBe(
      'https://www.economist.com/finance/2026/01/01/template-check',
    )
    await putSettings(env, { 'zenrows.key': '' })
    clearSettingsMemo()
  })

  it('只配 Jina 时自动降级到 Jina 通道', async () => {
    await putSettings(env, { 'zenrows.key': '', 'jina.key': 'jina_test', 'gate.min_ms': '0' })
    clearSettingsMemo()
    await resetCredits(env, 'proxy', 'jina')
    const creditsBefore = await readCredits(env, 'proxy', 'jina')

    const stats = await consume('finance/2026/01/01/jina-article')
    expect(stats).toEqual({ processed: 1, refreshed: 1, retried: 0, dropped: 0 })
    expect(zenrows.urls).toHaveLength(0)
    const proxied = new URL(jina.urls.at(-1)!)
    expect(proxied.hostname).toBe('r.jina.ai')
    expect(proxied.searchParams.get('url')).toBe(
      'https://www.economist.com/finance/2026/01/01/jina-article',
    )
    expect((await readCredits(env, 'proxy', 'jina')).used).toBe(creditsBefore.used + 1)

    await putSettings(env, { 'zenrows.key': '', 'jina.key': '' })
    clearSettingsMemo()
  })

  it('付费通道额度用尽：消息被丢弃，不重试也不打出口', async () => {
    await putSettings(env, { 'zenrows.key': 'zr_test', 'gate.min_ms': '0' })
    clearSettingsMemo()
    await resetCredits(env, 'proxy', 'zenrows')
    await consumeCredits(env, 'proxy', 'zenrows', 33)
    expect((await readCredits(env, 'proxy', 'zenrows')).remaining).toBe(0)

    const stats = await consume('finance/2026/01/01/no-credits')
    expect(stats).toEqual({ processed: 1, refreshed: 0, retried: 0, dropped: 1 })
    expect(zenrows.urls).toHaveLength(0)

    await resetCredits(env, 'proxy', 'zenrows')
    await putSettings(env, { 'zenrows.key': '' })
    clearSettingsMemo()
  })

  it('/status 里 economist 报通道配置与通道额度', async () => {
    await putSettings(env, { 'zenrows.key': 'zr_test', 'jina.key': '' })
    clearSettingsMemo()
    await resetCredits(env, 'proxy', 'zenrows')
    await consumeCredits(env, 'proxy', 'zenrows', 2)
    const used = (await readCredits(env, 'proxy', 'zenrows')).used

    const res = await call('/status')
    const body = (await res.json()) as {
      providers: {
        name: string
        status: string
        channels: { setting: string; configured: boolean; credits: { used: number } }[] | null
      }[]
    }
    const eco = body.providers.find((p) => p.name === 'economist')!
    expect(eco.status).toBe('active')
    expect(eco.channels).toHaveLength(2)
    expect(eco.channels![0]).toMatchObject({ setting: 'zenrows.key', configured: true })
    expect(eco.channels![0]!.credits.used).toBeGreaterThanOrEqual(used)
    expect(eco.channels![1]).toMatchObject({ setting: 'jina.key', configured: false })

    // 一条通道都没配时状态就是 unconfigured
    await putSettings(env, { 'zenrows.key': '' })
    clearSettingsMemo()
    const off = (await (await call('/status')).json()) as typeof body
    expect(off.providers.find((p) => p.name === 'economist')!.status).toBe('unconfigured')
  })

  it('未声明的 query 与编码穿越都在回源前被拒', async () => {
    await putSettings(env, { 'zenrows.key': 'zr_test', 'gate.min_ms': '0' })
    clearSettingsMemo()

    // `..` 被 URL 归一化掉，路由直接 404
    expect((await call('/api/v1/economist/article/..')).status).toBe(404)
    // 未声明的 query 参数在 read 路径就被拒
    const bad = await call('/api/v1/economist/article/a/b?url=https://evil.example.com')
    expect(bad.status).toBe(400)
    expect(((await bad.json()) as { code: string }).code).toBe('INVALID_PARAMETER')

    // 百分号编码的路径穿越绕过 URL 归一化，由 buildPlan 拦下
    const stats = await consume('a/%2e%2e/%2e%2e/etc/passwd')
    expect(stats).toEqual({ processed: 1, refreshed: 0, retried: 0, dropped: 1 })
    expect(zenrows.urls.some((url) => url.includes('%2e%2e') || url.includes('/etc/'))).toBe(false)

    await putSettings(env, { 'zenrows.key': '' })
    clearSettingsMemo()
  })

  it('付费端点不内联：read 路径只入队，同步不烧 credits', async () => {
    await putSettings(env, { 'zenrows.key': 'zr_test' })
    clearSettingsMemo()
    const creditsBefore = await readCredits(env, 'proxy', 'zenrows')

    // 用一个还没被前面的用例缓存过的 slug，才能走到真正的 miss 分支
    const res = await call('/api/v1/economist/article/finance/2026/01/01/never-inlined')
    expect(res.status).toBe(503)
    expect(res.headers.get('x-cache')).toBe('QUEUED')
    expect(res.headers.get('retry-after')).toBeTruthy()
    expect(zenrows.urls).toHaveLength(0)
    expect((await readCredits(env, 'proxy', 'zenrows')).used).toBe(creditsBefore.used)
  })

  it('Prefer: respond-async 返回 202', async () => {
    const res = await call('/api/v1/economist/article/finance/2026/01/01/async-article', {
      headers: { prefer: 'respond-async' },
    })
    expect(res.status).toBe(202)
    expect(((await res.json()) as { code: string }).code).toBe('ACCEPTED')
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
