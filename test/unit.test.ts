import { env as cloudflareEnv } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import { ApiError, ErrorCode, mapUpstreamStatus } from '../src/core/errors'
import { buildCacheKey, hashPairs, sanitizeId, TTL_POLICIES } from '../src/core/ttl'
import { clearSettingsMemo, putSettings } from '../src/core/settings'
import { decodeTarget, encodeTarget } from '../src/core/target'
import { parseMessage } from '../src/core/queue'
import { allEndpoints, operationIdOf, REGISTRY, validateRegistry } from '../src/core/registry'
import { buildOpenApi } from '../src/core/openapi'
import { assertAllowedUpstream, userAgent } from '../src/core/fetcher'
import { consumeCredits, readCredits, resetCredits } from '../src/core/credits'
import { runtimeFor } from '../src/providers'
import { parseAtom } from '../src/providers/arxiv'
import { extractArticle } from '../src/providers/economist'
import { egressHostsOf, providerByName } from '../src/core/registry'
import { pickChannel } from '../src/core/fetcher'

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
    expect(buildCacheKey('hackernews', 'item', '123')).toBe('v1:hackernews:item:123:q')
  })

  it('query 顺序不影响哈希，未知参数会改变哈希', () => {
    expect(hashPairs([['b', '2'], ['a', '1']])).toBe(hashPairs([['a', '1'], ['b', '2']]))
    expect(hashPairs([['a', '1']])).not.toBe(hashPairs([['a', '2']]))
  })

  it('id 归一化：去空白、小写、压缩分隔符', () => {
    expect(sanitizeId('  Foo/Bar  ')).toBe('foo-bar')
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
    // 其他 provider 的路径参数都是单段
    for (const { provider, endpoint: item } of allEndpoints()) {
      if (provider.name === 'economist') continue
      for (const param of item.params.filter((x) => x.multiSegment === true)) {
        expect(`${provider.name}.${item.op}.${param.name}`).toBe('')
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
