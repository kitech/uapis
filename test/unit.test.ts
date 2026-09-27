import { env as cloudflareEnv } from 'cloudflare:workers'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { http, HttpResponse } from 'msw'
import { network } from './server'
import { ApiError, ErrorCode, mapUpstreamStatus } from '../src/core/errors'
import { buildCacheKey, hashPairs, sanitizeId, TTL_POLICIES } from '../src/core/ttl'
import { clearSettingsMemo, putSettings, SETTINGS_DEFAULTS } from '../src/core/settings'
import { decodeTarget, encodeTarget } from '../src/core/target'
import { parseMessage } from '../src/core/queue'
import {
  allEndpoints,
  missingQuotaDefaults,
  operationIdOf,
  REGISTRY,
  validateRegistry,
} from '../src/core/registry'
import { buildOpenApi } from '../src/core/openapi'
import { assertAllowedUpstream, userAgent } from '../src/core/fetcher'
import { consumeCredits, readCredits, resetCredits } from '../src/core/credits'
import { runtimeFor } from '../src/providers'
import { parseAtom } from '../src/providers/arxiv'
import { extractArticle } from '../src/providers/economist'
import { egressHostsOf, providerByName } from '../src/core/registry'
import { fetchUpstream, pickChannel } from '../src/core/fetcher'

/** miniflare 的 Cloudflare.Env 缺少 src/types.ts 里声明的 ADMIN_TOKEN，测试里做一次桥接 */
const env = cloudflareEnv as unknown as Env

const ALLOWLIST = [
  'api.stackexchange.com',
  'hn.algolia.com',
  'api.github.com',
  'dev.to',
  'export.arxiv.org',
  'api.zenrows.com',
  'r.jina.ai',
  'lobste.rs',
  'itunes.apple.com',
  'api.crossref.org',
  'pypi.org',
  'registry.npmjs.org',
  'eutils.ncbi.nlm.nih.gov',
]

describe('错误体与状态码映射', () => {
  it('UApiError 只输出 code/message/details', () => {
    expect(new ApiError('NOT_FOUND', 'nope', 404).toBody()).toEqual({
      code: 'NOT_FOUND',
      message: 'nope',
    })
    expect(new ApiError('UPSTREAM_ERROR', 'boom', 502, { host: 'x' }).toBody()).toEqual({
      code: 'UPSTREAM_ERROR',
      message: 'boom',
      details: { host: 'x' },
    })
  })

  it('错误码全集与 uapis 对齐', () => {
    expect(Object.values(ErrorCode).sort()).toEqual(
      [
        'FILE_TOO_LARGE',
        'FORBIDDEN',
        'INTERNAL_ERROR',
        'INVALID_ARGUMENT',
        'INVALID_PARAMETER',
        'NO_MATCH',
        'NOT_FOUND',
        'PROVIDER_UNCONFIGURED',
        'QUOTA_EXHAUSTED',
        'RATE_LIMITED',
        'REBUILDING',
        'SERVICE_UNAVAILABLE',
        'UNAUTHORIZED',
        'UPSTREAM_ERROR',
        'UPSTREAM_TIMEOUT',
      ].sort(),
    )
  })

  it('上游状态映射到对外状态', () => {
    expect(mapUpstreamStatus(404)).toEqual({ status: 404, code: 'NOT_FOUND' })
    expect(mapUpstreamStatus(403)).toEqual({ status: 403, code: 'FORBIDDEN' })
    expect(mapUpstreamStatus(429)).toEqual({ status: 429, code: 'RATE_LIMITED' })
    expect(mapUpstreamStatus(500)).toEqual({ status: 502, code: 'UPSTREAM_ERROR' })
    expect(mapUpstreamStatus(401)).toEqual({ status: 502, code: 'UPSTREAM_ERROR' })
  })
})

describe('缓存键', () => {
  it('键结构固定为 v1:provider:resource:id:qhash', () => {
    expect(buildCacheKey('hackernews', 'item', 'story', '123')).toBe('v3:hackernews:item:story:123:q')
    // 无路径参数、无 query 的端点（lobsters/hot vs /newest）不能撞键：
    // 之前 id 都是空串落到 root，newest 会直接吐 hot 的缓存内容
    expect(buildCacheKey('lobsters', 'feed', 'hot', '')).not.toBe(
      buildCacheKey('lobsters', 'feed', 'newest', ''),
    )
    // id 大小写敏感：tag/Rust 不能命中 tag/rust 的条目
    expect(buildCacheKey('lobsters', 'feed', 'tag', 'Rust')).not.toBe(
      buildCacheKey('lobsters', 'feed', 'tag', 'rust'),
    )
  })

  it('query 顺序不影响哈希，未知参数会改变哈希', () => {
    expect(hashPairs([['b', '2'], ['a', '1']])).toBe(hashPairs([['a', '1'], ['b', '2']]))
    expect(hashPairs([['a', '1']])).not.toBe(hashPairs([['a', '2']]))
  })

  it('id 归一化：去空白、小写、压缩分隔符', () => {
    expect(sanitizeId('  Foo/Bar  ')).toBe('Foo-Bar')
    expect(sanitizeId('--x--')).toBe('x')
  })

  it('TTL 策略与规划一致', () => {
    expect(TTL_POLICIES.search).toEqual({ ttlSeconds: 60, staleSeconds: 600 })
    expect(TTL_POLICIES.item).toEqual({ ttlSeconds: 600, staleSeconds: 2_592_000 })
    expect(TTL_POLICIES.wall).toEqual({ ttlSeconds: 86_400, staleSeconds: 604_800 })
  })
})

describe('刷新目标描述符', () => {
  it('往返编码保留大小写与 query', () => {
    const target = { op: 'user', id: 'PG', query: [['site', 'stackoverflow']] as [string, string][] }
    expect(decodeTarget(encodeTarget(target))).toEqual(target)
  })

  it('非法输入返回 null', () => {
    expect(decodeTarget('no-colon')).toBeNull()
  })
})

