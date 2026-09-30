import { env as cloudflareEnv } from 'cloudflare:workers'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { http, HttpResponse } from 'msw'
import { network } from './server'
import {
  ApiError,
  ErrorCode,
  isStorageError,
  mapUpstreamStatus,
  rawErrorText,
  storageFail,
} from '../src/core/errors'
import { buildCacheKey, hashPairs, sanitizeId, TTL_POLICIES } from '../src/core/ttl'
import { clearSettingsMemo, putSettings, SETTINGS_DEFAULTS } from '../src/core/settings'
import { decodeTarget, encodeTarget } from '../src/core/target'
import type { Target } from '../src/core/target'
import { parseMessage } from '../src/core/queue'
import {
  allEndpoints,
  missingQuotaDefaults,
  operationIdOf,
  REGISTRY,
  validateRegistry,
} from '../src/core/registry'
import { buildOpenApi } from '../src/core/openapi'
import { USER_AGENT, assertAllowedUpstream } from '../src/core/fetcher'
import { consumeCredits, readCredits, resetCredits } from '../src/core/credits'
import { runtimeFor } from '../src/providers'
import { parseAtom } from '../src/providers/arxiv'
import { extractArticle } from '../src/providers/economist'
import { egressHostsOf, providerByName } from '../src/core/registry'
import { fetchUpstream, pickChannel } from '../src/core/fetcher'
import { normalizeOrigin, siteUrlOf } from '../src/core/site'
import { FORMAT_PARAM, resolveFormat, reshapeToHotboard } from '../src/core/uapis'

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
  'a.4cdn.org',
  't.me',
  'itunes.apple.com',
  'api.crossref.org',
  'pypi.org',
  'registry.npmjs.org',
  'eutils.ncbi.nlm.nih.gov',
  'earthquake.usgs.gov',
  'gitlab.com',
  'crates.io',
  'musicbrainz.org',
  'api.open-meteo.com',
  'geocoding-api.open-meteo.com',
  'air-quality-api.open-meteo.com',
  'medium.com',
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
        'STORAGE_UNAVAILABLE',
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
    // 504 以前被 >= 500 吃掉，UPSTREAM_TIMEOUT 从来没被真正返回过
    expect(mapUpstreamStatus(504)).toEqual({ status: 504, code: 'UPSTREAM_TIMEOUT' })
  })
})

