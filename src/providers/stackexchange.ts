import { ErrorCode, fail } from '../core/errors'
import { getSetting } from '../core/settings'
import { queryValue } from '../core/target'
import type { Target } from '../core/target'
import type { ParamDef, ProviderDef } from '../core/registry'
import type { UpstreamPlan, ProviderRuntime } from './runtime'

const API = 'https://api.stackexchange.com/2.3'
const SITE_PATTERN = /^[a-z0-9][a-z0-9.-]{1,34}$/
const ID_PATTERN = /^[0-9]{1,12}$/

export const params: Record<string, ParamDef[]> = {
  question: [
    { name: 'id', in: 'path', type: 'string', required: true, description: '问题 ID' },
    {
      name: 'site',
      in: 'query',
      type: 'string',
      required: false,
      default: 'stackoverflow',
      description: 'Stack Exchange 站点名',
    },
    {
      name: 'filter',
      in: 'query',
      type: 'string',
      required: false,
      description: 'API 2.3 的 filter 表达式',
      maxLength: 200,
    },
  ],
  search: [
    {
      name: 'site',
      in: 'query',
      type: 'string',
      required: false,
      default: 'stackoverflow',
      description: 'Stack Exchange 站点名',
    },
    { name: 'q', in: 'query', type: 'string', required: false, description: '标题关键词', maxLength: 120 },
    { name: 'tagged', in: 'query', type: 'string', required: false, description: '逗号分隔的标签' },
    { name: 'sort', in: 'query', type: 'string', required: false, description: 'relevance/votes/activity/creation' },
    { name: 'pagesize', in: 'query', type: 'integer', required: false, description: '每页条数，1-100', default: '20', minimum: 1, maximum: 100 },
    { name: 'page', in: 'query', type: 'integer', required: false, description: '页码，0 起', default: '0', minimum: 0, maximum: 10 },
  ],
  user: [
    { name: 'id', in: 'path', type: 'string', required: true, description: '用户 ID' },
    { name: 'site', in: 'query', type: 'string', required: false, default: 'stackoverflow', description: '站点名' },
  ],
  tags: [
    { name: 'site', in: 'query', type: 'string', required: false, default: 'stackoverflow', description: '站点名' },
    { name: 'pagesize', in: 'query', type: 'integer', required: false, description: '每页条数，1-100', default: '20', minimum: 1, maximum: 100 },
    { name: 'sort', in: 'query', type: 'string', required: false, description: 'popular/name/votes' },
  ],
  answers: [
    { name: 'id', in: 'path', type: 'string', required: true, description: '问题 ID' },
    { name: 'site', in: 'query', type: 'string', required: false, default: 'stackoverflow', description: '站点名' },
    { name: 'sort', in: 'query', type: 'string', required: false, description: 'votes/creation/activity' },
    { name: 'filter', in: 'query', type: 'string', required: false, description: 'API 2.3 的 filter 表达式', maxLength: 200 },
    { name: 'pagesize', in: 'query', type: 'integer', required: false, description: '每页条数，1-100', default: '20', minimum: 1, maximum: 100 },
    { name: 'page', in: 'query', type: 'integer', required: false, description: '页码，0 起', default: '0', minimum: 0, maximum: 10 },
  ],
  comments: [
    { name: 'id', in: 'path', type: 'string', required: true, description: '问题 ID' },
    { name: 'site', in: 'query', type: 'string', required: false, default: 'stackoverflow', description: '站点名' },
    { name: 'filter', in: 'query', type: 'string', required: false, description: 'API 2.3 的 filter 表达式', maxLength: 200 },
    { name: 'pagesize', in: 'query', type: 'integer', required: false, description: '每页条数，1-100', default: '20', minimum: 1, maximum: 100 },
    { name: 'page', in: 'query', type: 'integer', required: false, description: '页码，0 起', default: '0', minimum: 0, maximum: 10 },
  ],
  sites: [
    { name: 'pagesize', in: 'query', type: 'integer', required: false, description: '每页条数，1-500', default: '100', minimum: 1, maximum: 500 },
    { name: 'page', in: 'query', type: 'integer', required: false, description: '页码，0 起', default: '0', minimum: 0, maximum: 5 },
  ],
}