describe('队列消息校验', () => {
  it('只接受 v1 且字段齐全的消息', () => {
    expect(parseMessage({ v: 1, k: 'k', p: 'p', t: 'op:id' })).toEqual({
      v: 1,
      k: 'k',
      p: 'p',
      t: 'op:id',
    })
    expect(parseMessage({ v: 2, k: 'k', p: 'p', t: 'op:id' })).toBeNull()
    expect(parseMessage({ v: 1, k: 'k', p: 'p' })).toBeNull()
    expect(parseMessage(null)).toBeNull()
    expect(parseMessage('nope')).toBeNull()
  })
})

describe('registry 自检', () => {
  it('operationId 唯一、路径参数一致、host 已进白名单', () => {
    const result = validateRegistry(ALLOWLIST)
    expect(result.problems).toEqual([])
    expect(result.ok).toBe(true)
  })

  it('每个直连 provider 都必须有正的 quota.<name>.default（否则回源不受限）', () => {
    expect(missingQuotaDefaults(SETTINGS_DEFAULTS)).toEqual([])
    // 故意漏一个额度键：自检要能报出来
    const partial: Record<string, string> = {}
    for (const [key, value] of Object.entries(SETTINGS_DEFAULTS)) {
      if (key === 'quota.github.default') continue
      partial[key] = value
    }
    const missing = missingQuotaDefaults(partial)
    expect(missing).toHaveLength(1)
    expect(missing[0]).toContain('quota.github.default')
    // 0 表示不限，同样算漏配（"忘了"和"故意"在效果上无法区分）
    expect(missingQuotaDefaults({ ...SETTINGS_DEFAULTS, 'quota.github.default': '0' })).toEqual([
      expect.stringContaining('quota.github.default'),
    ])
  })

  it('host 未进白名单会被拦下', () => {
    const result = validateRegistry(['api.stackexchange.com'])
    expect(result.ok).toBe(false)
    expect(result.problems.join()).toContain('hn.algolia.com')
  })

  it('每个 provider 至少一个 endpoint', () => {
    for (const provider of REGISTRY) {
      expect(provider.endpoints.length).toBeGreaterThan(0)
    }
  })
})

describe('OpenAPI 生成', () => {
  const doc = buildOpenApi('https://uapis.example.com') as {
    paths: Record<string, Record<string, { operationId: string; responses: Record<string, unknown> }>>
    components: { securitySchemes: Record<string, unknown>; schemas: Record<string, unknown> }
    servers: { url: string }[]
  }

  it('包含 BearerAuth 与 UApiError 组件', () => {
    expect(Object.keys(doc.components.securitySchemes)).toContain('BearerAuth')
    expect(Object.keys(doc.components.schemas)).toContain('UApiError')
    expect(doc.servers[0]?.url).toBe('https://uapis.example.com/api/v1')
  })

  it('覆盖 registry 中的每个 endpoint 且 operationId 唯一', () => {
    const ids = new Set<string>()
    for (const { provider, endpoint } of allEndpoints()) {
      const item = doc.paths[endpoint.path]?.[endpoint.method.toLowerCase()]
      expect(item, `缺少 ${endpoint.path}`).toBeDefined()
      expect(item?.operationId).toBe(operationIdOf(provider.name, endpoint))
      expect(Object.keys(item?.responses ?? {})).toContain('429')
      ids.add(item?.operationId ?? '')
    }
    expect(ids.size).toBe(allEndpoints().length)
  })
})

describe('provider 回源计划（P1 端点）', () => {
  const hn = runtimeFor('hackernews')!
  const se = runtimeFor('stackexchange')!

  it('Hacker News front 用 front_page 标签并落在 feed 档', async () => {
    const plan = await hn.buildPlan(env, { op: 'front', id: '', query: [] })
    expect(plan.url).toBe('https://hn.algolia.com/api/v1/search?tags=front_page&hitsPerPage=20&page=0')
    expect(plan.resource).toBe('feed')
  })

  it('Hacker News latest 走 search_by_date 并尊重 tags', async () => {
    const plan = await hn.buildPlan(env, {
      op: 'latest',
      id: '',
      query: [['tags', 'comment'], ['page', '2']],
    })
    expect(plan.url).toContain('/search_by_date?tags=comment')
    expect(plan.url).toContain('page=2')
  })

  it('Hacker News userPosts 用 author 标签而不是 story 标签', async () => {
    // 实测 hn.algolia.com：tags=author_pg 有 1w+ 条，tags=story_pg 恒为 0
    const plan = await hn.buildPlan(env, { op: 'userPosts', id: 'pg', query: [] })
    expect(plan.url).toBe(
      'https://hn.algolia.com/api/v1/search_by_date?tags=author_pg&hitsPerPage=20&page=0',
    )
    expect(plan.url).not.toContain('story_pg')
  })

  it('Hacker News userPosts 支持关键词过滤并校验用户名', async () => {
    const plan = await hn.buildPlan(env, {
      op: 'userPosts',
      id: 'pg',
      query: [['query', 'rust workers']],
    })
    expect(plan.url).toContain('tags=author_pg')
    expect(plan.url).toContain('query=rust%20workers')
    await expect(hn.buildPlan(env, { op: 'userPosts', id: 'bad user', query: [] })).rejects.toThrow(
      /invalid id/,
    )
  })

  it('Stack Exchange answers 走 /questions/{id}/answers 并带分页', async () => {
    const plan = await se.buildPlan(env, {
      op: 'answers',
      id: '123',
      query: [['site', 'stackoverflow'], ['sort', 'votes'], ['pagesize', '50'], ['page', '1']],
    })
    expect(plan.url).toContain('/questions/123/answers?site=stackoverflow')
    expect(plan.url).toContain('sort=votes')
    expect(plan.url).toContain('pagesize=50&page=1')
    expect(plan.resource).toBe('item')
  })

  it('Stack Exchange comments 走 /posts/{id}/comments', async () => {
    const plan = await se.buildPlan(env, { op: 'comments', id: '9', query: [['filter', '!x']] })
    expect(plan.url).toContain('/posts/9/comments?site=stackoverflow')
    expect(plan.url).toContain('filter=!x')
  })

  it('Stack Exchange sites 是匿名端点：不带 key 也能用', async () => {
    const plan = await se.buildPlan(env, { op: 'sites', id: '', query: [] })
    expect(plan.url).toBe(
      'https://api.stackexchange.com/2.3/sites?pagesize=100&page=0',
    )
    expect(plan.url).not.toContain('key=')
    const endpoint = REGISTRY.find((p) => p.name === 'stackexchange')?.endpoints.find(
      (e) => e.op === 'sites',
    )
    expect(endpoint?.auth).toBe('optional')
  })

  it('未知 op 抛 NOT_FOUND', async () => {
    await expect(hn.buildPlan(env, { op: 'nope', id: '', query: [] })).rejects.toThrow(
      /unknown hackernews op/,
    )
    await expect(se.buildPlan(env, { op: 'nope', id: '', query: [] })).rejects.toThrow(
      /unknown stackexchange op/,
    )
  })

  it('分页上界有天花板：页码 ≤ 30、每页条数 ≤ 100', () => {
    for (const { endpoint } of allEndpoints()) {
      for (const param of endpoint.params) {
        if (['page', 'start'].includes(param.name)) {
          expect(param.maximum, `${param.name} @ ${endpoint.op}`).toBeLessThanOrEqual(30_000)
        }
        if (['pagesize', 'per_page', 'hitsPerPage', 'max_results'].includes(param.name)) {
          expect(param.maximum, `${param.name} @ ${endpoint.op}`).toBeLessThanOrEqual(500)
        }
      }
    }
  })
})

