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
const LOBSTERS = 'https://lobste.rs'
const ITUNES = 'https://itunes.apple.com'
const CROSSREF = 'https://api.crossref.org'
const PYPI = 'https://pypi.org'
const NPM = 'https://registry.npmjs.org'
const EUTILS = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils'
const USGS = 'https://earthquake.usgs.gov'
const GITLAB = 'https://gitlab.com'
const CRATES = 'https://crates.io'

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
let lobsters: { urls: string[] }
let itunes: { urls: string[] }
let crossref: { urls: string[] }
let pypi: { urls: string[] }
let npm: { urls: string[] }
let eutils: { urls: string[] }
let usgs: { urls: string[] }
let gitlab: { urls: string[] }
let crates: { urls: string[] }

/** 每次测试都从这组默认 handler 开始，用例内的 network.use 不会污染后续用例 */
function defaultHandlers(): ReturnType<typeof http.get>[] {
  return [
    http.get(`${HN}/api/v1/search`, ({ request }) => {
      hnSearch.calls += 1
      hnSearch.urls.push(request.url)
      return HttpResponse.json({ hits: [{ title: 'cloudflare workers' }] })
    }),
    // hackernews/latest 之前没 mock，靠真实网络才 200，CI 无网就 502
    // 单条 item：入队类用例（关闭内联回源）会被队列消费者真的回源一次，
    // 没有这个 handler 就会漏到真实网络，每个后续用例平白卡 5s
    http.get(`${HN}/api/v1/items/:id`, ({ params }) =>
      HttpResponse.json({ id: Number(params.id), title: `HN item ${String(params.id)}`, type: 'story' }),
    ),
    http.get(`${HN}/api/v1/search_by_date`, ({ request }) => {
      hnSearch.calls += 1
      hnSearch.urls.push(request.url)
      return HttpResponse.json({ hits: [{ title: 'latest story' }] })
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
    http.get(`${LOBSTERS}/hottest.json`, ({ request }) => {
      lobsters.urls.push(request.url)
      return HttpResponse.json([{ short_id: 'uvmajz', title: 'A hot story', tags: ['rust'] }])
    }),
    http.get(`${LOBSTERS}/newest.json`, ({ request }) => {
      lobsters.urls.push(request.url)
      return HttpResponse.json([{ short_id: 'newest1', title: 'A newest story', tags: [] }])
    }),
    http.get(`${LOBSTERS}/t/:tag.json`, ({ request, params }) => {
      lobsters.urls.push(request.url)
      return HttpResponse.json([{ short_id: 'tagged1', title: `tagged ${String(params.tag)}` }])
    }),
    http.get(`${LOBSTERS}/s/:id.json`, ({ request, params }) => {
      lobsters.urls.push(request.url)
      return HttpResponse.json({ short_id: params.id, title: 'A single story', comments: [] })
    }),
    http.get(`${ITUNES}/search`, ({ request }) => {
      itunes.urls.push(request.url)
      return HttpResponse.json({ resultCount: 1, results: [{ collectionId: 1765470838, kind: 'podcast' }] })
    }),
    http.get(`${ITUNES}/lookup`, ({ request }) => {
      itunes.urls.push(request.url)
      return HttpResponse.json({ resultCount: 1, results: [{ collectionId: 1765470838 }] })
    }),
    http.get(`${CROSSREF}/works`, ({ request }) => {
      crossref.urls.push(request.url)
      return HttpResponse.json({ status: 'ok', 'message-type': 'work-list', items: [] })
    }),
    http.get(`${PYPI}/pypi/:name/json`, ({ request, params }) => {
      pypi.urls.push(request.url)
      return HttpResponse.json({
        info: {
          name: params.name,
          version: '2.34.2',
          summary: 'Python HTTP for Humans.',
          description: 'README '.repeat(50),
          requires_python: '>=3.10',
          license: 'Apache-2.0',
          classifiers: ['Programming Language :: Python'],
        },
        last_serial: 37059094,
        releases: {
          '0.0.1': [{ filename: 'requests-0.0.1.tar.gz' }],
          '1.0.0': [{ filename: 'requests-1.0.0.tar.gz' }],
        },
        urls: [{ filename: 'requests-2.34.2-py3-none-any.whl', size: 65435, upload_time: '2026-05-14T19:25:27Z' }],
      })
    }),
    http.get(`${PYPI}/pypi/:name/:version/json`, ({ request, params }) => {
      pypi.urls.push(request.url)
      return HttpResponse.json({
        info: { name: params.name, version: params.version, summary: 'pinned release' },
        urls: [{ filename: 'requests-2.34.2-py3-none-any.whl', size: 65435 }],
      })
    }),
    http.get(`${NPM}/-/v1/search`, ({ request }) => {
      npm.urls.push(request.url)
      return HttpResponse.json({
        objects: [{ package: { name: 'react', version: '18.3.1' }, score: { final: 0.9 } }],
        total: 1,
      })
    }),
    http.get(/registry\.npmjs\.org\/(?:@[^/]+\/)?[^/]+\/(?:latest|[0-9][^/]*)$/, ({ request }) => {
      npm.urls.push(request.url)
      return HttpResponse.json({ name: 'react', version: '18.3.1', dist: { tarball: 'https://registry.npmjs.org/react/-/react-18.3.1.tgz' } })
    }),
    http.get(`${EUTILS}/esearch.fcgi`, ({ request }) => {
      eutils.urls.push(request.url)
      return HttpResponse.json({
        header: { type: 'esearch' },
        esearchresult: { count: 2, retmax: 2, retstart: 0, idlist: ['35369193', '32015575'], querytranslation: '"waf"[All Fields]' },
      })
    }),
    http.get(`${EUTILS}/esummary.fcgi`, ({ request }) => {
      eutils.urls.push(request.url)
      return HttpResponse.json({
        header: { type: 'esummary' },
        result: {
          uids: ['35369193'],
          '35369193': { uid: '35369193', title: 'A study', pubdate: '2022', source: 'Front Psychol' },
        },
      })
    }),
    // USGS 的 search 与 event 是同一个 /query 端点，靠 eventid 参数区分
    http.get(`${USGS}/fdsnws/event/1/query`, ({ request }) => {
      usgs.urls.push(request.url)
      const url = new URL(request.url)
      const feature = {
        type: 'Feature',
        id: url.searchParams.get('eventid') ?? 'ci41339847',
        properties: { mag: 4.7, place: '10 km N of Foo, CA', time: 1790510206410, status: 'reviewed', tsunami: 0, sig: 320, net: 'ci' },
        geometry: { type: 'Point', coordinates: [-121.5, 36.2, 8.3] },
      }
      if (url.searchParams.has('eventid')) return HttpResponse.json(feature)
      return HttpResponse.json({
        type: 'FeatureCollection',
        metadata: { generated: 1790511508000, count: 1 },
        features: [feature],
      })
    }),
    // GitLab：项目 id 在上游是单段 URL 编码形式（group%2Fsub%2Fproject）
    http.get(`${GITLAB}/api/v4/projects`, ({ request }) => {
      gitlab.urls.push(request.url)
      return HttpResponse.json([{ id: 1885018, name: 'rust', path_with_namespace: 'rust-lang/rust' }])
    }),
    http.get(`${GITLAB}/api/v4/projects/:id`, ({ request, params }) => {
      gitlab.urls.push(request.url)
      return HttpResponse.json({ id: 1885018, path_with_namespace: decodeURIComponent(String(params.id)) })
    }),
    http.get(`${GITLAB}/api/v4/projects/:id/repository/commits`, ({ request, params }) => {
      gitlab.urls.push(request.url)
      return HttpResponse.json([{ id: 'b373574e', short_id: 'b373574e', title: 'fix: borrow checker', project: decodeURIComponent(String(params.id)) }])
    }),
    http.get(`${CRATES}/api/v1/crates`, ({ request }) => {
      crates.urls.push(request.url)
      return HttpResponse.json({ crates: [{ id: 'serde', name: 'serde', max_version: '1.0.229', downloads: 100 }], meta: { total: 1 } })
    }),
    http.get(`${CRATES}/api/v1/crates/:name`, ({ request, params }) => {
      crates.urls.push(request.url)
      return HttpResponse.json({
        crate: { id: params.name, name: params.name, description: 'A generic serialization framework', max_version: '1.0.229', newest_version: '1.0.229', num_versions: 2, downloads: 100, repository: 'https://github.com/serde-rs/serde', categories: ['encoding'] },
        versions: [
          { num: '1.0.229', created_at: '2026-07-18T23:05:13Z', downloads: 900, yanked: false, license: 'MIT OR Apache-2.0', rust_version: '1.56', features: { derive: ['serde_derive'], std: [] }, links: { owners: '/api/v1/crates/serde/owners' }, audit_actions: { publish: null } },
          { num: '1.0.228', created_at: '2026-06-01T00:00:00Z', downloads: 10, yanked: true, features: { derive: ['serde_derive'] } },
        ],
        keywords: ['serde', 'serialization'],
      })
    }),
    http.get(`${CRATES}/api/v1/crates/:name/:version`, ({ request, params }) => {
      crates.urls.push(request.url)
      return HttpResponse.json({ version: { num: params.version, crate: params.name, downloads: 900, license: 'MIT OR Apache-2.0', features: { derive: ['serde_derive'] } } })
    }),
    // DOI 天然多段，MSW 的 `:doi{.+}` 匹配不到多段路径，用正则整段匹配
    http.get(/api\.crossref\.org\/works\/.+/, ({ request }) => {
      crossref.urls.push(request.url)
      const doi = new URL(request.url).pathname.replace('/works/', '')
      return HttpResponse.json({ status: 'ok', message: { DOI: doi, title: ['A study'] } })
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
  lobsters = { urls: [] }
  itunes = { urls: [] }
  crossref = { urls: [] }
  pypi = { urls: [] }
  npm = { urls: [] }
  eutils = { urls: [] }
  usgs = { urls: [] }
  gitlab = { urls: [] }
  crates = { urls: [] }
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
  lobsters.urls = []
  itunes.urls = []
  crossref.urls = []
  pypi.urls = []
  npm.urls = []
  eutils.urls = []
  usgs.urls = []
  gitlab.urls = []
  crates.urls = []
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
      'crossref',
      'crates',
      'devto',
      'economist',
      'github',
      'gitlab',
      'hackernews',
      'itunes',
      'lobsters',
      'npm',
      'pypi',
      'pubmed',
      'stackexchange',
      'usgs',
    ].sort())
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

describe('P4 新增零 key 源', () => {
  it('lobsters 四个端点都映射到官方 JSON 路径并透传', async () => {
    for (const [path, upstream] of [
      ['/api/v1/lobsters/hot', 'https://lobste.rs/hottest.json'],
      ['/api/v1/lobsters/newest', 'https://lobste.rs/newest.json'],
      ['/api/v1/lobsters/tag/rust', 'https://lobste.rs/t/rust.json'],
    ] as const) {
      const res = await call(path)
      expect(res.status).toBe(200)
      expect(lobsters.urls.at(-1)).toBe(upstream)
    }
    const body = (await (await call('/api/v1/lobsters/tag/rust')).json()) as {
      short_id: string
      title: string
    }[]
    expect(body[0]?.short_id).toBe('tagged1')
  })

  it('lobsters 单个故事走 /s/{short_id}.json', async () => {
    const res = await call('/api/v1/lobsters/story/uvmajz')
    expect(res.status).toBe(200)
    expect(lobsters.urls.at(-1)).toBe('https://lobste.rs/s/uvmajz.json')
  })

  it('lobsters 非法 tag/故事 id 在回源前 400', async () => {
    const before = lobsters.urls.length
    for (const path of [
      '/api/v1/lobsters/tag/Rust',
      '/api/v1/lobsters/tag/a%2Fb',
      '/api/v1/lobsters/story/AB!',
      '/api/v1/lobsters/story/..%2F..%2Fadmin',
    ]) {
      const res = await call(path)
      expect(res.status).toBe(400)
      expect(((await res.json()) as { code: string }).code).toBe('INVALID_PARAMETER')
    }
    expect(lobsters.urls.length).toBe(before)
  })

  it('itunes search 只放行白名单参数，term 里的 & 被编码', async () => {
    const res = await call(
      '/api/v1/itunes/search?term=AT%26T&media=podcast&country=JP&limit=50&offset=100&evil=1',
    )
    expect(res.status).toBe(400)
    expect(itunes.urls).toHaveLength(0)

    const ok = await call('/api/v1/itunes/search?term=AT%26T&media=podcast&country=JP&limit=50&offset=100')
    expect(ok.status).toBe(200)
    expect(itunes.urls.at(-1)).toBe(
      'https://itunes.apple.com/search?term=AT%26T&media=podcast&country=JP&limit=50&offset=100',
    )
    const body = (await ok.json()) as { resultCount: number; results: { collectionId: number }[] }
    expect(body.resultCount).toBe(1)
    expect(body.results[0]?.collectionId).toBe(1765470838)
  })

  it('itunes 非法 media / 缺 term / 非法 id 都是 400，不回源', async () => {
    const before = itunes.urls.length
    const cases = [
      '/api/v1/itunes/search?term=x&media=book',
      '/api/v1/itunes/search',
      '/api/v1/itunes/search?term=a%3Db',
      '/api/v1/itunes/lookup?id=1%20OR%201',
      '/api/v1/itunes/lookup',
      '/api/v1/itunes/search?term=x&limit=500',
    ]
    for (const path of cases) {
      const res = await call(path)
      expect(res.status).toBe(400)
      expect(((await res.json()) as { code: string }).code).toBe('INVALID_PARAMETER')
    }
    expect(itunes.urls.length).toBe(before)
  })

  it('itunes lookup 按 id 查，且二次请求命中缓存', async () => {
    const first = await call('/api/v1/itunes/lookup?id=1765470838&entity=podcastEpisode')
    expect(first.status).toBe(200)
    expect(itunes.urls.at(-1)).toBe(
      'https://itunes.apple.com/lookup?id=1765470838&country=US&limit=20&entity=podcastEpisode',
    )
    const hits = itunes.urls.length
    const second = await call('/api/v1/itunes/lookup?id=1765470838&entity=podcastEpisode')
    expect(['HIT', 'HIT-T1']).toContain(second.headers.get('x-cache'))
    expect(itunes.urls.length).toBe(hits)
  })

  it('crossref search 透传 query/filter/select/sort', async () => {
    const res = await call(
      '/api/v1/crossref/search?query=cloudflare%20waf&rows=5&sort=published&order=asc&filter=from-pub-date:2024-01-01&select=DOI,title',
    )
    expect(res.status).toBe(200)
    const url = new URL(crossref.urls.at(-1)!)
    expect(url.origin + url.pathname).toBe('https://api.crossref.org/works')
    expect(url.searchParams.get('query')).toBe('cloudflare waf')
    expect(url.searchParams.get('rows')).toBe('5')
    expect(url.searchParams.get('order')).toBe('asc')
    expect(url.searchParams.get('filter')).toBe('from-pub-date:2024-01-01')
    expect(url.searchParams.get('select')).toBe('DOI,title')
    expect(url.searchParams.get('mailto')).toBeNull()
  })

  it('crossref work 的 DOI 含斜杠，多段路由能命中', async () => {
    const res = await call('/api/v1/crossref/work/10.2172/2407272')
    expect(res.status).toBe(200)
    expect(crossref.urls.at(-1)).toBe('https://api.crossref.org/works/10.2172/2407272')
    const body = (await res.json()) as { message: { DOI: string } }
    expect(body.message.DOI).toBe('10.2172/2407272')
  })

  it('crossref.mailto 配了就进 polite pool，配错就当没配', async () => {
    // 注意：mailto 是服务端设置，不进缓存键，所以要用没被前一个用例缓存过的 DOI，
    // 否则直接命中缓存、看不到上游 URL 里的 mailto
    await putSettings(env, { 'crossref.mailto': 'me@example.com' })
    clearSettingsMemo()
    const polite = await call('/api/v1/crossref/work/10.1371/journal.pone.0000308')
    expect(polite.status).toBe(200)
    expect(crossref.urls.at(-1)).toBe(
      'https://api.crossref.org/works/10.1371/journal.pone.0000308?mailto=me%40example.com',
    )

    await putSettings(env, { 'crossref.mailto': 'nope' })
    clearSettingsMemo()
    const impolite = await call('/api/v1/crossref/search?query=waf&rows=1')
    expect(impolite.status).toBe(200)
    expect(new URL(crossref.urls.at(-1)!).searchParams.get('mailto')).toBeNull()

    await putSettings(env, { 'crossref.mailto': '' })
    clearSettingsMemo()
  })

  it('crossref 非法 DOI 与枚举在回源前 400', async () => {
    const before = crossref.urls.length
    for (const path of [
      '/api/v1/crossref/work/11.2172%2F2407272',
      '/api/v1/crossref/work/10.2172%2F..%2Fadmin',
      '/api/v1/crossref/work/10.2172%2Fa%20b',
      '/api/v1/crossref/search?query=x&sort=random',
      '/api/v1/crossref/search?query=x&select=DOI%7Cscript',
      '/api/v1/crossref/search',
    ]) {
      const res = await call(path)
      expect(res.status).toBe(400)
      expect(((await res.json()) as { code: string }).code).toBe('INVALID_PARAMETER')
    }
    expect(crossref.urls.length).toBe(before)
  })

  it('三个新源都是零 key：/status 里 active，且 host 已进白名单', async () => {
    const status = (await (await call('/status')).json()) as {
      providers: { name: string; status: string; auth_required?: boolean }[]
    }
    for (const name of ['lobsters', 'itunes', 'crossref']) {
      const entry = status.providers.find((p) => p.name === name)
      expect(entry?.status).toBe('active')
      expect(entry?.auth_required).toBe(false)
    }
    const admin = (await (await call('/admin/providers', { headers: ADMIN })).json()) as {
      allowlist: string[]
    }
    expect(admin.allowlist).toEqual(
      expect.arrayContaining(['lobste.rs', 'itunes.apple.com', 'api.crossref.org']),
    )
  })

  it('openapi.json 与 llms.txt 覆盖 9 个 provider', async () => {
    const doc = (await (await call('/openapi.json')).json()) as { paths: Record<string, unknown> }
    expect(Object.keys(doc.paths)).toEqual(
      expect.arrayContaining([
        '/api/v1/lobsters/hot',
        '/api/v1/lobsters/tag/{tag}',
        '/api/v1/lobsters/story/{id}',
        '/api/v1/itunes/search',
        '/api/v1/itunes/lookup',
        '/api/v1/crossref/search',
        '/api/v1/crossref/work/{doi}',
      ]),
    )
    const text = await (await call('/llms.txt')).text()
    expect(text).toContain('/api/v1/lobsters/hot')
    expect(text).toContain('/api/v1/itunes/search')
    expect(text).toContain('/api/v1/crossref/work/')
  })
})

describe('P5 包管理与文献检索源', () => {
  it('pypi project：落库前就裁掉 releases 与 README，缓存里也是瘦身后的 JSON', async () => {
    const res = await call('/api/v1/pypi/project/requests')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('application/json')
    const body = (await res.json()) as {
      provider: string
      name: string
      versions: string[]
      files: { filename: string; size: number }[]
      summary: string
    }
    expect(pypi.urls.at(-1)).toBe('https://pypi.org/pypi/requests/json')
    expect(body.provider).toBe('pypi')
    expect(body.summary).toBe('Python HTTP for Humans.')
    // releases 折叠成版本号数组，README 全文不进缓存
    expect(body.versions).toEqual(['0.0.1', '1.0.0'])
    expect(body.files[0]?.filename).toBe('requests-2.34.2-py3-none-any.whl')
    expect(JSON.stringify(body)).not.toContain('README README')
    expect(JSON.stringify(body)).not.toContain('"releases"')

    const second = await call('/api/v1/pypi/project/requests')
    expect(['HIT', 'HIT-T1']).toContain(second.headers.get('x-cache'))
    expect(second.headers.get('content-type')).toContain('application/json')
  })

  it('pypi release：固定版本原样透传', async () => {
    const res = await call('/api/v1/pypi/release/requests/2.34.2')
    expect(res.status).toBe(200)
    expect(pypi.urls.at(-1)).toBe('https://pypi.org/pypi/requests/2.34.2/json')
    const body = (await res.json()) as { info: { version: string } }
    expect(body.info.version).toBe('2.34.2')
  })

  it('pypi 非法包名/版本 400，且不打上游', async () => {
    const before = pypi.urls.length
    for (const path of [
      '/api/v1/pypi/project/..%2F..%2Fetc',
      '/api/v1/pypi/project/-bad',
      '/api/v1/pypi/project/req!uests',
      '/api/v1/pypi/release/requests/2.34.2%20bad',
      // latest 是 sdist/wheel 的文件名，不是 PEP 440 版本号
      '/api/v1/pypi/release/requests/latest',
    ]) {
      const res = await call(path)
      expect(res.status).toBe(400)
      expect(((await res.json()) as { code: string }).code).toBe('INVALID_PARAMETER')
    }
    expect(pypi.urls.length).toBe(before)
    // 多出来的一段直接没有路由（404），不是 400
    expect((await call('/api/v1/pypi/release/requests/2.34.2/extra')).status).toBe(404)
  })

  it('npm latest：scoped 包名多段路由能命中', async () => {
    const plain = await call('/api/v1/npm/latest/react')
    expect(plain.status).toBe(200)
    expect(npm.urls.at(-1)).toBe('https://registry.npmjs.org/react/latest')

    const scoped = await call('/api/v1/npm/latest/@types/node')
    expect(scoped.status).toBe(200)
    expect(npm.urls.at(-1)).toBe('https://registry.npmjs.org/@types/node/latest')
  })

  it('npm version：包名与版本按 @scope 边界拆开', async () => {
    const res = await call('/api/v1/npm/version/@types/node/26.6.3')
    expect(res.status).toBe(200)
    expect(npm.urls.at(-1)).toBe('https://registry.npmjs.org/@types/node/26.6.3')
  })

  it('npm search 只放行白名单参数', async () => {
    const bad = await call('/api/v1/npm/search?text=react&evil=1')
    expect(bad.status).toBe(400)
    expect(npm.urls).toHaveLength(0)

    const ok = await call('/api/v1/npm/search?text=%40types%2Fnode&size=5&sort=popularity')
    expect(ok.status).toBe(200)
    const url = new URL(npm.urls.at(-1)!)
    expect(url.origin + url.pathname).toBe('https://registry.npmjs.org/-/v1/search')
    expect(url.searchParams.get('text')).toBe('@types/node')
    expect(url.searchParams.get('size')).toBe('5')
    expect(url.searchParams.get('sort')).toBe('popularity')
  })

  it('npm 非法包名/版本 400，不回源', async () => {
    const before = npm.urls.length
    for (const path of [
      '/api/v1/npm/latest/React',
      '/api/v1/npm/latest/..%2F..%2Fetc',
      '/api/v1/npm/latest/@/pkg',
      '/api/v1/npm/version/react/18.3.1/extra',
      '/api/v1/npm/version/react/18.3.1%20bad',
      '/api/v1/npm/search?text=%3Cscript%3E',
    ]) {
      const res = await call(path)
      expect(res.status).toBe(400)
      expect(((await res.json()) as { code: string }).code).toBe('INVALID_PARAMETER')
    }
    expect(npm.urls.length).toBe(before)
  })

  it('pubmed search：esearch 只放行白名单参数', async () => {
    const res = await call('/api/v1/pubmed/search?term=cloudflare%20waf&retmax=5&sort=pub_date')
    expect(res.status).toBe(200)
    const url = new URL(eutils.urls.at(-1)!)
    expect(url.pathname).toBe('/entrez/eutils/esearch.fcgi')
    expect(url.searchParams.get('db')).toBe('pubmed')
    expect(url.searchParams.get('term')).toBe('cloudflare waf')
    expect(url.searchParams.get('retmode')).toBe('json')
    expect(url.searchParams.get('retmax')).toBe('5')
    expect(url.searchParams.get('sort')).toBe('pub_date')
    expect(url.searchParams.get('api_key')).toBeNull()
    const body = (await res.json()) as { esearchresult: { idlist: string[] } }
    expect(body.esearchresult.idlist).toEqual(['35369193', '32015575'])
  })

  it('pubmed summary：固定 version=2.0，PMID 逗号分隔', async () => {
    const res = await call('/api/v1/pubmed/summary?id=35369193,32015575')
    expect(res.status).toBe(200)
    const url = new URL(eutils.urls.at(-1)!)
    expect(url.pathname).toBe('/entrez/eutils/esummary.fcgi')
    expect(url.searchParams.get('id')).toBe('35369193,32015575')
    expect(url.searchParams.get('version')).toBe('2.0')
  })

  it('pubmed：空 term 与非法 PMID 一律 400（上游都是 200 + 错误体）', async () => {
    const before = eutils.urls.length
    for (const path of [
      '/api/v1/pubmed/search',
      '/api/v1/pubmed/search?term=%3Cscript%3E',
      '/api/v1/pubmed/summary?id=notanumber',
      '/api/v1/pubmed/summary?id=35369193,',
      '/api/v1/pubmed/summary',
      '/api/v1/pubmed/search?term=x&sort=nope',
    ]) {
      const res = await call(path)
      expect(res.status).toBe(400)
      expect(((await res.json()) as { code: string }).code).toBe('INVALID_PARAMETER')
    }
    expect(eutils.urls.length).toBe(before)
  })

  it('pubmed：配了 ncbi.api_key 才往上游带，且只在 eutils 出口', async () => {
    await putSettings(env, { 'ncbi.api_key': 'NCBI1234567890' })
    clearSettingsMemo()
    const res = await call('/api/v1/pubmed/search?term=keyed')
    expect(res.status).toBe(200)
    const url = new URL(eutils.urls.at(-1)!)
    expect(url.searchParams.get('api_key')).toBe('NCBI1234567890')
    expect(url.host).toBe('eutils.ncbi.nlm.nih.gov')
    // key 不进缓存键：换个 term 不该因为配了 key 就换维度
    expect(url.searchParams.get('term')).toBe('keyed')

    await putSettings(env, { 'ncbi.api_key': 'bad' })
    clearSettingsMemo()
    const unkeyed = await call('/api/v1/pubmed/search?term=unkeyed')
    expect(unkeyed.status).toBe(200)
    expect(new URL(eutils.urls.at(-1)!).searchParams.get('api_key')).toBeNull()
    await putSettings(env, { 'ncbi.api_key': '' })
    clearSettingsMemo()
  })

  it('/status 里 pubmed 报 auth_optional，pypi/npm 纯零 key', async () => {
    const body = (await (await call('/status')).json()) as {
      providers: { name: string; status: string; auth_optional?: boolean; auth_required?: boolean }[]
    }
    const pubmed = body.providers.find((p) => p.name === 'pubmed')!
    expect(pubmed.status).toBe('active')
    expect(pubmed.auth_required).toBe(false)
    expect(pubmed.auth_optional).toBe(true)
    for (const name of ['pypi', 'npm']) {
      const entry = body.providers.find((p) => p.name === name)!
      expect(entry.status).toBe('active')
      // auth_optional 是布尔字段：这两个源没声明 auth，等价于 false
      expect(entry.auth_optional).toBe(false)
    }
  })

  it('usgs search：固定 format=geojson，只放行 minmagnitude/limit/orderby', async () => {
    const res = await call('/api/v1/usgs/earthquakes')
    expect(res.status).toBe(200)
    const url = new URL(usgs.urls.at(-1)!)
    expect(url.pathname).toBe('/fdsnws/event/1/query')
    expect(url.searchParams.get('format')).toBe('geojson')
    expect(url.searchParams.get('minmagnitude')).toBe('2.5')
    expect(url.searchParams.get('limit')).toBe('20')
    expect(url.searchParams.get('orderby')).toBe('time')
    const body = (await res.json()) as { type: string; features: unknown[] }
    expect(body.type).toBe('FeatureCollection')
    expect(body.features).toHaveLength(1)

    const custom = await call('/api/v1/usgs/earthquakes?minmagnitude=4.5&limit=50&orderby=magnitude')
    expect(custom.status).toBe(200)
    const customUrl = new URL(usgs.urls.at(-1)!)
    expect(customUrl.searchParams.get('minmagnitude')).toBe('4.5')
    expect(customUrl.searchParams.get('limit')).toBe('50')
    expect(customUrl.searchParams.get('orderby')).toBe('magnitude')
  })

  it('usgs 非法震级/排序/limit 一律 400，不回源', async () => {
    const before = usgs.urls.length
    for (const path of [
      '/api/v1/usgs/earthquakes?minmagnitude=abc',
      '/api/v1/usgs/earthquakes?minmagnitude=-1',
      '/api/v1/usgs/earthquakes?minmagnitude=11',
      '/api/v1/usgs/earthquakes?limit=0',
      '/api/v1/usgs/earthquakes?limit=201',
      '/api/v1/usgs/earthquakes?orderby=depth',
      '/api/v1/usgs/earthquakes?minmagnitude=4&evil=1',
    ]) {
      const res = await call(path)
      expect(res.status).toBe(400)
      expect(((await res.json()) as { code: string }).code).toBe('INVALID_PARAMETER')
    }
    expect(usgs.urls.length).toBe(before)
  })

  it('usgs event：eventid 走 /query，非法 id 400', async () => {
    const res = await call('/api/v1/usgs/earthquakes/ci41339847')
    expect(res.status).toBe(200)
    const url = new URL(usgs.urls.at(-1)!)
    expect(url.searchParams.get('eventid')).toBe('ci41339847')
    expect(url.searchParams.get('format')).toBe('geojson')
    const body = (await res.json()) as { type: string; id: string }
    expect(body.type).toBe('Feature')
    expect(body.id).toBe('ci41339847')

    const before = usgs.urls.length
    for (const path of [
      '/api/v1/usgs/earthquakes/CI41339847',
      '/api/v1/usgs/earthquakes/ci-41339847',
      '/api/v1/usgs/earthquakes/ci_413',
      '/api/v1/usgs/earthquakes/ci4133984712345678901',
      '/api/v1/usgs/earthquakes/ci41339847%20bad',
      '/api/v1/usgs/earthquakes/..%2F..%2Fetc',
    ]) {
      const bad = await call(path)
      expect(bad.status).toBe(400)
      expect(((await bad.json()) as { code: string }).code).toBe('INVALID_PARAMETER')
    }
    expect(usgs.urls.length).toBe(before)
  })

  it('gitlab project：多层子组走多段路由，上游是单段 URL 编码', async () => {
    const flat = await call('/api/v1/gitlab/project/rust-lang/rust')
    expect(flat.status).toBe(200)
    expect(gitlab.urls.at(-1)).toBe('https://gitlab.com/api/v4/projects/rust-lang%2Frust')

    const deep = await call('/api/v1/gitlab/project/group/subgroup/project')
    expect(deep.status).toBe(200)
    expect(gitlab.urls.at(-1)).toBe('https://gitlab.com/api/v4/projects/group%2Fsubgroup%2Fproject')

    const numeric = await call('/api/v1/gitlab/project/1885018')
    expect(numeric.status).toBe(200)
    expect(gitlab.urls.at(-1)).toBe('https://gitlab.com/api/v4/projects/1885018')
  })

  it('gitlab project 非法路径 400，不回源', async () => {
    const before = gitlab.urls.length
    for (const path of [
      '/api/v1/gitlab/project/..%2F..%2Fetc',
      '/api/v1/gitlab/project/group%20name/project',
      '/api/v1/gitlab/project/-leading',
    ]) {
      const res = await call(path)
      expect(res.status).toBe(400)
      expect(((await res.json()) as { code: string }).code).toBe('INVALID_PARAMETER')
    }
    expect(gitlab.urls.length).toBe(before)
  })

  it('gitlab 搜索只放行白名单参数，默认按最近活动倒序', async () => {
    const bad = await call('/api/v1/gitlab/projects?q=rust&evil=1')
    expect(bad.status).toBe(400)
    expect(gitlab.urls).toHaveLength(0)

    const res = await call('/api/v1/gitlab/projects?q=rust%20wasm&limit=5&order_by=name&sort=asc')
    expect(res.status).toBe(200)
    const url = new URL(gitlab.urls.at(-1)!)
    expect(url.pathname).toBe('/api/v4/projects')
    expect(url.searchParams.get('search')).toBe('rust wasm')
    expect(url.searchParams.get('per_page')).toBe('5')
    expect(url.searchParams.get('simple')).toBe('true')
    expect(url.searchParams.get('order_by')).toBe('name')
    expect(url.searchParams.get('sort')).toBe('asc')

    const fallback = await call('/api/v1/gitlab/projects?q=rust')
    const fallbackUrl = new URL(gitlab.urls.at(-1)!)
    expect(fallbackUrl.searchParams.get('order_by')).toBe('last_activity_at')
    expect(fallbackUrl.searchParams.get('sort')).toBe('desc')
  })

  it('gitlab commits：项目走 query，ref 只在给了才带', async () => {
    const plain = await call('/api/v1/gitlab/commits?project=rust-lang%2Frust')
    expect(plain.status).toBe(200)
    const url = new URL(gitlab.urls.at(-1)!)
    expect(url.pathname).toBe('/api/v4/projects/rust-lang%2Frust/repository/commits')
    expect(url.searchParams.get('per_page')).toBe('20')
    expect(url.searchParams.get('ref_name')).toBeNull()

    const withRef = await call('/api/v1/gitlab/commits?project=rust-lang%2Frust&ref=main&limit=3')
    expect(withRef.status).toBe(200)
    const refUrl = new URL(gitlab.urls.at(-1)!)
    expect(refUrl.searchParams.get('ref_name')).toBe('main')
    expect(refUrl.searchParams.get('per_page')).toBe('3')
  })

  it('gitlab 非法 project/ref/排序 400，不回源', async () => {
    const before = gitlab.urls.length
    for (const path of [
      '/api/v1/gitlab/projects?q=',
      '/api/v1/gitlab/projects?q=%3Cscript%3E',
      '/api/v1/gitlab/projects?q=rust&order_by=size',
      '/api/v1/gitlab/projects?q=rust&sort=random',
      '/api/v1/gitlab/projects?q=rust&limit=101',
      '/api/v1/gitlab/commits?project=..%2F..',
      '/api/v1/gitlab/commits?project=rust-lang%2Frust&ref=a..b',
      '/api/v1/gitlab/commits',
    ]) {
      const res = await call(path)
      expect(res.status).toBe(400)
      expect(((await res.json()) as { code: string }).code).toBe('INVALID_PARAMETER')
    }
    expect(gitlab.urls.length).toBe(before)
  })

  it('crates crate：versions 折叠成精简数组（丢掉 features/links 等大字段）', async () => {
    const res = await call('/api/v1/crates/crate/serde')
    expect(res.status).toBe(200)
    expect(crates.urls.at(-1)).toBe('https://crates.io/api/v1/crates/serde')
    const body = (await res.json()) as {
      provider: string
      name: string
      max_version: string
      description: string
      keywords: string[]
      versions: { num: string; yanked?: boolean; downloads?: number; features?: unknown; links?: unknown }[]
    }
    expect(body.provider).toBe('crates')
    expect(body.name).toBe('serde')
    expect(body.max_version).toBe('1.0.229')
    expect(body.description).toBe('A generic serialization framework')
    expect(body.keywords).toEqual(['serde', 'serialization'])
    expect(body.versions.map((entry) => entry.num)).toEqual(['1.0.229', '1.0.228'])
    // 上游每个版本还带 features/links/audit_actions，折叠后一律不留
    for (const entry of body.versions) {
      expect(entry.features).toBeUndefined()
      expect(entry.links).toBeUndefined()
    }
    expect(body.versions[0]).toMatchObject({ num: '1.0.229', yanked: false, downloads: 900, license: 'MIT OR Apache-2.0' })
    expect(body.versions[1]).toMatchObject({ num: '1.0.228', yanked: true })
    // 折叠后每个版本只剩白名单字段，体积必须显著小于上游（上游 serde 是 441KB）
    for (const entry of body.versions) {
      for (const key of Object.keys(entry)) {
        expect(['num', 'yanked', 'created_at', 'downloads', 'license', 'rust_version', 'checksum', 'crate_size']).toContain(key)
      }
    }
    expect(JSON.stringify(body).length).toBeLessThan(600)
  })

  it('crates version 与 search：URL 形态与参数白名单', async () => {
    const version = await call('/api/v1/crates/crate/serde/1.0.229')
    expect(version.status).toBe(200)
    expect(crates.urls.at(-1)).toBe('https://crates.io/api/v1/crates/serde/1.0.229')
    // 单版本保持 passthrough：features 这种字段要留着
    const versionBody = (await version.json()) as { version: { features: unknown } }
    expect(versionBody.version.features).toEqual({ derive: ['serde_derive'] })

    const search = await call('/api/v1/crates/search?q=serde&limit=3&sort=downloads')
    expect(search.status).toBe(200)
    const url = new URL(crates.urls.at(-1)!)
    expect(url.pathname).toBe('/api/v1/crates')
    expect(url.searchParams.get('q')).toBe('serde')
    expect(url.searchParams.get('per_page')).toBe('3')
    expect(url.searchParams.get('sort')).toBe('downloads')
  })

  it('crates 非法 crate 名/版本/排序 400，不回源', async () => {
    const before = crates.urls.length
    for (const path of [
      '/api/v1/crates/crate/1serde',
      '/api/v1/crates/crate/Serde%20Core',
      '/api/v1/crates/crate/serde/1.0.229%20bad',
      '/api/v1/crates/crate/ser%20de',
      '/api/v1/crates/search?q=',
      '/api/v1/crates/search?q=%3Cscript%3E',
      '/api/v1/crates/search?q=serde&sort=popular',
    ]) {
      const res = await call(path)
      expect(res.status).toBe(400)
      expect(((await res.json()) as { code: string }).code).toBe('INVALID_PARAMETER')
    }
    expect(crates.urls.length).toBe(before)
    // 多出来的一段直接没有路由（404），不是 400
    expect((await call('/api/v1/crates/crate/serde/1.0.229/extra')).status).toBe(404)
    expect(crates.urls.length).toBe(before)
  })

  it('/status 里 usgs/gitlab/crates 都是零 key active', async () => {
    const body = (await (await call('/status')).json()) as {
      providers: { name: string; status: string; auth_optional?: boolean; auth_required?: boolean; credits?: { limit: number } | null }[]
    }
    for (const name of ['usgs', 'gitlab', 'crates']) {
      const entry = body.providers.find((p) => p.name === name)!
      expect(entry.status).toBe('active')
      expect(entry.auth_required).toBe(false)
      expect(entry.auth_optional).toBe(false)
    }
    expect(body.providers.find((p) => p.name === 'usgs')?.credits?.limit).toBe(4000)
    expect(body.providers.find((p) => p.name === 'gitlab')?.credits?.limit).toBe(5000)
    expect(body.providers.find((p) => p.name === 'crates')?.credits?.limit).toBe(3000)
  })

  it('openapi.json 与 llms.txt 覆盖 15 个 provider', async () => {
    const doc = (await (await call('/openapi.json')).json()) as { paths: Record<string, unknown> }
    expect(Object.keys(doc.paths)).toEqual(
      expect.arrayContaining([
        '/api/v1/usgs/earthquakes',
        '/api/v1/usgs/earthquakes/{id}',
        '/api/v1/gitlab/projects',
        '/api/v1/gitlab/project/{id}',
        '/api/v1/gitlab/commits',
        '/api/v1/crates/crate/{name}',
        '/api/v1/crates/crate/{name}/{version}',
        '/api/v1/crates/search',
      ]),
    )
    const text = await (await call('/llms.txt')).text()
    expect(text).toContain('/api/v1/usgs/earthquakes')
    expect(text).toContain('/api/v1/gitlab/projects')
    expect(text).toContain('/api/v1/crates/search')
  })

  it('（P5 基线）openapi.json 与 llms.txt 覆盖 12 个 provider', async () => {
    const doc = (await (await call('/openapi.json')).json()) as { paths: Record<string, unknown> }
    expect(Object.keys(doc.paths)).toEqual(
      expect.arrayContaining([
        '/api/v1/pypi/project/{package}',
        '/api/v1/pypi/release/{package}/{version}',
        '/api/v1/npm/latest/{name}',
        '/api/v1/npm/version/{name}/{version}',
        '/api/v1/npm/search',
        '/api/v1/pubmed/search',
        '/api/v1/pubmed/summary',
      ]),
    )
    const text = await (await call('/llms.txt')).text()
    expect(text).toContain('/api/v1/pypi/project/')
    expect(text).toContain('/api/v1/npm/search')
    expect(text).toContain('/api/v1/pubmed/search')
  })
})

describe('每日额度对直连源也是硬上限', () => {
  function messageFor(target: { op: string; id: string; query: [string, string][] }, provider: string, resource: 'feed' | 'item' | 'search') {
    return {
      id: crypto.randomUUID(),
      timestamp: new Date(),
      attempts: 1,
      body: { v: 1 as const, k: cacheKeyFor(provider, resource, target), p: provider, t: encodeTarget(target) },
    } as Parameters<typeof createMessageBatch>[1][number]
  }

  async function consume(target: { op: string; id: string; query: [string, string][] }, provider: string, resource: 'feed' | 'item' | 'search') {
    const batch = createMessageBatch('uapis-refresh', [messageFor(target, provider, resource)])
    const result = await handleQueueBatch(batch, env)
    await getQueueResult(batch, createExecutionContext())
    return result
  }

  it('每次回源扣 1，命中缓存不再扣', async () => {
    await resetCredits(env, 'lobsters', 'default')
    const before = (await readCredits(env, 'lobsters', 'default')).used

    const first = await call('/api/v1/lobsters/tag/billing')
    expect(first.status).toBe(200)
    expect(first.headers.get('x-cache')).toBe('REFRESH')
    expect((await readCredits(env, 'lobsters', 'default')).used).toBe(before + 1)

    const second = await call('/api/v1/lobsters/tag/billing')
    expect(['HIT', 'HIT-T1']).toContain(second.headers.get('x-cache'))
    expect((await readCredits(env, 'lobsters', 'default')).used).toBe(before + 1)
  })

  it('额度打满：503 QUOTA_EXHAUSTED，且一次上游都不打', async () => {
    const limit = (await readCredits(env, 'itunes', 'default')).limit
    expect(limit).toBe(9000)
    await resetCredits(env, 'itunes', 'default')
    expect(await consumeCredits(env, 'itunes', 'default', limit)).toBe(true)
    expect((await readCredits(env, 'itunes', 'default')).remaining).toBe(0)

    const before = itunes.urls.length
    const res = await call('/api/v1/itunes/search?term=exhausted')
    expect(res.status).toBe(503)
    const body = (await res.json()) as { code: string; details: Record<string, unknown> }
    expect(body.code).toBe('QUOTA_EXHAUSTED')
    expect(body.details).toMatchObject({ provider: 'itunes' })
    expect(res.headers.get('retry-after')).toBeTruthy()
    expect(itunes.urls.length).toBe(before)

    await resetCredits(env, 'itunes', 'default')
  })

  it('非法参数 400 不消耗额度（buildPlan 在记账之前）', async () => {
    await resetCredits(env, 'crossref', 'default')
    const bad = await call('/api/v1/crossref/search?query=x&sort=random')
    expect(bad.status).toBe(400)
    expect((await readCredits(env, 'crossref', 'default')).used).toBe(0)
  })

  it('队列侧同样被额度挡住：消息丢弃不重试，也不出网', async () => {
    const limit = (await readCredits(env, 'lobsters', 'default')).limit
    await resetCredits(env, 'lobsters', 'default')
    await consumeCredits(env, 'lobsters', 'default', limit)
    const before = lobsters.urls.length

    const stats = await consume({ op: 'tag', id: 'quota', query: [] }, 'lobsters', 'feed')
    expect(stats).toEqual({ processed: 1, refreshed: 0, retried: 0, dropped: 1 })
    expect(lobsters.urls.length).toBe(before)

    await resetCredits(env, 'lobsters', 'default')
  })

  it('/status 给直连源报当天额度，tier C 仍走 channels', async () => {
    await resetCredits(env, 'hackernews', 'default')
    await consumeCredits(env, 'hackernews', 'default', 7)
    const body = (await (await call('/status')).json()) as {
      providers: {
        name: string
        credits: { used: number; limit: number; remaining: number } | null
        channels: unknown[] | null
      }[]
    }
    const hn = body.providers.find((p) => p.name === 'hackernews')!
    expect(hn.channels).toBeNull()
    expect(hn.credits?.used).toBeGreaterThanOrEqual(7)
    expect(hn.credits?.limit).toBe(10000)
    expect(hn.credits?.remaining).toBe(hn.credits!.limit - hn.credits!.used)

    // tier C 不报 provider 维度额度，避免和通道额度两处数字打架
    expect(body.providers.find((p) => p.name === 'economist')!.credits).toBeNull()
    await resetCredits(env, 'hackernews', 'default')
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
    expect(body.key).toBe('v3:hackernews:item:item:42:q')
    expect(body.queued).toBe(true)
  })

  it('kill 会冻结 provider 闸门', async () => {
    const res = await call('/admin/kill?provider=hackernews&minutes=5', { method: 'POST', headers: ADMIN })
    const body = (await res.json()) as { until: string }
    expect(new Date(body.until).getTime()).toBeGreaterThan(Date.now())
  })
})