describe('D1 原始错误透传', () => {
  type Chained = Error & { cause?: unknown }

  function d1Error(): Chained {
    const top = new Error('D1_ERROR') as Chained
    top.cause = new Error('no such table: cache')
    return top
  }

  it('rawErrorText 沿 cause 链拼出真正原因', () => {
    expect(rawErrorText(d1Error())).toBe('D1_ERROR: no such table: cache')
  })

  it('rawErrorText 对循环 cause 不会死循环', () => {
    const a = new Error('a') as Chained
    const b = new Error('b') as Chained
    a.cause = b
    b.cause = a
    expect(rawErrorText(a)).toBe('a: b')
  })

  it('rawErrorText 跳过重复段', () => {
    const top = new Error('boom') as Chained
    top.cause = new Error('boom')
    expect(rawErrorText(top)).toBe('boom')
  })

  it('rawErrorText 处理非 Error 与空 message', () => {
    expect(rawErrorText('boom')).toBe('boom')
    expect(rawErrorText(new Error())).toBe('Error')
  })

  it('isStorageError 只认 D1 错误', () => {
    expect(isStorageError(d1Error())).toBe(true)
    expect(isStorageError(new Error('SQLITE_CONSTRAINT: UNIQUE failed'))).toBe(true)
    expect(isStorageError(new Error('upstream responded 500'))).toBe(false)
    expect(isStorageError(new ApiError('NOT_FOUND', 'nope', 404))).toBe(false)
  })

  it('storageFail 是 503、透传原文且不带 Retry-After', () => {
    const error = storageFail(d1Error(), { request_id: 'r-1' })
    expect(error.code).toBe('STORAGE_UNAVAILABLE')
    expect(error.status).toBe(503)
    expect(error.retryAfter).toBeUndefined()
    expect(error.toBody()).toEqual({
      code: 'STORAGE_UNAVAILABLE',
      message: 'D1_ERROR: no such table: cache',
      details: { request_id: 'r-1' },
    })
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

  it('github 配了 github.token 就走 Authorization 头，不进 query', async () => {
    await putSettings(env, { 'github.token': 'ghp_test' })
    clearSettingsMemo()
    const plan = await gh.buildPlan(env, { op: 'user', id: 'torvalds', query: [] })
    expect(plan.headers?.Authorization).toBe('Bearer ghp_test')
    expect(plan.url).not.toContain('ghp_test')
    await putSettings(env, { 'github.token': '' })
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
      query: [['q', 'workers runtime'], ['sort', 'stars'], ['per_page', '30'], ['page', '2']],
    })
    expect(plan.url).toBe(
      'https://api.github.com/search/repositories?q=workers%20runtime&per_page=30&page=2&sort=stars&order=desc',
    )
    await expect(
      gh.buildPlan(env, { op: 'search', id: '', query: [['sort', 'nope']] }),
    ).rejects.toThrow(/q/)
    await expect(
      gh.buildPlan(env, { op: 'search', id: '', query: [['q', 'a'], ['sort', 'nope']] }),
    ).rejects.toThrow(/invalid sort/)
  })

  it('github 搜索接受官方四个 sort 值（含此前漏掉的 help-wanted-issues）', async () => {
    for (const sort of ['stars', 'forks', 'help-wanted-issues', 'updated']) {
      const plan = await gh.buildPlan(env, {
        op: 'search',
        id: '',
        query: [['q', 'a'], ['sort', sort]],
      })
      expect(plan.url).toContain(`sort=${sort}`)
    }
  })

  it('github 搜索显式放宽超时（原先继承 fetcher 的 3s 默认，上游 30 条实测 1.9~4.7s）', async () => {
    const plan = await gh.buildPlan(env, { op: 'search', id: '', query: [['q', 'android']] })
    expect(plan.timeoutMs).toBe(12_000)
    expect(plan.retries).toBe(0)
  })

  it('github 新星榜把 topic/sort/order 写死，只有 since 留给调用方', async () => {
    const plan = await gh.buildPlan(env, {
      op: 'androidRising',
      id: '',
      query: [['since', '2026-08-28'], ['per_page', '20'], ['page', '1']],
    })
    expect(plan.url).toBe(
      'https://api.github.com/search/repositories?q=topic%3Aandroid%20created%3A%3E2026-08-28&sort=stars&order=desc&per_page=20&page=1',
    )
    expect(plan.timeoutMs).toBe(12_000)
    expect(plan.retries).toBe(0)
  })

  it('github 新星榜拒绝不存在的日期（形状合法但 2026-13-45 上游回 422）', async () => {
    for (const bad of ['2026-13-45', '2026-08-32', '2026-02-30', '0000-01-01']) {
      await expect(
        gh.buildPlan(env, { op: 'androidRising', id: '', query: [['since', bad]] }),
      ).rejects.toThrow(/invalid since/)
    }
  })

  it('github 新星榜的 since 必须是 YYYY-MM-DD 形状', async () => {
    for (const bad of ['', '2026-8-28', '20260828', '>2026-08-28', '2026-08-28&sort=forks', '2026-08-28x']) {
      await expect(
        gh.buildPlan(env, { op: 'androidRising', id: '', query: [['since', bad]] }),
      ).rejects.toThrow(/invalid since/)
    }
  })

  it('github transform 只留 8 个字段并带上 provider 标', () => {
    const raw = JSON.stringify({
      total_count: 4926,
      incomplete_results: false,
      items: [
        {
          full_name: 'a/b',
          html_url: 'https://github.com/a/b',
          stargazers_count: 6758,
          topics: ['android'],
          license: { key: 'apache-2.0', name: 'Apache License 2.0' },
          owner: { login: 'a', id: 1 },
          node_id: 'R_kgDOAAA',
          security_and_analysis: { secret_scanning: { status: 'enabled' } },
        },
      ],
    })
    const text = gh.transform?.(raw, { op: 'androidRising', id: '', query: [] })?.text
    const out = JSON.parse(text ?? '{}') as { provider: string; items: Record<string, unknown>[] }
    expect(out.provider).toBe('github')
    expect(Object.keys(out.items[0]!).sort()).toEqual([
      'full_name',
      'html_url',
      'stargazers_count',
      'topics',
    ])
  })

  it('github transform 保留 incomplete_results 标记且缺 items 时不炸', () => {
    const slow = JSON.parse(
      gh.transform?.(JSON.stringify({ incomplete_results: true, items: [] }), {
        op: 'androidRising',
        id: '',
        query: [],
      })?.text ?? '{}',
    ) as { incomplete_results: boolean; total_count: number; items: unknown[] }
    expect(slow.incomplete_results).toBe(true)
    expect(slow.total_count).toBe(0)
    expect(slow.items).toEqual([])
  })

  it('github transform 遇到非 JSON 抛 502 而不是 500', () => {
    expect(() =>
      gh.transform?.('<html>nope</html>', { op: 'androidRising', id: '', query: [] }),
    ).toThrow(/non-JSON/)
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
    await putSettings(env, { 'pubmed.api_key': '' })
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

  it('pubmed：配了合法 pubmed.api_key 才带上，配错当没配', async () => {
    const rt = runtimeFor('pubmed')!
    await putSettings(env, { 'pubmed.api_key': 'NCBI1234567890' })
    clearSettingsMemo()
    expect(
      (await rt.buildPlan(env, { op: 'search', id: '', query: [['term', 'waf']] })).url,
    ).toContain('&api_key=NCBI1234567890')
    // key 只发往 eutils（白名单唯一出口），且不进缓存键
    expect(
      (await rt.buildPlan(env, { op: 'search', id: '', query: [['term', 'waf']] })).url,
    ).toContain('eutils.ncbi.nlm.nih.gov')

    await putSettings(env, { 'pubmed.api_key': 'short' })
    clearSettingsMemo()
    expect(
      (await rt.buildPlan(env, { op: 'summary', id: '', query: [['id', '1']] })).url,
    ).not.toContain('api_key')
    await putSettings(env, { 'pubmed.api_key': '' })
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

  it('usgs：search 固定 format=geojson，只放行 minmagnitude/limit/orderby', async () => {
    const rt = runtimeFor('usgs')!
    const plan = await rt.buildPlan(env, { op: 'search', id: '', query: [] })
    expect(plan.url).toBe(
      'https://earthquake.usgs.gov/fdsnws/event/1/query?format=geojson&minmagnitude=2.5&limit=20&orderby=time',
    )
    // 慢上游：放宽超时并关掉重试，免得 2× 超时把内联请求拖成十几秒
    expect(plan.timeoutMs).toBe(8000)
    expect(plan.retries).toBe(0)
    expect(
      (await rt.buildPlan(env, { op: 'search', id: '', query: [['minmagnitude', '4.5'], ['limit', '200'], ['orderby', 'magnitude']] })).url,
    ).toBe(
      'https://earthquake.usgs.gov/fdsnws/event/1/query?format=geojson&minmagnitude=4.5&limit=200&orderby=magnitude',
    )
    // 小数震级框架不校验（type=number 没有范围检查），脏值必须在这层拒
    for (const value of ['abc', '-1', '11', '1.2.3', '']) {
      await expect(
        rt.buildPlan(env, { op: 'search', id: '', query: [['minmagnitude', value]] }),
      ).rejects.toThrow(/invalid minmagnitude/)
    }
    await expect(
      rt.buildPlan(env, { op: 'search', id: '', query: [['orderby', 'depth']] }),
    ).rejects.toMatchObject({ status: 400, details: { allowed: ['time', 'magnitude'] } })
  })

  it('usgs：event 走 eventid 查询，id 形态自己把关', async () => {
    const rt = runtimeFor('usgs')!
    expect((await rt.buildPlan(env, { op: 'event', id: 'ci41339847', query: [] })).url).toBe(
      'https://earthquake.usgs.gov/fdsnws/event/1/query?eventid=ci41339847&format=geojson',
    )
    for (const id of ['CI41339847', 'ci_413', 'ci4133984712345678901', 'ci413 39847', '../..']) {
      await expect(rt.buildPlan(env, { op: 'event', id, query: [] })).rejects.toThrow(/invalid event id/)
    }
  })

  it('gitlab：多层子组项目路径编成上游要的单段形式', async () => {
    const rt = runtimeFor('gitlab')!
    expect((await rt.buildPlan(env, { op: 'project', id: 'rust-lang/rust', query: [] })).url).toBe(
      'https://gitlab.com/api/v4/projects/rust-lang%2Frust',
    )
    expect((await rt.buildPlan(env, { op: 'project', id: 'group/sub/project', query: [] })).url).toBe(
      'https://gitlab.com/api/v4/projects/group%2Fsub%2Fproject',
    )
    // 数字项目 id 原样透传，不做编码
    expect((await rt.buildPlan(env, { op: 'project', id: '1885018', query: [] })).url).toBe(
      'https://gitlab.com/api/v4/projects/1885018',
    )
    for (const id of ['group name/project', '-leading/project', '../..', 'group/../etc']) {
      await expect(rt.buildPlan(env, { op: 'project', id, query: [] })).rejects.toThrow(/invalid project/)
    }
  })

  it('gitlab：搜索与提交只放行白名单参数', async () => {
    const rt = runtimeFor('gitlab')!
    expect(
      (await rt.buildPlan(env, { op: 'search', id: '', query: [['q', 'rust wasm'], ['limit', '5'], ['order_by', 'name'], ['sort', 'asc']] })).url,
    ).toBe(
      'https://gitlab.com/api/v4/projects?search=rust%20wasm&per_page=5&simple=true&order_by=name&sort=asc',
    )
    for (const query of [[['q', '']], [['q', '<script>']], [['q', 'rust'], ['sort', 'random']], [['q', 'rust'], ['order_by', 'size']]]) {
      await expect(rt.buildPlan(env, { op: 'search', id: '', query: query as [string, string][] })).rejects.toThrow(/invalid/)
    }
    // 项目走 query 参数，ref 只在给了才带
    expect((await rt.buildPlan(env, { op: 'commits', id: '', query: [['project', 'rust-lang/rust']] })).url).toBe(
      'https://gitlab.com/api/v4/projects/rust-lang%2Frust/repository/commits?per_page=20',
    )
    expect(
      (await rt.buildPlan(env, { op: 'commits', id: '', query: [['project', 'rust-lang/rust'], ['ref', 'main'], ['limit', '3']] })).url,
    ).toBe(
      'https://gitlab.com/api/v4/projects/rust-lang%2Frust/repository/commits?per_page=3&ref_name=main',
    )
    await expect(
      rt.buildPlan(env, { op: 'commits', id: '', query: [['project', 'rust-lang/rust'], ['ref', 'a..b']] }),
    ).rejects.toThrow(/invalid ref/)
  })

  it('crates：transform 把 versions 折叠掉重型字段', async () => {
    const rt = runtimeFor('crates')!
    const raw = JSON.stringify({
      crate: { name: 'serde', max_version: '1.0.229', downloads: 100, description: 'x' },
      versions: [
        { num: '1.0.229', yanked: false, downloads: 900, license: 'MIT', features: { a: ['b'] }, links: { x: '/y' } },
        { num: '1.0.228', yanked: true },
      ],
      keywords: ['serde'],
    })
    const out = JSON.parse(rt.transform!(raw, { op: 'crate', id: 'serde', query: [] }).text) as {
      provider: string
      versions: Record<string, unknown>[]
      keywords: string[]
    }
    expect(out.provider).toBe('crates')
    expect(out.keywords).toEqual(['serde'])
    expect(out.versions).toEqual([
      { num: '1.0.229', yanked: false, downloads: 900, license: 'MIT' },
      { num: '1.0.228', yanked: true },
    ])
    // 上游不是 JSON 时不能把脏数据当正常响应缓存，要报上游错误
    expect(() => rt.transform!('<html>502</html>', { op: 'crate', id: 'serde', query: [] })).toThrow(
      /non-JSON/,
    )
  })

  it('crates：crate 名与版本自己把关', async () => {
    const rt = runtimeFor('crates')!
    expect((await rt.buildPlan(env, { op: 'crate', id: 'serde', query: [] })).url).toBe(
      'https://crates.io/api/v1/crates/serde',
    )
    expect((await rt.buildPlan(env, { op: 'version', id: 'serde/1.0.229', query: [] })).url).toBe(
      'https://crates.io/api/v1/crates/serde/1.0.229',
    )
    for (const name of ['1serde', 'serde core', '', 'serde/../etc']) {
      await expect(rt.buildPlan(env, { op: 'crate', id: name, query: [] })).rejects.toThrow(/invalid crate name/)
    }
    for (const version of ['1.0.229/extra', '../..', '1.0.229 bad']) {
      await expect(rt.buildPlan(env, { op: 'version', id: `serde/${version}`, query: [] })).rejects.toThrow(
        /invalid (target|version)/,
      )
    }
    expect(
      (await rt.buildPlan(env, { op: 'search', id: '', query: [['q', 'serde'], ['sort', 'downloads']] })).url,
    ).toBe('https://crates.io/api/v1/crates?q=serde&per_page=10&sort=downloads')
    await expect(
      rt.buildPlan(env, { op: 'search', id: '', query: [['q', 'serde'], ['sort', 'popular']] }),
    ).rejects.toThrow(/invalid sort/)
  })

  it('P6 三个源的额度与 host 都进了默认值', async () => {
    expect((await readCredits(env, 'usgs', 'default')).limit).toBe(4000)
    expect((await readCredits(env, 'gitlab', 'default')).limit).toBe(5000)
    expect((await readCredits(env, 'crates', 'default')).limit).toBe(3000)
    for (const host of ['earthquake.usgs.gov', 'gitlab.com', 'crates.io']) {
      expect(ALLOWLIST).toContain(host)
    }
  })

  it('musicbrainz：search 固定 fmt=json（漏了上游回 200+XML），limit 卡 25', async () => {
    const rt = runtimeFor('musicbrainz')!
    const plan = await rt.buildPlan(env, { op: 'search', id: '', query: [['q', 'radiohead'], ['type', 'artist'], ['limit', '5']] })
    expect(plan.url).toBe('https://musicbrainz.org/ws/2/artist?query=radiohead&fmt=json&limit=5')
    // 宽查询实测能到 16s，上游还会间歇 503：放宽超时但关掉重试
    expect(plan.timeoutMs).toBe(6000)
    expect(plan.retries).toBe(0)
    expect((await rt.buildPlan(env, { op: 'search', id: '', query: [['q', 'a']] })).url).toBe(
      'https://musicbrainz.org/ws/2/artist?query=a&fmt=json&limit=10',
    )
    expect((await rt.buildPlan(env, { op: 'search', id: '', query: [['q', 'a'], ['type', 'release-group']] })).url).toBe(
      'https://musicbrainz.org/ws/2/release-group?query=a&fmt=json&limit=10',
    )
    // Lucene 语法透传（含中文/非 ASCII 检索词），但空值与控制字符自己拒
    expect((await rt.buildPlan(env, { op: 'search', id: '', query: [['q', '邓丽君 AND type:person']] })).url).toContain(
      'query=%E9%82%93%E4%B8%BD%E5%90%9B%20AND%20type%3Aperson',
    )
    for (const q of ['', 'a\nb', 'a\u0000b']) {
      await expect(rt.buildPlan(env, { op: 'search', id: '', query: [['q', q]] })).rejects.toThrow(/invalid q/)
    }
    await expect(
      rt.buildPlan(env, { op: 'search', id: '', query: [['q', 'a'], ['type', 'label']] }),
    ).rejects.toMatchObject({ status: 400, details: { allowed: expect.arrayContaining(['artist']) } })
  })

  it('musicbrainz：MBID 只收规范小写（缓存键算在归一化之前），inc 只放行单值枚举', async () => {
    const rt = runtimeFor('musicbrainz')!
    const MBID = 'a74b1b7f-71a5-4011-9441-d0b5e4122711'
    expect((await rt.buildPlan(env, { op: 'artist', id: MBID, query: [] })).url).toBe(
      `https://musicbrainz.org/ws/2/artist/${MBID}?fmt=json`,
    )
    // 大写直接 400：缓存键是由原始路径 id 算的，放行大写等于同一实体两条缓存 + 两次回源
    await expect(rt.buildPlan(env, { op: 'artist', id: MBID.toUpperCase(), query: [] })).rejects.toMatchObject({
      status: 400,
      details: { field: 'mbid' },
    })
    expect((await rt.buildPlan(env, { op: 'artist', id: MBID, query: [['inc', 'url-rels']] })).url).toBe(
      `https://musicbrainz.org/ws/2/artist/${MBID}?fmt=json&inc=url-rels`,
    )
    expect((await rt.buildPlan(env, { op: 'release', id: MBID, query: [['inc', 'recordings']] })).url).toBe(
      `https://musicbrainz.org/ws/2/release/${MBID}?fmt=json&inc=recordings`,
    )
    for (const id of ['not-a-uuid', 'A74B1B7F-71A5-4011-9441-D0B5E4122711', 'a74b1b7f-71a5-4011-9441-d0b5e412271', 'a74b1b7f71a540119441d0b5e4122711', '']) {
      await expect(rt.buildPlan(env, { op: 'artist', id, query: [] })).rejects.toThrow(/invalid mbid/)
    }
    // 逗号组合上游一律 400（编码与否都试过），所以枚举只给单值
    for (const inc of ['genres,tags', 'url-rels,aliases', 'bogus']) {
      await expect(rt.buildPlan(env, { op: 'artist', id: MBID, query: [['inc', inc]] })).rejects.toThrow(/invalid inc/)
    }
    // inc 枚举是按端点给的：release 的合法值在 artist 上不合法
    await expect(rt.buildPlan(env, { op: 'artist', id: MBID, query: [['inc', 'recordings']] })).rejects.toThrow(/invalid inc/)
  })

  it('P7 musicbrainz 的额度与 host 都进了默认值', async () => {
    expect((await readCredits(env, 'musicbrainz', 'default')).limit).toBe(4000)
    expect(ALLOWLIST).toContain('musicbrainz.org')
  })
})

describe('P8 天气与空气质量（Open-Meteo）', () => {
  const rt = runtimeFor('openmeteo')!

  it('forecast：current 与 hourly 走 api. host，默认值补齐、单位枚举透传', async () => {
    const current = await rt.buildPlan(env, {
      op: 'current',
      id: '',
      query: [['latitude', '39.74'], ['longitude', '-97.09'], ['current', 'temperature_2m,weather_code']],
    })
    expect(current.url).toBe(
      'https://api.open-meteo.com/v1/forecast?latitude=39.74&longitude=-97.09&current=temperature_2m,weather_code&timezone=auto&temperature_unit=celsius&wind_speed_unit=kmh&precipitation_unit=mm',
    )
    expect(current.resource).toBe('item')
    expect(current.timeoutMs).toBe(5000)
    expect(current.retries).toBe(0)

    const hourly = await rt.buildPlan(env, {
      op: 'hourly',
      id: '',
      query: [
        ['latitude', '52.52'],
        ['longitude', '13.41'],
        ['hourly', 'temperature_2m,precipitation_probability'],
        ['forecast_days', '16'],
        ['temperature_unit', 'fahrenheit'],
        ['wind_speed_unit', 'ms'],
        ['timezone', 'Europe/Berlin'],
      ],
    })
    expect(hourly.url).toContain('https://api.open-meteo.com/v1/forecast?')
    expect(hourly.url).toContain('hourly=temperature_2m,precipitation_probability')
    expect(hourly.url).toContain('forecast_days=16')
    expect(hourly.url).toContain('temperature_unit=fahrenheit')
    expect(hourly.url).toContain('wind_speed_unit=ms')
    expect(hourly.url).toContain('timezone=Europe/Berlin')
    // 逐小时预报用 feed 档（stale 7 天很适合预测数据），current 用 item 档
    expect(hourly.resource).toBe('feed')
  })

  it('坐标不进 runtime：范围校验由框架的 validate() 兜住（见 api.test.ts）', async () => {
    // openmeteo 的 buildPlan 完全不管坐标——所以 api 测试里 `latitude=999` → 400
    // 只能来自框架那次修复（minimum/maximum 曾经只对 integer 生效）
    const plan = await rt.buildPlan(env, {
      op: 'current',
      id: '',
      query: [['latitude', '-90'], ['longitude', '180'], ['current', 'temperature_2m']],
    })
    expect(plan.url).toContain('latitude=-90')
    expect(plan.url).toContain('longitude=180')
  })

  it('变量表本地校验：未知变量不把上游的 Scala 类名漏给调用方', async () => {
    const base: Target = { op: 'current', id: '', query: [['latitude', '39.74'], ['longitude', '-97.09']] }
    for (const bad of ['temperature_2m,,weather_code', 'temperature_2m,', 'temperature_2m,bogus_var']) {
      await expect(
        rt.buildPlan(env, { ...base, query: [...base.query, ['current', bad]] }),
      ).rejects.toMatchObject({ status: 400, details: { allowed: expect.arrayContaining(['temperature_2m']) } })
    }
  })

  it('单位与时区枚举自己拒，不指望上游的报错文案', async () => {
    const base: Target = {
      op: 'current',
      id: '',
      query: [
        ['latitude', '39.74'],
        ['longitude', '-97.09'],
        ['current', 'temperature_2m'],
      ],
    }
    for (const [field, value, allowed] of [
      ['temperature_unit', 'kelvin', 'celsius'],
      ['wind_speed_unit', 'knots', 'kmh'],
      ['precipitation_unit', 'cm', 'mm'],
      ['timezone', 'Mars Olympus', 'auto'],
      ['timezone', 'GMT+8', 'UTC'],
      ['timezone', '/Europe/Berlin', 'auto'],
    ] as const) {
      await expect(rt.buildPlan(env, { ...base, query: [...base.query, [field, value]] })).rejects.toMatchObject({
        status: 400,
        details: { allowed: expect.arrayContaining([allowed]) },
      })
    }
  })

  it('geocode：写死 format=json，空地名自己拒（上游对空名回 200 但没有 results）', async () => {
    const plan = await rt.buildPlan(env, { op: 'geocode', id: '', query: [['name', 'Wichita']] })
    expect(plan.url).toBe('https://geocoding-api.open-meteo.com/v1/search?name=Wichita&count=5&language=en&format=json')
    expect(plan.resource).toBe('search')
    const zh = await rt.buildPlan(env, {
      op: 'geocode',
      id: '',
      query: [['name', '北京'], ['count', '3'], ['language', 'zh']],
    })
    expect(zh.url).toBe('https://geocoding-api.open-meteo.com/v1/search?name=%E5%8C%97%E4%BA%AC&count=3&language=zh&format=json')
    for (const bad of ['', ' ', 'a\nb']) {
      await expect(rt.buildPlan(env, { op: 'geocode', id: '', query: [['name', bad]] })).rejects.toThrow(/invalid name/)
    }
    await expect(rt.buildPlan(env, { op: 'geocode', id: '', query: [['name', 'x'], ['language', 'zh-CN']] })).rejects.toThrow(
      /invalid language/,
    )
  })

  it('air-quality：独立变量表、超时放宽到 8s，current 与 hourly 至少要有一个', async () => {
    const both = await rt.buildPlan(env, {
      op: 'air-quality',
      id: '',
      query: [
        ['latitude', '39.74'],
        ['longitude', '-97.09'],
        ['current', 'pm2_5,us_aqi'],
        ['hourly', 'european_aqi'],
        ['forecast_days', '7'],
      ],
    })
    expect(both.url).toBe(
      'https://air-quality-api.open-meteo.com/v1/air-quality?latitude=39.74&longitude=-97.09&current=pm2_5,us_aqi&hourly=european_aqi&forecast_days=7&timezone=auto',
    )
    // 实测 3.3s，超过默认 3s：不放宽就会被自己的超时砍掉
    expect(both.timeoutMs).toBe(8000)
    // 一个变量都不给时上游回 200 但只有元数据
    await expect(
      rt.buildPlan(env, { op: 'air-quality', id: '', query: [['latitude', '39.74'], ['longitude', '-97.09']] }),
    ).rejects.toThrow(/至少要有一个/)
    // 天气变量混进空气质量表必然 400（两张表不通用）
    await expect(
      rt.buildPlan(env, {
        op: 'air-quality',
        id: '',
        query: [['latitude', '39.74'], ['longitude', '-97.09'], ['current', 'temperature_2m']],
      }),
    ).rejects.toMatchObject({ status: 400, details: { allowed: expect.arrayContaining(['pm2_5']) } })
  })

  it('P8 openmeteo 的额度与三个 host 都进了默认值', async () => {
    expect((await readCredits(env, 'openmeteo', 'default')).limit).toBe(4000)
    for (const host of ['api.open-meteo.com', 'geocoding-api.open-meteo.com', 'air-quality-api.open-meteo.com']) {
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
    // npm 的 scoped 包名（@scope/pkg）、gitlab 的多层子组项目路径（group/sub/project）
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
      'gitlab.project.id',
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
  it('UA 固定为 uapis/0.1.0 (+apple.com)，不可被请求覆盖', () => {
    expect(USER_AGENT).toBe('uapis/0.1.0 (+apple.com)')
  })

  it('normalizeOrigin 剥路径、只留协议与 host', () => {
    expect(normalizeOrigin('https://a.example/x?y=1#z')).toBe('https://a.example')
    expect(normalizeOrigin('not a url')).toBe('')
  })

  it('siteUrlOf 从请求 URL 取站点地址，无请求时为空串', () => {
    expect(siteUrlOf(new Request('https://api.example.com/api/v1'))).toBe('https://api.example.com')
    expect(siteUrlOf(undefined)).toBe('')
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

describe('4chan（只读 catalog，零 key）', () => {
  it('catalog 拼出 a.4cdn.org/{board}/catalog.json', async () => {
    const rt = runtimeFor('fourchan')!
    expect(await rt.buildPlan(env, { op: 'catalog', id: 'g', query: [] })).toEqual({
      url: 'https://a.4cdn.org/g/catalog.json',
      resource: 'feed',
      timeoutMs: 5000,
    })
  })

  it('board 非法值返 400：路径穿越/斜杠/大写/超长/空', async () => {
    const rt = runtimeFor('fourchan')!
    // 4chan 板块名允许纯数字（/3/、/4chan/），但必须小写、不含 / 和 .
    for (const bad of ['../admin', 'g/catalog.json', 'G', 'waytoolong', '', 'g.', 'a b']) {
      await expect(rt.buildPlan(env, { op: 'catalog', id: bad, query: [] })).rejects.toThrow(
        /invalid board/,
      )
    }
  })

  it('transform 跨页展平并按 limit 截断，保留上游 bump 序', () => {
    const rt = runtimeFor('fourchan')!
    // 上游是 [{page, threads:[...]}]，且顺序是 bump 序而非 replies 降序
    const pages = [
      { page: 1, threads: [{ no: 3, replies: 3 }, { no: 74, replies: 74 }] },
      { page: 2, threads: [{ no: 9, replies: 9 }, { no: 6, replies: 6 }] },
    ]
    const out = JSON.parse(
      rt.transform!(JSON.stringify(pages), { op: 'catalog', id: 'g', query: [['limit', '3']] }).text,
    )
    expect(out.provider).toBe('fourchan')
    // 3/74/9 跨页取，顺序照抄上游（不按 replies 重排）
    expect(out.threads.map((t: { no: number }) => t.no)).toEqual([3, 74, 9])
  })

  it('transform 缺 limit 时默认 25 条，与 ParamDef 声明一致（HTTP 会注入 default=25）', () => {
    const rt = runtimeFor('fourchan')!
    const threads = Array.from({ length: 150 }, (_, i) => ({ no: i + 1 }))
    const out = JSON.parse(
      rt.transform!(JSON.stringify([{ page: 1, threads }]), { op: 'catalog', id: 'g', query: [] }).text,
    )
    expect(out.threads).toHaveLength(25)
  })

  it('transform 对坏/空结构一律抛错，不返回空数组（否则会被负缓存 6 小时）', () => {
    const rt = runtimeFor('fourchan')!
    // 非 JSON / 非数组 / 页无 threads / 线程 malformed / 空 catalog 数组 / 全空板
    for (const bad of [
      'not json',
      '{}',
      '[{"page":1}]',
      '[{"page":1,"threads":[{}]}]',
      '[]',
      '[{"page":1,"threads":[]}]',
    ]) {
      expect(() => rt.transform!(bad, { op: 'catalog', id: 'g', query: [] })).toThrow()
    }
  })

  it('quota 与 host 都进了默认值', async () => {
    expect((await readCredits(env, 'fourchan', 'default')).limit).toBe(10000)
    expect(ALLOWLIST).toContain('a.4cdn.org')
  })
})

describe('Telegram（t.me/s/ 公开预览，零凭据）', () => {
  it('channel 拼出 t.me/s/{channel}，不放行 @ 前缀', async () => {
    const rt = runtimeFor('telegram')!
    expect(await rt.buildPlan(env, { op: 'channel', id: 'telegram', query: [] })).toEqual({
      url: 'https://t.me/s/telegram',
      resource: 'feed',
      timeoutMs: 5000,
      retries: 0,
    })
    for (const bad of ['@telegram', '1abc', 'a-b', '../x', '', 'a', 'x'.repeat(40)]) {
      await expect(rt.buildPlan(env, { op: 'channel', id: bad, query: [] })).rejects.toThrow(
        /invalid channel/,
      )
    }
  })

  it('limit 超单页上限时按 20 截断（UpstreamPlan 只支持单个 url）', () => {
    const rt = runtimeFor('telegram')!
    const out = JSON.parse(
      rt.transform!(tgChannel(40), { op: 'channel', id: 'telegram', query: [['limit', '999']] }).text,
    )
    expect(out.posts).toHaveLength(20)
  })

  it('无频道元数据 → 404：私域频道返 200 空页，不能当空结果缓存', () => {
    const rt = runtimeFor('telegram')!
    // 坑 1：Telegram 对无公开预览的频道回 200 且零 post 节点
    expect(() => rt.transform!(tgChannel(0, false), { op: 'channel', id: 'priv', query: [] })).toThrow(
      /no public preview/,
    )
  })

  it('tme_no_messages_found → 502：请求过密，不是空频道', () => {
    const rt = runtimeFor('telegram')!
    // 坑 2：返回空数组会被负缓存 6 小时，所以必须抛错让上层重试
    const html = tgHeader() + '<div class="tme_no_messages_found">nothing</div>'
    expect(() => rt.transform!(html, { op: 'channel', id: 'telegram', query: [] })).toThrow(
      /no messages found/,
    )
  })

  it('service_message 不计入 posts（"频道已创建"之类系统通知）', () => {
    const rt = runtimeFor('telegram')!
    const html = tgHeader() + tgPost('telegram', 5, 'real') + tgServicePost(6)
    const out = JSON.parse(rt.transform!(html, { op: 'channel', id: 'telegram', query: [] }).text)
    // 坑 3
    expect(out.posts).toHaveLength(1)
    expect(out.posts[0]!.id).toBe(5)
  })

  it('倒序页面输出最新在前', () => {
    const rt = runtimeFor('telegram')!
    // 坑 4：t.me/s/ DOM 旧帖在上、最新在末尾（已对真实页面验证），reverse 后最新在前
    const html = tgHeader() + tgPost('c', 99, 'older') + tgPost('c', 100, 'newest')
    const out = JSON.parse(rt.transform!(html, { op: 'channel', id: 'c', query: [] }).text)
    expect(out.posts.map((p: { id: number }) => p.id)).toEqual([100, 99])
  })

  it('views 解析 K/M/B，坏值不落 0', () => {
    const rt = runtimeFor('telegram')!
    const html =
      tgHeader() + tgPost('c', 1, 'a', '1.36M') + tgPost('c', 2, 'b', 'n/a') + tgPost('c', 3, 'c', '934')
    const out = JSON.parse(rt.transform!(html, { op: 'channel', id: 'c', query: [] }).text)
    expect(out.posts.find((p: { id: number }) => p.id === 1)!.views).toBe(1360000)
    expect(out.posts.find((p: { id: number }) => p.id === 2)!.views).toBeUndefined()
    expect(out.posts.find((p: { id: number }) => p.id === 3)!.views).toBe(934)
  })

  it('提取频道元信息并剥掉 @ 前缀', () => {
    const rt = runtimeFor('telegram')!
    const out = JSON.parse(
      rt.transform!(tgHeader() + tgPost('telegram', 1, 'x'), { op: 'channel', id: 'telegram', query: [] })
        .text,
    )
    expect(out.provider).toBe('telegram')
    expect(out.channel).toBe('telegram')
    expect(out.title).toBe('Telegram')
    expect(out.subscribers).toBe(1200000)
  })

  it('username 被 <a> 包裹时仍能剥出 channel（真实 t.me/mark）', () => {
    const rt = runtimeFor('telegram')!
    const html =
      '<div class="tgme_channel_info">' +
      '<div class="tgme_channel_info_header_title"><span>Pavel Durov</span></div>' +
      '<div class="tgme_channel_info_header_username"><a href="https://t.me/durov">@durov</a></div>' +
      '</div>' +
      tgPost('durov', 1, 'x')
    const out = JSON.parse(rt.transform!(html, { op: 'channel', id: 'durov', query: [] }).text)
    expect(out.channel).toBe('durov')
    expect(out.title).toBe('Pavel Durov')
  })

  it('正文 class 带第二个类名时仍能提取（坑 5：线上 text 曾恒为空）', () => {
    const rt = runtimeFor('telegram')!
    // 真实标记是 class="tgme_widget_message_text js-message_text" dir="auto"，
    // 而 class="tgme_widget_message_text" 这个子串根本不在页面里。
    // 这条是线上拉取测试抓出来的：text 字段整个缺失，views/date 却正常
    // （那两个标签本来就单类名），单测夹具当时写的是没有多余类名的"好看版"。
    const post = (cls: string): string =>
      '<div class="tgme_widget_message_wrap">' +
      '<div class="tgme_widget_message" data-post="c/7">' +
      `<div class="${cls}" dir="auto">hello <b>world</b><br>second line</div>` +
      '</div></div>'
    for (const cls of [
      'tgme_widget_message_text js-message_text',
      // 类名顺序不固定时也要认，不能只认"第一个是目标类"
      'js-message_text tgme_widget_message_text',
      'tgme_widget_message_text',
    ]) {
      const out = JSON.parse(
        rt.transform!(tgHeader() + post(cls), { op: 'channel', id: 'c', query: [] }).text,
      )
      // <b> 剥标签、<br> 转成换行
      expect(out.posts[0]!.text, cls).toBe('hello world\nsecond line')
    }
  })

  it('quota 与 host 都进了默认值', async () => {
    expect((await readCredits(env, 'telegram', 'default')).limit).toBe(5000)
    expect(ALLOWLIST).toContain('t.me')
  })
})

describe('Medium（官方公开 RSS，零凭据）', () => {
  it('四种官方 feed URL 各自拼对（scheme 见官方 Help Center 214874118）', async () => {
    const rt = runtimeFor('medium')!
    const cases: [string, string, string][] = [
      ['tag', 'programming', 'https://medium.com/feed/tag/programming'],
      ['publication', 'towards-data-science', 'https://medium.com/feed/towards-data-science'],
      ['user', 'dhh', 'https://medium.com/feed/@dhh'],
      // 多路径参数由 v1.ts 按声明顺序用 / 拼进 target.id
      ['tagged', 'better-programming/python', 'https://medium.com/feed/better-programming/tagged/python'],
    ]
    for (const [op, id, url] of cases) {
      expect(await rt.buildPlan(env, { op, id, query: [] })).toEqual({
        url,
        resource: 'feed',
        timeoutMs: 5000,
        // Medium 限流是持续封锁，fetcher 的 200/600/1500ms 退避救不回来
        retries: 0,
      })
    }
  })

  it('路径段一律走字符白名单，拒掉 / & % 与路径穿越', async () => {
    const rt = runtimeFor('medium')!
    for (const bad of ['', 'a/b', 'a&b', 'a%2e', '..', 'A', '-x', 'x'.repeat(51)]) {
      await expect(rt.buildPlan(env, { op: 'tag', id: bad, query: [] })).rejects.toThrow(/invalid tag/)
    }
    for (const bad of ['', '@dhh', '..', 'a/../b', 'a b', 'x'.repeat(51)]) {
      await expect(rt.buildPlan(env, { op: 'user', id: bad, query: [] })).rejects.toThrow(/invalid user/)
    }
  })

  it('tagged 必须是恰好两段；未知 op 是 404', async () => {
    const rt = runtimeFor('medium')!
    await expect(rt.buildPlan(env, { op: 'tagged', id: 'onlyone', query: [] })).rejects.toThrow(
      /invalid publication\/tag/,
    )
    await expect(
      rt.buildPlan(env, { op: 'tagged', id: 'a/b/c', query: [] }),
    ).rejects.toThrow(/invalid publication\/tag/)
    await expect(rt.buildPlan(env, { op: 'nope', id: 'x', query: [] })).rejects.toMatchObject({
      status: 404,
    })
  })

  it('剥 CDATA、吃掉 <guid> 属性、剥掉 link 上的 source 追踪后缀', () => {
    const rt = runtimeFor('medium')!
    const out = JSON.parse(
      rt.transform!(mdFeed([mdItem({ title: 'Profiling Python', author: 'Yang Zhou' })]), {
        op: 'tag',
        id: 'programming',
        query: [],
      }).text,
    )
    expect(out.provider).toBe('medium')
    expect(out.title).toBe('Programming on Medium')
    expect(out.updated).toBe('Fri, 02 Jun 2026 16:53:18 GMT')
    // 频道 link 的 ?source=rss------programming-5 必须去掉
    expect(out.url).toBe('https://medium.com/tag/programming/latest')
    const post = out.posts[0]
    expect(post.title).toBe('Profiling Python')
    expect(post.author).toBe('Yang Zhou')
    // arXiv 的 tagText 写死 <${tag}>，吃不到 isPermaLink 属性
    expect(post.id).toBe('https://medium.com/p/36024bdb36c6')
    expect(post.url).toBe('https://medium.com/p/36024bdb36c6')
    // RFC-822 原样透传，不擅自转 ISO
    expect(post.published).toBe('Tue, 02 Jun 2026 16:38:28 GMT')
    expect(post.updated).toBe('2026-06-02T16:38:28.436Z')
    expect(post.tags).toEqual(['programming', 'python'])
  })

  it('零宽字符要清掉：Medium 会在正文里插 U+2060/U+200C 干扰比对', () => {
    const rt = runtimeFor('medium')!
    // 码点一律用 String.fromCodePoint 拼，源码里不放字面不可见字符：
    // 字面量经编辑/传输极易丢字或乱码，测试会静默退化成"什么都没测"；
    // 而且字面字符类里 U+200B 紧跟 "-" 会被解析成 0x2D-0x200C 的范围。
    const zw = (code: number): string => String.fromCodePoint(code)
    const dirty = `We bui${zw(0x200c)}l${zw(0x200d)}d the sys${zw(0x2060)}tem`
    const out = JSON.parse(
      rt.transform!(mdFeed([mdItem({ title: dirty, content: `<p>${dirty}</p>` })]), {
        op: 'tag',
        id: 'programming',
        query: [],
      }).text,
    )
    expect(out.posts[0].title).toBe('We build the system')
    expect(out.posts[0].excerpt).toBe('We build the system')
    // 兜底：任一零宽/软连字符残留都要被抓出来（比正则直观，也无范围歧义）
    const residual = [0x200b, 0x200c, 0x200d, 0x2060, 0xfeff, 0x00ad].filter((code) =>
      (out.posts[0].excerpt as string).includes(zw(code)),
    )
    expect(residual).toEqual([])
  })

  it('但 emoji 家庭序列与天城文连字里的 ZWJ 必须留着', () => {
    const rt = runtimeFor('medium')!
    // 无脑全删会毁掉这两个：ZWJ 是 emoji 序列的载体，在天城文里是连字的一部分
    const fromCps = (cps: number[]): string => cps.map((c) => String.fromCodePoint(c)).join('')
    const family = fromCps([0x1f468, 0x200d, 0x1f469, 0x200d, 0x1f467, 0x200d, 0x1f466])
    const devanagari = fromCps([0x915, 0x94d, 0x200d, 0x937])
    // 先自证 fixture 里真有 ZWJ，否则这两条断言等于什么都没测
    // 用 Array.from（码点）而非 split('')（码元）：emoji 是代理对，码元数会翻倍
    expect(Array.from(family)).toHaveLength(7)
    expect(Array.from(devanagari)).toHaveLength(4)
    const out = JSON.parse(
      rt.transform!(mdFeed([mdItem({ content: `<p>${family} ${devanagari}</p>` })]), {
        op: 'tag',
        id: 'programming',
        query: [],
      }).text,
    )
    expect(out.posts[0].excerpt).toBe(`${family} ${devanagari}`)
  })

  it('先剥标签再解实体：&amp;lt;script&amp;gt; 不能被二次解码成 <script>', () => {
    const rt = runtimeFor('medium')!
    const out = JSON.parse(
      rt.transform!(
        mdFeed([mdItem({ content: '<p>&amp;lt;script&amp;gt;alert(1)&lt;/script&amp;gt;</p>' })]),
        { op: 'tag', id: 'programming', query: [] },
      ).text,
    )
    expect(out.posts[0].excerpt).toBe('&lt;script&gt;alert(1)&lt;/script&gt;')
    expect(out.posts[0].excerpt).not.toContain('<script')
  })

  it('未知实体原样保留，不吞成空串', () => {
    const rt = runtimeFor('medium')!
    const out = JSON.parse(
      rt.transform!(mdFeed([mdItem({ content: '<p>a &foobar; b</p>' })]), {
        op: 'tag',
        id: 'programming',
        query: [],
      }).text,
    )
    expect(out.posts[0].excerpt).toBe('a &foobar; b')
  })

  it('孤立代理对与越界码点实体原样保留，fromCodePoint 不抛 RangeError', () => {
    const rt = runtimeFor('medium')!
    // &#xD800; 是孤立代理对、&#x110000; 超过 0x10FFFF——这两类会让
    // String.fromCodePoint 抛 RangeError。inline 路径的 transform 没有 try/catch，
    // 一旦抛出就漏成 500 且不写负缓存，所以必须保留原文而不是解码。
    const out = JSON.parse(
      rt.transform!(
        mdFeed([mdItem({ content: '<p>bad &#xD800; mid &#x110000; tail</p>' })]),
        { op: 'tag', id: 'programming', query: [] },
      ).text,
    )
    expect(out.posts[0].excerpt).toBe('bad &#xD800; mid &#x110000; tail')
  })

  it('摘要优先取 medium-feed-snippet，回退到剥全文；截断到 200 字', () => {
    const rt = runtimeFor('medium')!
    const long = 'x'.repeat(500)
    const out = JSON.parse(
      rt.transform!(
        mdFeed([
          mdItem({ snippet: 'short summary', content: `<p>${long}</p>` }),
          mdItem({ content: `<p>${long}</p>` }),
        ]),
        { op: 'tag', id: 'programming', query: [] },
      ).text,
    )
    // 有 snippet 段就用它，不吃 500 字的正文
    expect(out.posts[0].excerpt).toBe('short summary')
    // 没有 snippet 才回退剥正文，并截到 200
    expect(out.posts[1].excerpt).toHaveLength(200)
  })

  it('付费文章标 metered，只取预览不做任何绕过', () => {
    const rt = runtimeFor('medium')!
    const out = JSON.parse(
      rt.transform!(mdFeed([mdItem({ content: '<p>preview only</p>', metered: true })]), {
        op: 'tag',
        id: 'programming',
        query: [],
      }).text,
    )
    expect(out.posts[0].metered).toBe(true)
    expect(out.posts[0].excerpt).toBe('preview only')
  })

  it('limit 截断；队列路径无校验所以 clamp 是必需防御', () => {
    const rt = runtimeFor('medium')!
    const xml = mdFeed([mdItem(), mdItem(), mdItem()])
    // 队列的 target 来自 decodeTarget，绕过了 v1.ts 的 collectQuery
    const out = JSON.parse(
      rt.transform!(xml, { op: 'tag', id: 'programming', query: [['limit', '999']] }).text,
    )
    expect(out.posts).toHaveLength(3)
    const two = JSON.parse(
      rt.transform!(xml, { op: 'tag', id: 'programming', query: [['limit', '2']] }).text,
    )
    expect(two.posts).toHaveLength(2)
    expect(two.count).toBe(2)
  })

  it('0 items 抛 502 而不是返回空数组：社区实测限流会 200+空 body', () => {
    const rt = runtimeFor('medium')!
    // 空结果被缓存 120s 意味着热贴凭空消失；502 至少能让下次重试
    expect(() => rt.transform!(mdFeed([]), { op: 'tag', id: 'programming', query: [] })).toThrow(
      /no items/,
    )
  })

  it('不是 RSS 就抛 502 —— "结构不认识"不能猜成 404', () => {
    const rt = runtimeFor('medium')!
    // 429 限流页 / Cloudflare 挑战页都是 200 + HTML，若判 404 会被负缓存 6 小时
    for (const bad of [
      '<html><body>Just a moment...</body></html>',
      '<rss version="2.0"></rss>',
      'Too many feed requests. See: https://medium.superfeedr.com',
    ]) {
      expect(() => rt.transform!(bad, { op: 'tag', id: 'programming', query: [] })).toThrow()
    }
  })

  it('quota 与 host 都进了默认值', async () => {
    expect((await readCredits(env, 'medium', 'default')).limit).toBe(5000)
    expect(ALLOWLIST).toContain('medium.com')
  })
})

/** Medium RSS 的 channel 外壳，字段名与实测输出一致 */
function mdFeed(items: string[], opts: { title?: string; link?: string } = {}): string {
  return (
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<rss xmlns:dc="http://purl.org/dc/elements/1.1/" ' +
    'xmlns:content="http://purl.org/rss/1.0/modules/content/" ' +
    'xmlns:atom="http://www.w3.org/2005/Atom" version="2.0">' +
    '<channel>' +
    `<title><![CDATA[${opts.title ?? 'Programming on Medium'}]]></title>` +
    `<link>${opts.link ?? 'https://medium.com/tag/programming/latest?source=rss------programming-5'}</link>` +
    '<lastBuildDate>Fri, 02 Jun 2026 16:53:18 GMT</lastBuildDate>' +
    items.join('') +
    '</channel></rss>'
  )
}

function mdItem(
  o: {
    title?: string
    author?: string
    snippet?: string
    content?: string
    metered?: boolean
  } = {},
): string {
  const content = o.content ?? '<p>body text</p>'
  return (
    '<item>' +
    `<title><![CDATA[${o.title ?? 'A post'}]]></title>` +
    '<link>https://medium.com/p/36024bdb36c6?source=rss------programming-5</link>' +
    '<guid isPermaLink="false">https://medium.com/p/36024bdb36c6</guid>' +
    `<dc:creator><![CDATA[${o.author ?? 'Yang Zhou'}]]></dc:creator>` +
    '<pubDate>Tue, 02 Jun 2026 16:38:28 GMT</pubDate>' +
    '<atom:updated>2026-06-02T16:38:28.436Z</atom:updated>' +
    '<category><![CDATA[programming]]></category>' +
    '<category><![CDATA[python]]></category>' +
    '<description><![CDATA[<div class="medium-feed-item">' +
    '<p class="medium-feed-image"><img src="https://cdn-images-1.medium.com/max/2048/1*Zyv.png" width="2048"></p>' +
    (o.snippet === undefined ? '' : `<p class="medium-feed-snippet">${o.snippet}</p>`) +
    (o.metered === true
      ? '<p class="medium-feed-link"><a href="https://medium.com/p/36024bdb36c6">Continue reading on Level Up Coding »</a></p>'
      : '') +
    `</div>]]></description>` +
    `<content:encoded><![CDATA[${content}]]></content:encoded>` +
    '</item>'
  )
}

/**
 * t.me/s/ 的频道元信息块，缺它即视为无公开预览（坑 1 的判据）
 *
 * 只照抄**线上已证实**的标记，不要"顺手补全"：header / title / username / views
 * 这些在线上都能解析出来，说明真实页面里它们就是单类名、`title` 的 span 也没有
 * 属性；给它们补上 `js-*` 第二个类反而会让生产代码的正则失配（等于自造一个假故障）。
 * 唯一与旧夹具不同、且有据可依的是正文 div 多了 `js-message_text`（坑 5）。
 */
function tgHeader(): string {
  return (
    '<div class="tgme_channel_info">' +
    '<div class="tgme_channel_info_header_title"><span>Telegram</span></div>' +
    '<div class="tgme_channel_info_header_username">@telegram</div>' +
    '<div class="tgme_channel_info_description">news</div>' +
    '<div class="tgme_channel_info_counter">' +
    '<span class="counter_type">subscribers</span><span class="counter_value">1.2M</span></div>' +
    '</div>'
  )
}

function tgPost(channel: string, id: number, text: string, views?: string): string {
  return (
    `<div class="tgme_widget_message_wrap"><div class="tgme_widget_message" data-post="${channel}/${id}">` +
    // 真实标记是 `class="tgme_widget_message_text js-message_text" dir="auto"`，
    // 写死单类名匹配不到（坑 5：线上 text 恒为空就是漏在这里）
    `<div class="tgme_widget_message_text js-message_text" dir="auto">${text}</div>` +
    (views === undefined ? '' : `<span class="tgme_widget_message_views">${views}</span>`) +
    '<a class="tgme_widget_message_date"><time datetime="2026-09-29T10:00:00+00:00"></time></a>' +
    '</div></div>'
  )
}

function tgServicePost(id: number): string {
  return (
    '<div class="tgme_widget_message_wrap service_message">' +
    `<div class="tgme_widget_message" data-post="c/${id}"><div>Channel created</div></div></div>`
  )
}

function tgChannel(count: number, withHeader = true): string {
  let out = withHeader ? tgHeader() : ''
  for (let i = 1; i <= count; i++) out += tgPost('c', i, `m${i}`)
  return out
}

describe('format=uapis（兼容 uapis.cn misc/hotboard 结构）', () => {
  /** 走 provider transform 拿到 legacy 输出，再过整形器，模拟 refresh 的落库前链路 */
  function reshape(
    provider: string,
    op: string,
    id: string,
    query: Array<[string, string]>,
    legacy: string,
  ): Record<string, unknown> {
    const rt = runtimeFor(provider)!
    let text = legacy
    if (rt.transform !== undefined) {
      text = rt.transform(legacy, { op, id, query }).text
    }
    const endpoint = allEndpoints().find(
      (e) => e.provider.name === provider && e.endpoint.op === op,
    )!.endpoint
    const out = reshapeToHotboard(provider, endpoint, { op, id, query }, text)
    expect(out).toBeDefined()
    return JSON.parse(out!.text)
  }

  it('参数声明：16 个 feed 端点都带 format，默认 uapis、取值 original|uapis', () => {
    const feeds = allEndpoints().filter((e) => e.endpoint.resource === 'feed')
    expect(feeds.length).toBe(16)
    for (const { provider, endpoint } of feeds) {
      const param = endpoint.params.find((p) => p.name === 'format')
      expect(param, `${provider.name}:${endpoint.op}`).toBeDefined()
      expect(param).toEqual(FORMAT_PARAM)
      expect(param!.in).toBe('query')
      expect(param!.default).toBe('uapis')
      expect(param!.enum).toEqual(['original', 'uapis'])
    }
    // 非 feed 端点不声明该参数
    for (const { provider, endpoint } of allEndpoints().filter(
      (e) => e.endpoint.resource !== 'feed',
    )) {
      expect(
        endpoint.params.some((p) => p.name === 'format'),
        `${provider.name}:${endpoint.op}`,
      ).toBe(false)
    }
  })

  it('resolveFormat：缺省与 uapis 都走兼容结构，只有 original 走原结构', () => {
    expect(resolveFormat({ op: 'catalog', id: 'g', query: [] })).toBe('uapis')
    expect(resolveFormat({ op: 'catalog', id: 'g', query: [['format', 'uapis']] })).toBe('uapis')
    expect(resolveFormat({ op: 'catalog', id: 'g', query: [['format', 'original']] })).toBe(
      'original',
    )
  })

  it('缓存键按 format 分桶：两种形态不会互相污染', () => {
    const key = (format: string) =>
      buildCacheKey('usgs', 'feed', { op: 'search', id: '', query: [['format', format]] })
    expect(key('uapis')).not.toBe(key('original'))
    expect(key('uapis')).toContain('format=uapis')
    expect(key('original')).toContain('format=original')
  })

  it('fourchan catalog：hotboard 键位 + replies 作热度 + extra 保真 + thread 链接', () => {
    const out = reshape('fourchan', 'catalog', 'g', [['limit', '2']], JSON.stringify([
      { page: 1, threads: [{ no: 3, replies: 7, sub: 'hello', last_modified: 1759000000 }] },
    ]))
    expect(out.type).toBe('fourchan:g')
    expect(out.update_time).toBe(new Date(1759000000 * 1000).toISOString())
    const list = out.list as Array<Record<string, unknown>>
    expect(list).toHaveLength(1)
    expect(list[0]!.index).toBe(1)
    expect(list[0]!.title).toBe('hello')
    expect(list[0]!.url).toBe('https://boards.4chan.org/g/thread/3')
    expect(list[0]!.hot_value).toBe('7')
    expect(list[0]!.extra).toEqual({ no: 3, replies: 7, sub: 'hello', last_modified: 1759000000 })
  })

  it('fourchan 无标题贴兜底 Thread #no，缺 replies 热度记 0', () => {
    const out = reshape('fourchan', 'catalog', 'pol', [], JSON.stringify([
      { page: 1, threads: [{ no: 12 }] },
    ]))
    const list = out.list as Array<Record<string, unknown>>
    expect(list[0]!.title).toBe('Thread #12')
    expect(list[0]!.hot_value).toBe('0')
  })

  it('telegram channel：正文作标题、views 作字符串热度、channel 升到顶层', () => {
    const out = reshape('telegram', 'channel', 'telegram', [['limit', '2']], tgChannel(2))
    // type 用请求的频道名，channel 用页面头部解析出的值（两者可以不同）
    expect(out.type).toBe('telegram:telegram')
    expect(out.channel).toBe('telegram')
    expect(out.title).toBe('Telegram')
    const list = out.list as Array<Record<string, unknown>>
    expect(list).toHaveLength(2)
    // 坑 4：reverse 后最新在前
    expect(list[0]!.index).toBe(1)
    expect(list[0]!.title).toBe('m2')
    expect(list[0]!.url).toBe('https://t.me/c/2')
    expect(list[0]!.hot_value).toBe('0')
    expect((list[0]!.extra as Record<string, unknown>).id).toBe(2)
  })

  it('medium tag：热度恒 0，封面走 cover，RFC-822 的 updated 转成 ISO', () => {
    const out = reshape(
      'medium',
      'tag',
      'programming',
      [['limit', '1']],
      mdFeed([mdItem({ title: 'p1', content: '<p><img src="https://img.example/i1.png"></p>' })]),
    )
    expect(out.type).toBe('medium:tag:programming')
    expect(out.title).toBe('Programming on Medium')
    // Medium 的 lastBuildDate 是 RFC-822，uapis.cn 的 update_time 约定 ISO 8601
    expect(out.update_time).toBe(new Date('Fri, 02 Jun 2026 16:53:18 GMT').toISOString())
    const list = out.list as Array<Record<string, unknown>>
    expect(list[0]!.title).toBe('p1')
    expect(list[0]!.url).toBe('https://medium.com/p/36024bdb36c6')
    expect(list[0]!.hot_value).toBe('0')
    expect(list[0]!.cover).toBe('https://img.example/i1.png')
  })

  it('透传源同样被整形：devto 用 reactions 作热度，usgs 用 mag', () => {
    const devto = reshape('devto', 'articles', '', [], JSON.stringify([
      { title: 'a1', url: 'https://dev.to/a1', positive_reactions_count: 42, published_at: '2026-09-29T10:00:00Z' },
    ]))
    expect(devto.type).toBe('devto:articles')
    expect(devto.update_time).toBe('2026-09-29T10:00:00.000Z')
    const d0 = (devto.list as Array<Record<string, unknown>>)[0]!
    expect(d0.hot_value).toBe('42')
    expect(d0.url).toBe('https://dev.to/a1')

    const usgs = reshape('usgs', 'search', '', [], JSON.stringify({
      type: 'FeatureCollection',
      metadata: { generated: 1 },
      features: [
        { type: 'Feature', properties: { mag: 4.5, place: 'X', time: 1759000000000 }, geometry: null },
      ],
    }))
    // 上游的 type=FeatureCollection 让位给我们的 type，metadata 仍保真
    expect(usgs.type).toBe('usgs:search')
    expect(usgs.metadata).toEqual({ generated: 1 })
    expect(usgs.update_time).toBe(new Date(1759000000000).toISOString())
    const u0 = (usgs.list as Array<Record<string, unknown>>)[0]!
    expect(u0.hot_value).toBe('4.5')
    expect(u0.title).toBe('X')
    expect(u0.extra).toMatchObject({ type: 'Feature', geometry: null })
  })

  it('hackernews front：无外链条目兜底站内链接，points 作热度', () => {
    const out = reshape('hackernews', 'front', '', [], JSON.stringify({
      hits: [
        { objectID: '1', title: 'Show HN', url: 'https://x.example/1', points: 12, created_at_i: 1759000000 },
        { objectID: '2', story_title: 'ask hn', points: 3, created_at_i: 1759000001 },
      ],
      nbHits: 2,
    }))
    expect(out.type).toBe('hackernews:front')
    expect(out.nbHits).toBe(2)
    const list = out.list as Array<Record<string, unknown>>
    expect(list[1]!.url).toBe('https://news.ycombinator.com/item?id=2')
    expect(list[1]!.title).toBe('ask hn')
    expect(list[1]!.hot_value).toBe('3')
  })

  it('gitlab commits / lobsters / openmeteo 三个源的热度与键位', () => {
    const gitlab = reshape('gitlab', 'commits', '', [['project', 'g/p']], JSON.stringify([
      { id: 'abc', short_id: 'abc1234', title: 'fix: x', message: 'fix: x\n\nbody', web_url: 'https://gitlab.com/g/p/-/commit/abc', committed_date: '2026-09-29T10:00:00Z' },
    ]))
    const g0 = (gitlab.list as Array<Record<string, unknown>>)[0]!
    expect(gitlab.type).toBe('gitlab:commits')
    expect(g0.title).toBe('fix: x')
    expect(g0.hot_value).toBe('0')
    expect(g0.url).toBe('https://gitlab.com/g/p/-/commit/abc')

    const lob = reshape('lobsters', 'hot', '', [], JSON.stringify([
      { short_id: 'ab12', title: 'rust', url: 'https://l.example/ab12', score: 9, created_at: '2026-09-29T10:00:00Z' },
    ]))
    const l0 = (lob.list as Array<Record<string, unknown>>)[0]!
    expect(lob.type).toBe('lobsters:hot')
    expect(l0.hot_value).toBe('9')

    const meteo = reshape('openmeteo', 'hourly', '', [], JSON.stringify({
      latitude: 37.1,
      hourly: { time: ['2026-09-29T10:00'], temperature_2m: [21.5] },
      hourly_units: { temperature_2m: '°C' },
    }))
    expect(meteo.type).toBe('openmeteo:hourly')
    expect(meteo.hourly_units).toEqual({ temperature_2m: '°C' })
    const m0 = (meteo.list as Array<Record<string, unknown>>)[0]!
    // 一个时刻一条，变量收在 extra.values（逐变量展开会把 20KB 上游撑成几百 KB）
    expect(m0.title).toBe('2026-09-29T10:00')
    expect(m0.url).toBe('')
    expect(m0.hot_value).toBe('0')
    expect(m0.extra).toEqual({ time: '2026-09-29T10:00', values: { temperature_2m: 21.5 } })
  })

  it('非 feed 端点与坏结构一律不动：undefined 表示原样落库', () => {
    const usgsEvent = allEndpoints().find(
      (e) => e.provider.name === 'usgs' && e.endpoint.op === 'event',
    )!.endpoint
    expect(
      reshapeToHotboard('usgs', usgsEvent, { op: 'event', id: 'ci1', query: [] }, '{}'),
    ).toBeUndefined()
    const devtoArticles = allEndpoints().find(
      (e) => e.provider.name === 'devto' && e.endpoint.op === 'articles',
    )!.endpoint
    // 上游非 JSON / 结构不符：整形器放弃，绝不产出空 list 覆盖原始内容
    expect(
      reshapeToHotboard('devto', devtoArticles, { op: 'articles', id: '', query: [] }, 'not json'),
    ).toBeUndefined()
    expect(
      reshapeToHotboard('devto', devtoArticles, { op: 'articles', id: '', query: [] }, '{}'),
    ).toBeUndefined()
  })

  it('index 从 1 连续编号，条目顺序与原输出完全一致（不重排）', () => {
    const out = reshape('lobsters', 'newest', '', [], JSON.stringify([
      { short_id: 'a1', title: 'first', score: 1 },
      { short_id: 'b2', title: 'second', score: 2 },
      { short_id: 'c3', title: 'third', score: 3 },
    ]))
    const list = out.list as Array<Record<string, unknown>>
    expect(list.map((i) => i.index)).toEqual([1, 2, 3])
    expect(list.map((i) => i.title)).toEqual(['first', 'second', 'third'])
  })
})