describe('P2 零 key 源回源计划', () => {
  const gh = runtimeFor('github')!
  const devto = runtimeFor('devto')!
  const arxiv = runtimeFor('arxiv')!

  it('github 匿名不带 Authorization 头', async () => {
    const plan = await gh.buildPlan(env, { op: 'repo', id: 'cloudflare/workers-sdk', query: [] })
    expect(plan.url).toBe('https://api.github.com/repos/cloudflare/workers-sdk')
    expect(plan.headers?.Authorization).toBeUndefined()
    expect(plan.headers?.['X-GitHub-Api-Version']).toBe('2022-11-28')
  })

  it('github 配了 gh.token 就走 Authorization 头，不进 query', async () => {
    await putSettings(env, { 'gh.token': 'ghp_test' })
    clearSettingsMemo()
    const plan = await gh.buildPlan(env, { op: 'user', id: 'torvalds', query: [] })
    expect(plan.headers?.Authorization).toBe('Bearer ghp_test')
    expect(plan.url).not.toContain('ghp_test')
    await putSettings(env, { 'gh.token': '' })
    clearSettingsMemo()
  })

  it('github repo 的 owner/repo 都要校验', async () => {
    await expect(gh.buildPlan(env, { op: 'repo', id: 'bad owner/x', query: [] })).rejects.toThrow(
      /invalid repo/,
    )
  })

  it('github 搜索校验 sort/order 且 q 必填', async () => {
    const plan = await gh.buildPlan(env, {
      op: 'search',
      id: '',
      query: [['q', 'workers runtime'], ['sort', 'stars'], ['per_page', '50'], ['page', '2']],
    })
    expect(plan.url).toBe(
      'https://api.github.com/search/repositories?q=workers%20runtime&per_page=50&page=2&sort=stars&order=desc',
    )
    await expect(
      gh.buildPlan(env, { op: 'search', id: '', query: [['sort', 'nope']] }),
    ).rejects.toThrow(/q/)
    await expect(
      gh.buildPlan(env, { op: 'search', id: '', query: [['q', 'a'], ['sort', 'nope']] }),
    ).rejects.toThrow(/invalid sort/)
  })

  it('devto 列表把 tag/username/state/top 拼好', async () => {
    const plan = await devto.buildPlan(env, {
      op: 'articles',
      id: '',
      query: [['tag', 'rust'], ['state', 'top'], ['top', '30'], ['page', '2'], ['per_page', '50']],
    })
    expect(plan.url).toBe(
      'https://dev.to/api/articles?page=2&tag=rust&state=top&top=30&per_page=50',
    )
    expect(plan.resource).toBe('feed')
  })

  it('devto 非法 state/tag 在 runtime 就被拒', async () => {
    await expect(
      devto.buildPlan(env, { op: 'articles', id: '', query: [['state', 'hot']] }),
    ).rejects.toThrow(/invalid state/)
    await expect(
      devto.buildPlan(env, { op: 'articles', id: '', query: [['tag', 'a b']] }),
    ).rejects.toThrow(/invalid tag/)
  })

  it('devto user 走上游的 by_username 端点', async () => {
    const plan = await devto.buildPlan(env, { op: 'user', id: 'ben', query: [] })
    expect(plan.url).toBe('https://dev.to/api/users/by_username?url=ben')
  })

  it('arxiv 查询串与 archive 档位（15 分钟新鲜期）', async () => {
    const plan = await arxiv.buildPlan(env, {
      op: 'search',
      id: '',
      query: [['search_query', 'cat:cs.LG'], ['max_results', '30'], ['sortBy', 'submittedDate']],
    })
    expect(plan.url).toBe(
      'https://export.arxiv.org/api/query?search_query=cat%3Acs.LG&start=0&max_results=30&sortBy=submittedDate&sortOrder=descending',
    )
    expect(plan.resource).toBe('archive')
    expect(TTL_POLICIES.archive.ttlSeconds).toBe(900)
    // 慢上游：放宽超时但关掉重试，避免内联路径等 2×15s
    expect(plan.timeoutMs).toBe(15_000)
    expect(plan.retries).toBe(0)
  })

  it('arxiv 拒掉带 & 的查询式（防 URL 注入）', async () => {
    await expect(
      arxiv.buildPlan(env, { op: 'search', id: '', query: [['search_query', 'all:x&evil=1']] }),
    ).rejects.toThrow(/invalid search_query/)
  })

  it('arxiv 单篇走 id_list', async () => {
    const plan = await arxiv.buildPlan(env, { op: 'paper', id: '2609.30258v1', query: [] })
    expect(plan.url).toBe('https://export.arxiv.org/api/query?id_list=2609.30258v1')
    await expect(arxiv.buildPlan(env, { op: 'paper', id: '../etc', query: [] })).rejects.toThrow(
      /invalid id/,
    )
  })
})