export const def: ProviderDef = {
  name: 'stackexchange',
  displayName: 'Stack Exchange',
  tier: 'B',
  auth: {
    settingKey: 'se.key',
    label: 'Stack Apps API key',
    signupUrl: 'https://stackapps.com/apps/oauth/register',
  },
  hosts: ['api.stackexchange.com'],
  minIntervalMs: 300,
  uaNote: '注册 key 后可获得约 10000 次/天额度；匿名仅约 300 次/天',
  parseCostMs: 0,
  attribution: '内容版权归各站点作者，遵循 CC BY-SA',
  tos: 'https://stackoverflow.com/help/site-terms',
  limits: '注册 key 默认约 10000 次/天（https://api.stackexchange.com/docs/usage)',
  endpoints: [
    {
      op: 'question',
      resource: 'item',
      method: 'GET',
      path: '/api/v1/stackexchange/question/{id}',
      summary: '按 ID 获取单个问题（透传 Stack Exchange API 2.3）',
      params: params.question ?? [],
      passthrough: true,
      inline: true,
      costMs: 0,
    },
    {
      op: 'search',
      resource: 'search',
      method: 'GET',
      path: '/api/v1/stackexchange/search',
      summary: '搜索问题（/search/advanced 的白名单参数）',
      params: params.search ?? [],
      passthrough: true,
      inline: true,
      costMs: 0,
    },
    {
      op: 'user',
      resource: 'profile',
      method: 'GET',
      path: '/api/v1/stackexchange/user/{id}',
      summary: '获取用户信息',
      params: params.user ?? [],
      passthrough: true,
      inline: true,
      costMs: 0,
    },
    {
      op: 'tags',
      resource: 'search',
      method: 'GET',
      path: '/api/v1/stackexchange/tags',
      summary: '站点热门标签',
      params: params.tags ?? [],
      passthrough: true,
      inline: true,
      costMs: 0,
    },
    {
      op: 'answers',
      resource: 'item',
      method: 'GET',
      path: '/api/v1/stackexchange/question/{id}/answers',
      summary: '问题的回答列表（分页）',
      params: params.answers ?? [],
      passthrough: true,
      inline: true,
      costMs: 0,
    },
    {
      op: 'comments',
      resource: 'item',
      method: 'GET',
      path: '/api/v1/stackexchange/question/{id}/comments',
      summary: '问题的评论列表（分页）',
      params: params.comments ?? [],
      passthrough: true,
      inline: true,
      costMs: 0,
    },
    {
      op: 'sites',
      resource: 'search',
      method: 'GET',
      path: '/api/v1/stackexchange/sites',
      summary: 'Stack Exchange 全站点列表（该端点匿名可用）',
      params: params.sites ?? [],
      passthrough: true,
      inline: true,
      costMs: 0,
      auth: 'optional',
    },
  ],
}

export const runtime: ProviderRuntime = {
  name: def.name,
  async buildPlan(env, target): Promise<UpstreamPlan> {
    const site = normalizeSite(queryValue(target, 'site'))
    const key = await getSetting(env, 'se.key')

    const withKey = (path: string): string => {
      const url = `${API}${path}`
      if (key.length === 0) return url
      const separator = url.includes('?') ? '&' : '?'
      return `${url}${separator}key=${encodeURIComponent(key)}`
    }

    switch (target.op) {
      case 'question': {
        const id = requireId(target.id, 'id')
        return { url: withKey(`/questions/${id}?site=${site}${optionalFilter(target)}`), resource: 'item' }
      }
      case 'search': {
        const params: [string, string][] = [['site', site]]
        const q = queryValue(target, 'q')
        if (q !== undefined && q.length > 0) params.push(['title', q])
        const tagged = queryValue(target, 'tagged')
        if (tagged !== undefined && tagged.length > 0) params.push(['tagged', tagged])
        const sort = queryValue(target, 'sort')
        if (sort !== undefined && sort.length > 0) params.push(['sort', sort])
        params.push(['pagesize', queryValue(target, 'pagesize') ?? '20'])
        params.push(['page', queryValue(target, 'page') ?? '0'])
        return { url: withKey(`/search/advanced?${toQuery(params)}`), resource: 'search' }
      }
      case 'user': {
        const id = requireId(target.id, 'id')
        return { url: withKey(`/users/${id}?site=${site}`), resource: 'profile' }
      }
      case 'tags': {
        const params: [string, string][] = [
          ['site', site],
          ['pagesize', queryValue(target, 'pagesize') ?? '20'],
        ]
        const sort = queryValue(target, 'sort')
        if (sort !== undefined && sort.length > 0) params.push(['sort', sort])
        return { url: withKey(`/tags?${toQuery(params)}`), resource: 'search' }
      }
      case 'answers': {
        const id = requireId(target.id, 'id')
        const params: [string, string][] = [
          ['site', site],
          ['pagesize', queryValue(target, 'pagesize') ?? '20'],
          ['page', queryValue(target, 'page') ?? '0'],
        ]
        const sort = queryValue(target, 'sort')
        if (sort !== undefined && sort.length > 0) params.push(['sort', sort])
        return {
          url: withKey(`/questions/${id}/answers?${toQuery(params)}${optionalFilter(target)}`),
          resource: 'item',
        }
      }
      case 'comments': {
        const id = requireId(target.id, 'id')
        const params: [string, string][] = [
          ['site', site],
          ['pagesize', queryValue(target, 'pagesize') ?? '20'],
          ['page', queryValue(target, 'page') ?? '0'],
        ]
        return {
          url: withKey(`/posts/${id}/comments?${toQuery(params)}${optionalFilter(target)}`),
          resource: 'item',
        }
      }
      case 'sites': {
        // /sites 是 Stack Exchange 唯一匿名的端点，不带 key 以节省额度
        const params: [string, string][] = [
          ['pagesize', queryValue(target, 'pagesize') ?? '100'],
          ['page', queryValue(target, 'page') ?? '0'],
        ]
        return { url: `${API}/sites?${toQuery(params)}`, resource: 'search' }
      }
      default:
        throw fail(ErrorCode.NotFound, `unknown stackexchange op: ${target.op}`, 404)
    }
  },
}

function optionalFilter(target: Target): string {
  const filter = queryValue(target, 'filter')
  return filter !== undefined && filter.length > 0 ? `&filter=${encodeURIComponent(filter)}` : ''
}

function normalizeSite(site: string | undefined): string {
  const value = (site ?? 'stackoverflow').toLowerCase()
  if (!SITE_PATTERN.test(value)) {
    throw fail(ErrorCode.InvalidParameter, `invalid site: ${value}`, 400, { site: value })
  }
  return value
}

function requireId(id: string, field: string): string {
  if (!ID_PATTERN.test(id)) {
    throw fail(ErrorCode.InvalidParameter, `invalid ${field}: ${id}`, 400, { field, value: id })
  }
  return id
}

function toQuery(pairs: [string, string][]): string {
  return pairs
    .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
    .join('&')
}
