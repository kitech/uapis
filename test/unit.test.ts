import { env as cloudflareEnv } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import { ApiError, ErrorCode, mapUpstreamStatus } from '../src/core/errors'
import { buildCacheKey, hashPairs, sanitizeId, TTL_POLICIES } from '../src/core/ttl'
import { decodeTarget, encodeTarget } from '../src/core/target'
import { parseMessage } from '../src/core/queue'
import { allEndpoints, operationIdOf, REGISTRY, validateRegistry } from '../src/core/registry'
import { buildOpenApi } from '../src/core/openapi'
import { assertAllowedUpstream, userAgent } from '../src/core/fetcher'
import { runtimeFor } from '../src/providers'

/** miniflare 的 Cloudflare.Env 缺少 src/types.ts 里声明的 ADMIN_TOKEN，测试里做一次桥接 */
const env = cloudflareEnv as unknown as Env

const ALLOWLIST = ['api.stackexchange.com', 'hn.algolia.com']

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

  it('分页参数上界统一：page ≤ 10、pagesize ≤ 100（sites 除外）', () => {
    for (const { endpoint } of allEndpoints()) {
      for (const param of endpoint.params) {
        if (param.name === 'page') expect(param.maximum).toBeLessThanOrEqual(10)
        if (param.name === 'pagesize') expect(param.maximum).toBeGreaterThanOrEqual(20)
        if (param.name === 'hitsPerPage') expect(param.maximum).toBe(100)
      }
    }
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