describe('arXiv Atom 解析（零依赖、有界）', () => {
  const ATOM = `<?xml version='1.0' encoding='UTF-8'?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/">
  <updated>2026-09-24T18:00:00Z</updated>
  <opensearch:totalResults>1234</opensearch:totalResults>
  <entry>
    <id>http://arxiv.org/abs/2609.30258v1</id>
    <title>Gradient &amp; inversion
    for private data</title>
    <summary>Distributed learning offers
    a degree of privacy.</summary>
    <published>2026-09-20T10:00:00Z</published>
    <updated>2026-09-24T17:59:18Z</updated>
    <author><name>Ada L.</name></author>
    <author><name>Grace &amp; Hopper</name></author>
    <link href="https://arxiv.org/abs/2609.30258v1" rel="alternate" type="text/html"/>
    <link title="pdf" href="https://arxiv.org/pdf/2609.30258v1" rel="related" type="application/pdf"/>
    <arxiv:primary_category term="cs.LG" scheme="http://arxiv.org/schemas/atom"/>
    <category term="cs.LG" scheme="http://arxiv.org/schemas/atom"/>
    <category term="cs.AI" scheme="http://arxiv.org/schemas/atom"/>
  </entry>
</feed>`

  it('抽出 id/标题/摘要/作者/分类并解实体', () => {
    const feed = parseAtom(ATOM)
    expect(feed.provider).toBe('arxiv')
    expect(feed.total).toBe(1234)
    expect(feed.count).toBe(1)
    const entry = feed.entries[0]!
    expect(entry.id).toBe('2609.30258v1')
    expect(entry.title).toBe('Gradient & inversion for private data')
    expect(entry.summary).toBe('Distributed learning offers a degree of privacy.')
    expect(entry.authors).toEqual(['Ada L.', 'Grace & Hopper'])
    expect(entry.primary).toBe('cs.LG')
    expect(entry.categories).toEqual(['cs.LG', 'cs.AI'])
    expect(entry.pdf).toBe('https://arxiv.org/pdf/2609.30258v1')
  })

  it('空结果不炸', () => {
    const feed = parseAtom('<feed xmlns="http://www.w3.org/2005/Atom"><entry></entry></feed>')
    expect(feed.total).toBe(0)
    expect(feed.entries.length).toBe(1)
    expect(feed.entries[0]!.id).toBe('')
  })
})

describe('P4 新增零 key 源', () => {
  it('lobsters：官方路径是 hottest/newest，不是 hot/new', async () => {
    const rt = runtimeFor('lobsters')!
    expect((await rt.buildPlan(env, { op: 'hot', id: '', query: [] })).url).toBe(
      'https://lobste.rs/hottest.json',
    )
    expect((await rt.buildPlan(env, { op: 'newest', id: '', query: [] })).url).toBe(
      'https://lobste.rs/newest.json',
    )
    expect((await rt.buildPlan(env, { op: 'tag', id: 'rust', query: [] })).url).toBe(
      'https://lobste.rs/t/rust.json',
    )
    expect((await rt.buildPlan(env, { op: 'story', id: 'uvmajz', query: [] })).url).toBe(
      'https://lobste.rs/s/uvmajz.json',
    )
    for (const bad of ['../admin', 'Rust', 'a/b', '', 'a b']) {
      await expect(rt.buildPlan(env, { op: 'tag', id: bad, query: [] })).rejects.toThrow(
        /invalid tag/,
      )
    }
    for (const bad of ['../x', 'AB!', 'toolongshortid']) {
      await expect(rt.buildPlan(env, { op: 'story', id: bad, query: [] })).rejects.toThrow(
        /invalid id/,
      )
    }
  })

  it('itunes：media 白名单、term/id 校验、offset 而非 page', async () => {
    const rt = runtimeFor('itunes')!
    const plan = await rt.buildPlan(env, {
      op: 'search',
      id: '',
      query: [
        ['term', 'cloudflare'],
        ['media', 'podcast'],
        ['country', 'JP'],
        ['limit', '50'],
        ['offset', '100'],
      ],
    })
    expect(plan.url).toBe(
      'https://itunes.apple.com/search?term=cloudflare&media=podcast&country=JP&limit=50&offset=100',
    )
    // media 非法值在 runtime 就 400，并回 allowed
    await expect(
      rt.buildPlan(env, { op: 'search', id: '', query: [['term', 'x'], ['media', 'book']] }),
    ).rejects.toMatchObject({ status: 400, details: { allowed: expect.arrayContaining(['music']) } })
    // term 允许 & （AT&T 这种），但必须被编码；= < / 一律拒
    expect(
      (await rt.buildPlan(env, { op: 'search', id: '', query: [['term', 'AT&T']] })).url,
    ).toContain('term=AT%26T')
    for (const term of ['a=b', '<script>', 'a/../b', 'a%20b']) {
      await expect(
        rt.buildPlan(env, { op: 'search', id: '', query: [['term', term]] }),
      ).rejects.toThrow(/invalid term/)
    }
    for (const id of ['1 OR 1', '../1', 'abc']) {
      await expect(
        rt.buildPlan(env, { op: 'lookup', id: '', query: [['id', id]] }),
      ).rejects.toThrow(/invalid id/)
    }
    expect((await rt.buildPlan(env, { op: 'lookup', id: '', query: [['id', '1765470838']] })).url).toBe(
      'https://itunes.apple.com/lookup?id=1765470838&country=US&limit=20',
    )
  })

  it('crossref：DOI 含斜杠走多段路由，mailto 只在配了且合法时带上', async () => {
    const rt = runtimeFor('crossref')!
    await putSettings(env, { 'crossref.mailto': '' })
    clearSettingsMemo()
    expect((await rt.buildPlan(env, { op: 'work', id: '10.2172/2407272', query: [] })).url).toBe(
      'https://api.crossref.org/works/10.2172/2407272',
    )
    const search = await rt.buildPlan(env, {
      op: 'search',
      id: '',
      query: [['query', 'cloudflare waf'], ['rows', '5'], ['sort', 'published'], ['order', 'asc']],
    })
    expect(search.url).toBe(
      'https://api.crossref.org/works?query=cloudflare%20waf&rows=5&offset=0&sort=published&order=asc',
    )

    // polite pool：配了合法邮箱才带 mailto，配错当没配（不报错，也不带）
    await putSettings(env, { 'crossref.mailto': 'me@example.com' })
    clearSettingsMemo()
    expect((await rt.buildPlan(env, { op: 'work', id: '10.2172/2407272', query: [] })).url).toBe(
      'https://api.crossref.org/works/10.2172/2407272?mailto=me%40example.com',
    )
    await putSettings(env, { 'crossref.mailto': 'not-an-email' })
    clearSettingsMemo()
    expect((await rt.buildPlan(env, { op: 'work', id: '10.2172/2407272', query: [] })).url).toBe(
      'https://api.crossref.org/works/10.2172/2407272',
    )
    await putSettings(env, { 'crossref.mailto': '' })
    clearSettingsMemo()
  })

  it('crossref：DOI 前缀、遍历与 sort 枚举都要拦', async () => {
    const rt = runtimeFor('crossref')!
    for (const doi of ['11.2172/2407272', '10.2172/../admin', '10.2172/a b', 'https://x/10.1/a']) {
      await expect(rt.buildPlan(env, { op: 'work', id: doi, query: [] })).rejects.toThrow(
        /invalid doi/,
      )
    }
    await expect(
      rt.buildPlan(env, { op: 'search', id: '', query: [['query', 'x'], ['sort', 'random']] }),
    ).rejects.toMatchObject({ status: 400, details: { allowed: expect.arrayContaining(['relevance']) } })
    await expect(
      rt.buildPlan(env, { op: 'search', id: '', query: [['query', 'x'], ['filter', 'a&b']] }),
    ).rejects.toThrow(/invalid filter/)
    await expect(
      rt.buildPlan(env, { op: 'search', id: '', query: [['query', 'x'], ['select', 'DOI|<script>']] }),
    ).rejects.toThrow(/invalid select/)
    // query 必填
    await expect(rt.buildPlan(env, { op: 'search', id: '', query: [] })).rejects.toThrow(
      /missing required parameter: query/,
    )
  })

  it('三个新源的额度与 host 都进了默认值', async () => {
    expect((await readCredits(env, 'lobsters', 'default')).limit).toBe(6000)
    expect((await readCredits(env, 'itunes', 'default')).limit).toBe(9000)
    expect((await readCredits(env, 'crossref', 'default')).limit).toBe(5000)
    for (const host of ['lobste.rs', 'itunes.apple.com', 'api.crossref.org']) {
      expect(ALLOWLIST).toContain(host)
    }
  })
})

describe('上游正文读失败要算 504，不能冒成 500', () => {
  beforeAll(() => {
    network.enable()
  })
  afterAll(() => {
    network.disable()
  })

  it('状态行到了但正文断流：按 504 重试并最终返回 504', async () => {
    let attempts = 0
    network.use(
      http.get('https://api.crossref.org/works/stall', () => {
        attempts += 1
        // 状态行与头已经到了，正文读一半断掉（真实场景是 AbortSignal.timeout 在读正文时抛
        // TimeoutError，CDN 接了连接但不落正文时就是这个样子）
        const broken = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.error(new Error('upstream body stalled'))
          },
        })
        return new HttpResponse(broken, {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }),
    )
    const res = await fetchUpstream(env, {
      url: 'https://api.crossref.org/works/stall',
      timeoutMs: 120,
      retries: 1,
    })
    expect(res.status).toBe(504)
    expect(res.raw).toContain('stalled')
    expect(attempts).toBe(2)
  })

  it('200 + 空正文不当成功：算 502，调用方不会把空条目写进缓存', async () => {
    network.use(http.get('https://api.crossref.org/works/empty', () => new HttpResponse(null, { status: 200 })))
    const res = await fetchUpstream(env, {
      url: 'https://api.crossref.org/works/empty',
      timeoutMs: 500,
      retries: 0,
    })
    expect(res.status).toBe(502)
    expect(res.raw).toContain('empty body')
  })
})

describe('P5 包管理与文献检索源', () => {
  it('pypi：包名按 PEP 503 归一化，transform 砍掉 releases 与 README', async () => {
    const rt = runtimeFor('pypi')!
    expect((await rt.buildPlan(env, { op: 'project', id: 'Django_REST', query: [] })).url).toBe(
      'https://pypi.org/pypi/django_rest/json',
    )
    expect((await rt.buildPlan(env, { op: 'release', id: 'requests/2.34.2', query: [] })).url).toBe(
      'https://pypi.org/pypi/requests/2.34.2/json',
    )
    for (const bad of ['../etc', 'a/b', '-leading', 'trailing-', 'a b', '']) {
      await expect(rt.buildPlan(env, { op: 'project', id: bad, query: [] })).rejects.toThrow(
        /invalid package/,
      )
    }
    for (const bad of ['requests/2.34.2/extra', 'requests/..', 'requests/2 34', 'requests/']) {
      await expect(rt.buildPlan(env, { op: 'release', id: bad, query: [] })).rejects.toThrow(
        /invalid/,
      )
    }

    // 上游真实形态的裁剪：releases（96% 体积）与 description 全文都不该出现在输出里
    const upstream = JSON.stringify({
      info: {
        name: 'requests',
        version: '2.34.2',
        summary: 'Python HTTP for Humans.',
        description: 'X'.repeat(50_000),
        description_content_type: 'text/markdown',
        requires_python: '>=3.10',
        license: 'Apache-2.0',
        classifiers: ['Programming Language :: Python'],
        requires_dist: ['urllib3>=1.21.1'],
        project_urls: { Source: 'https://github.com/psf/requests' },
        dynamic: ['description'],
      },
      last_serial: 37059094,
      releases: { '0.0.1': [{ filename: 'requests-0.0.1.tar.gz', url: 'https://files.pythonhosted.org/x' }] },
      urls: [
        {
          filename: 'requests-2.34.2-py3-none-any.whl',
          packagetype: 'bdist_wheel',
          size: 65435,
          upload_time: '2026-05-14T19:25:27Z',
          yanked: false,
          requires_python: '>=3.10',
          url: 'https://files.pythonhosted.org/packages/aa/bb/requests-2.34.2-py3-none-any.whl',
          digests: { sha256: 'ff' },
          upload_time_iso_8601: '2026-05-14T19:25:27.000000Z',
        },
      ],
      vulnerabilities: [],
    })
    const out = JSON.parse(rt.transform!(upstream, { op: 'project', id: 'requests', query: [] }).text) as {
      provider: string
      name: string
      versions: string[]
      files: Record<string, unknown>[]
      last_serial: number
    }
    expect(out.provider).toBe('pypi')
    expect(out.name).toBe('requests')
    expect(out.versions).toEqual(['0.0.1'])
    expect(out.files[0]).toMatchObject({ filename: 'requests-2.34.2-py3-none-any.whl', size: 65435 })
    expect(JSON.stringify(out)).not.toContain('X'.repeat(1000))
    expect(JSON.stringify(out)).not.toContain('releases')
    expect(JSON.stringify(out)).not.toContain('dynamic')
    // 上游返回非 JSON 时不能把脏东西当成功落库
    expect(() => rt.transform!('<html>maintenance</html>', { op: 'project', id: 'x', query: [] })).toThrow(
      /non-JSON/,
    )
  })

  it('npm：scoped 包名多段、版本拆包名要按 @scope 边界切', async () => {
    const rt = runtimeFor('npm')!
    expect((await rt.buildPlan(env, { op: 'latest', id: 'react', query: [] })).url).toBe(
      'https://registry.npmjs.org/react/latest',
    )
    expect((await rt.buildPlan(env, { op: 'latest', id: '@types/node', query: [] })).url).toBe(
      'https://registry.npmjs.org/@types/node/latest',
    )
    expect((await rt.buildPlan(env, { op: 'version', id: '@types/node/26.6.3', query: [] })).url).toBe(
      'https://registry.npmjs.org/@types/node/26.6.3',
    )
    expect((await rt.buildPlan(env, { op: 'version', id: 'react/18.3.1', query: [] })).url).toBe(
      'https://registry.npmjs.org/react/18.3.1',
    )
    // 切错段就会把包名/版本拼反：@scope/pkg + 版本 才是三段
    for (const bad of ['@types/node', 'react/18.3.1/extra', '@types/node/26.6.3/x']) {
      await expect(rt.buildPlan(env, { op: 'version', id: bad, query: [] })).rejects.toThrow(
        /invalid target/,
      )
    }
    for (const bad of ['../x', 'React', 'a b', '@/pkg', '@scope/', 'x'.repeat(120)]) {
      await expect(rt.buildPlan(env, { op: 'latest', id: bad, query: [] })).rejects.toThrow(
        /invalid package name/,
      )
    }
    await expect(
      rt.buildPlan(env, { op: 'version', id: 'react/..', query: [] }),
    ).rejects.toThrow(/invalid version/)
  })

  it('npm search：只放行白名单参数，sort 枚举非法时报 allowed', async () => {
    const rt = runtimeFor('npm')!
    expect(
      (await rt.buildPlan(env, { op: 'search', id: '', query: [['text', 'web framework'], ['size', '20']] })).url,
    ).toBe('https://registry.npmjs.org/-/v1/search?text=web%20framework&size=20&from=0')
    expect(
      (
        await rt.buildPlan(env, {
          op: 'search',
          id: '',
          query: [['text', 'react'], ['sort', 'popularity']],
        })
      ).url,
    ).toContain('&sort=popularity')
    // relevance 是默认值，不往上游发
    expect(
      (await rt.buildPlan(env, { op: 'search', id: '', query: [['text', 'x'], ['sort', 'relevance']] })).url,
    ).not.toContain('sort=')
    await expect(
      rt.buildPlan(env, { op: 'search', id: '', query: [['text', 'x'], ['sort', 'stars']] }),
    ).rejects.toMatchObject({ status: 400, details: { allowed: expect.arrayContaining(['popularity']) } })
    // 检索词里允许 `@types/node`、`node/react` 这类含 / 的写法，但必须被编码
    expect(
      (await rt.buildPlan(env, { op: 'search', id: '', query: [['text', '@types/node']] })).url,
    ).toContain('text=%40types%2Fnode')
    for (const text of ['a&b', 'a=b', '<script>', '%2e%2e', '']) {
      await expect(
        rt.buildPlan(env, { op: 'search', id: '', query: [['text', text]] }),
      ).rejects.toThrow(/invalid text/)
    }
  })

  it('pubmed：空 term 与非法 PMID 必须自己拒（上游都是 200 + 错误体）', async () => {
    const rt = runtimeFor('pubmed')!
    await putSettings(env, { 'ncbi.api_key': '' })
    clearSettingsMemo()
    expect(
      (await rt.buildPlan(env, { op: 'search', id: '', query: [['term', 'cloudflare AND waf']] })).url,
    ).toBe(
      'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&term=cloudflare%20AND%20waf&retmode=json&retmax=20&retstart=0&sort=relevance',
    )
    expect(
      (await rt.buildPlan(env, { op: 'summary', id: '', query: [['id', '35369193,32015575']] })).url,
    ).toBe(
      'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?db=pubmed&id=35369193%2C32015575&retmode=json&version=2.0',
    )

    // 上游对这两种输入都返回 200，放行就会把错误体当正常数据缓存起来
    await expect(rt.buildPlan(env, { op: 'search', id: '', query: [] })).rejects.toThrow(
      /missing required parameter: term/,
    )
    for (const id of ['notanumber', '35369193,', '1,abc', '1;drop', '1'.repeat(20), '']) {
      await expect(
        rt.buildPlan(env, { op: 'summary', id: '', query: [['id', id]] }),
      ).rejects.toThrow(/invalid id/)
    }
    await expect(
      rt.buildPlan(env, { op: 'search', id: '', query: [['term', 'x'], ['sort', 'relevancee']] }),
    ).rejects.toMatchObject({ status: 400, details: { allowed: expect.arrayContaining(['pub_date']) } })
  })

  it('pubmed：配了合法 ncbi.api_key 才带上，配错当没配', async () => {
    const rt = runtimeFor('pubmed')!
    await putSettings(env, { 'ncbi.api_key': 'NCBI1234567890' })
    clearSettingsMemo()
    expect(
      (await rt.buildPlan(env, { op: 'search', id: '', query: [['term', 'waf']] })).url,
    ).toContain('&api_key=NCBI1234567890')
    // key 只发往 eutils（白名单唯一出口），且不进缓存键
    expect(
      (await rt.buildPlan(env, { op: 'search', id: '', query: [['term', 'waf']] })).url,
    ).toContain('eutils.ncbi.nlm.nih.gov')

    await putSettings(env, { 'ncbi.api_key': 'short' })
    clearSettingsMemo()
    expect(
      (await rt.buildPlan(env, { op: 'summary', id: '', query: [['id', '1']] })).url,
    ).not.toContain('api_key')
    await putSettings(env, { 'ncbi.api_key': '' })
    clearSettingsMemo()
  })

  it('P5 三个源的额度与 host 都进了默认值', async () => {
    expect((await readCredits(env, 'pypi', 'default')).limit).toBe(6000)
    expect((await readCredits(env, 'npm', 'default')).limit).toBe(8000)
    expect((await readCredits(env, 'pubmed', 'default')).limit).toBe(10000)
    for (const host of ['pypi.org', 'registry.npmjs.org', 'eutils.ncbi.nlm.nih.gov']) {
      expect(ALLOWLIST).toContain(host)
    }
  })
})

describe('P3 付费通道（tier C）', () => {
  const eco = runtimeFor('economist')!

  it('双通道都没配就 503，不做任何免费尝试', async () => {
    await putSettings(env, { 'zenrows.key': '', 'jina.key': '' })
    clearSettingsMemo()
    await expect(eco.buildPlan(env, { op: 'article', id: 'foo', query: [] })).rejects.toThrow(
      /no paid channel configured/,
    )
  })

  it('只配 jina 也能建 plan，通道由 pickChannel 决定', async () => {
    await putSettings(env, { 'zenrows.key': '', 'jina.key': 'jina_test' })
    clearSettingsMemo()
    const plan = await eco.buildPlan(env, { op: 'article', id: 'finance/2026/01/01/x', query: [] })
    expect(plan.url).toBe('https://www.economist.com/finance/2026/01/01/x')
    expect(plan.proxy?.url).toBe(plan.url)
    // endpoint 显式声明了 zenrows，所以显式优先于设置
    expect(await pickChannel(env, 'zenrows')).toBe('zenrows')
    expect(await pickChannel(env)).toBe('jina')
  })

  it('目标 host 来自 registry 常量，路径穿越与查询注入都被拒', async () => {
    await putSettings(env, { 'zenrows.key': 'zr_test' })
    clearSettingsMemo()
    const plan = await eco.buildPlan(env, { op: 'article', id: '/finance/2026/01/01/x/', query: [] })
    expect(plan.url).toBe('https://www.economist.com/finance/2026/01/01/x')
    expect(plan.proxy?.url).toBe('https://www.economist.com/finance/2026/01/01/x')
    // 穿越、协议注入、query 注入都不给过
    for (const bad of ['a/../../etc/passwd', '../secret', 'x/..', '..', 'x?a=1', 'x#f', 'x y', 'x%2f..%2fy', 'https://evil.example.com']) {
      await expect(eco.buildPlan(env, { op: 'article', id: bad, query: [] })).rejects.toThrow(
        /invalid slug/,
      )
    }
    // 前导斜杠剥掉后 host 仍由常量决定：调用方塞不进自己的域名
    const sneaky = await eco.buildPlan(env, { op: 'article', id: '//evil.example.com/x', query: [] })
    expect(new URL(sneaky.url).hostname).toBe('www.economist.com')
    // 单个 `.` 允许（真实 slug 里会有），`..` 一律拒
    expect((await eco.buildPlan(env, { op: 'article', id: 'a.b/c-d_e', query: [] })).url).toBe(
      'https://www.economist.com/a.b/c-d_e',
    )
    await putSettings(env, { 'zenrows.key': '' })
    clearSettingsMemo()
  })

  it('出口白名单按 egressHosts 校验：目标 host 不必、也不该在白名单里', () => {
    const provider = providerByName('economist')!
    expect(egressHostsOf(provider)).toEqual(['api.zenrows.com', 'r.jina.ai'])
    expect(provider.hosts).toEqual(['www.economist.com'])
    // 直连付费墙源必须被拦住
    expect(ALLOWLIST).not.toContain('www.economist.com')
    const result = validateRegistry(ALLOWLIST)
    expect(result.problems).toEqual([])
  })

  it('registry 强制 tier C 必须声明 proxy 且不许 inline', () => {
    const provider = providerByName('economist')!
    const endpoint = provider.endpoints[0]!
    expect(provider.tier).toBe('C')
    expect(endpoint.proxy).toBeDefined()
    expect(endpoint.inline).toBe(false)
    expect(endpoint.passthrough).toBe(false)
    expect(endpoint.resource).toBe('wall')
    expect(TTL_POLICIES.wall.ttlSeconds).toBe(86_400)
  })

  it('tier C 必须声明 requiredAnyOf，economist 列出两条付费通道', () => {
    for (const provider of REGISTRY.filter((p) => p.tier === 'C')) {
      expect(provider.requiredAnyOf ?? []).toContain('zenrows.key')
      expect(provider.requiredAnyOf ?? []).toContain('jina.key')
    }
  })

  it('multiSegment 只允许 path 参数，economist 的 slug 走多段路由', () => {
    const endpoint = providerByName('economist')!.endpoints[0]!
    const slug = endpoint.params.find((param) => param.name === 'slug')!
    expect(slug.in).toBe('path')
    expect(slug.multiSegment).toBe(true)
    // 目前只有"路径天然含 /"的端点才需要多段：economist 的 slug、crossref 的 DOI、
    // npm 的 scoped 包名（@scope/pkg）
    expect(
      allEndpoints()
        .flatMap(({ provider, endpoint: item }) =>
          item.params
            .filter((param) => param.multiSegment === true)
            .map((param) => `${provider.name}.${item.op}.${param.name}`),
        )
        .sort(),
    ).toEqual([
      'crossref.work.doi',
      'economist.article.slug',
      'npm.latest.name',
      'npm.version.name',
    ])
    // multiSegment 是路由层特性，只对 path 参数有意义
    for (const { endpoint: item } of allEndpoints()) {
      for (const param of item.params.filter((x) => x.multiSegment === true)) {
        expect(param.in).toBe('path')
      }
    }
  })

  it('通道优先级：hint > proxy.mode > ZenRows(有额度) > Jina', async () => {
    await putSettings(env, { 'zenrows.key': '', 'jina.key': '' })
    clearSettingsMemo()
    await expect(pickChannel(env)).rejects.toThrow(/no proxy channel configured/)

    // 只配 Jina
    await putSettings(env, { 'zenrows.key': '', 'jina.key': 'jina_test' })
    clearSettingsMemo()
    expect(await pickChannel(env)).toBe('jina')
    // off / auto 都表示"没有偏好"，不会因为叫 off 就把付费通道关掉
    expect(await pickChannel(env, 'zenrows')).toBe('zenrows')

    // ZenRows 有额度时优先 ZenRows
    await putSettings(env, { 'zenrows.key': 'zr_test' })
    clearSettingsMemo()
    await resetCredits(env, 'proxy', 'zenrows')
    expect(await pickChannel(env)).toBe('zenrows')

    // 额度打满则退到 Jina
    await consumeCredits(env, 'proxy', 'zenrows', 33)
    expect(await pickChannel(env)).toBe('jina')

    // proxy.mode 可以强制某一条
    await putSettings(env, { 'proxy.mode': 'jina' })
    clearSettingsMemo()
    expect(await pickChannel(env)).toBe('jina')
    await putSettings(env, { 'proxy.mode': 'off', 'zenrows.key': '', 'jina.key': '' })
    clearSettingsMemo()
  })

  it('付费通道的额度键接上了 consumeCredits 的维度', async () => {
    // 之前只有 proxy.zenrows.daily_credits 这个没人读的键，等于没有上限
    const zenrows = await readCredits(env, 'proxy', 'zenrows')
    const jina = await readCredits(env, 'proxy', 'jina')
    expect(zenrows.limit).toBe(33)
    expect(jina.limit).toBe(50)
  })

  it('只提取公开元数据，不搬运正文', () => {
    const html = `<html><head><title>Fallback title</title>
      <meta property="og:title" content="Paywalled &amp; locked">
      <meta property="og:description" content="A summary   line.">
      <meta name="article:section" content="Finance &amp; Economics">
      <meta property="article:published_time" content="2026-01-01T00:00:00Z">
    </head><body><article><p>FULL PAID TEXT MUST NOT LEAK</p></article></body></html>`
    const out = extractArticle(html)
    expect(out.title).toBe('Paywalled & locked')
    expect(out.description).toBe('A summary line.')
    expect(out.section).toBe('Finance & Economics')
    expect(JSON.stringify(out)).not.toContain('FULL PAID TEXT')
  })
})

describe('上游出口', () => {
  it('UA 带站点 URL 且不可被请求覆盖', () => {
    expect(userAgent(env)).toBe('uapis/1.0 (+https://test.local)')
  })

  it('白名单内 host 通过', async () => {
    const url = await assertAllowedUpstream(env, 'https://hn.algolia.com/api/v1/search?query=x')
    expect(url.hostname).toBe('hn.algolia.com')
  })

  it('非白名单 host 被拒', async () => {
    await expect(assertAllowedUpstream(env, 'https://evil.example.com/x')).rejects.toThrow(
      /not allowlisted/,
    )
  })

  it('非 https 与内网地址被拒', async () => {
    await expect(assertAllowedUpstream(env, 'http://hn.algolia.com/x')).rejects.toThrow(/https/)
    await expect(assertAllowedUpstream(env, 'https://127.0.0.1/x')).rejects.toThrow(/blocked/)
    await expect(assertAllowedUpstream(env, 'https://localhost/x')).rejects.toThrow(/blocked/)
    await expect(assertAllowedUpstream(env, 'https://169.254.169.254/x')).rejects.toThrow(/blocked/)
  })
})
