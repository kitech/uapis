import { ErrorCode, fail } from '../core/errors'
import { FORMAT_PARAM } from '../core/uapis'
import { queryValue } from '../core/target'
import type { Target } from '../core/target'
import type { ProviderDef } from '../core/registry'
import type { UpstreamPlan, ProviderRuntime } from './runtime'

const API = 'https://hn.algolia.com/api/v1'
const ID_PATTERN = /^[0-9]{1,12}$/
const USER_PATTERN = /^[A-Za-z0-9_-]{1,40}$/

export const def: ProviderDef = {
  name: 'hackernews',
  displayName: 'Hacker News (Algolia)',
  tier: 'A',
  hosts: ['hn.algolia.com'],
  minIntervalMs: 300,
  parseCostMs: 0,
  attribution: '内容版权归原作者，数据源 HN Algolia API',
  tos: 'https://hn.algolia.com/api',
  limits: '官方未公布硬性限流，本项目按 300ms 最小间隔自我约束',
  endpoints: [
    {
      op: 'search',
      resource: 'search',
      method: 'GET',
      path: '/api/v1/hackernews/search',
      summary: '搜索 HN 条目',
      params: [
        { name: 'q', in: 'query', type: 'string', required: false, description: '关键词', maxLength: 120 },
        { name: 'tags', in: 'query', type: 'string', required: false, description: 'Algolia tags，如 story,comment' },
        { name: 'hitsPerPage', in: 'query', type: 'integer', required: false, description: '每页条数，1-100', default: '20', minimum: 1, maximum: 100 },
        { name: 'page', in: 'query', type: 'integer', required: false, description: '页码，0 起', default: '0', minimum: 0, maximum: 10 },
      ],
      passthrough: true,
      inline: true,
      costMs: 0,
    },
    {
      op: 'item',
      resource: 'item',
      method: 'GET',
      path: '/api/v1/hackernews/item/{id}',
      summary: '按 ID 获取条目及其子评论',
      params: [{ name: 'id', in: 'path', type: 'string', required: true, description: 'HN 条目 ID' }],
      passthrough: true,
      inline: true,
      costMs: 0,
    },
    {
      op: 'user',
      resource: 'profile',
      method: 'GET',
      path: '/api/v1/hackernews/user/{id}',
      summary: '获取用户信息',
      params: [{ name: 'id', in: 'path', type: 'string', required: true, description: 'HN 用户 ID' }],
      passthrough: true,
      inline: true,
      costMs: 0,
    },
    {
      op: 'front',
      resource: 'feed',
      method: 'GET',
      path: '/api/v1/hackernews/front',
      summary: '首页热门条目（feed，2min 新鲜期）',
      params: [
        { name: 'hitsPerPage', in: 'query', type: 'integer', required: false, description: '每页条数，1-100', default: '20', minimum: 1, maximum: 100 },
        { name: 'page', in: 'query', type: 'integer', required: false, description: '页码，0 起', default: '0', minimum: 0, maximum: 10 },
        FORMAT_PARAM,
      ],
      passthrough: true,
      inline: true,
      costMs: 0,
    },
    {
      op: 'latest',
      resource: 'feed',
      method: 'GET',
      path: '/api/v1/hackernews/latest',
      summary: '最新 story（按时间倒序）',
      params: [
        { name: 'tags', in: 'query', type: 'string', required: false, description: 'Algolia tags，默认 story' },
        { name: 'hitsPerPage', in: 'query', type: 'integer', required: false, description: '每页条数，1-100', default: '20', minimum: 1, maximum: 100 },
        { name: 'page', in: 'query', type: 'integer', required: false, description: '页码，0 起', default: '0', minimum: 0, maximum: 10 },
        FORMAT_PARAM,
      ],
      passthrough: true,
      inline: true,
      costMs: 0,
    },
    {
      op: 'userPosts',
      resource: 'feed',
      method: 'GET',
      path: '/api/v1/hackernews/user/{id}/posts',
      summary: '指定用户的最新条目（分页）',
      params: [
        { name: 'id', in: 'path', type: 'string', required: true, description: 'HN 用户 ID' },
        { name: 'query', in: 'query', type: 'string', required: false, description: '在该用户的条目里再做关键词过滤' },
        { name: 'hitsPerPage', in: 'query', type: 'integer', required: false, description: '每页条数，1-100', default: '20', minimum: 1, maximum: 100 },
        { name: 'page', in: 'query', type: 'integer', required: false, description: '页码，0 起', default: '0', minimum: 0, maximum: 10 },
        FORMAT_PARAM,
      ],
      passthrough: true,
      inline: true,
      costMs: 0,
    },
  ],
}

export const runtime: ProviderRuntime = {
  name: def.name,
  async buildPlan(_env, target): Promise<UpstreamPlan> {
    switch (target.op) {
      case 'search': {
        const query: [string, string][] = []
        const q = queryValue(target, 'q')
        if (q !== undefined && q.length > 0) query.push(['query', q])
        const tags = queryValue(target, 'tags')
        if (tags !== undefined && tags.length > 0) query.push(['tags', tags])
        query.push(['hitsPerPage', queryValue(target, 'hitsPerPage') ?? '20'])
        query.push(['page', queryValue(target, 'page') ?? '0'])
        return { url: `${API}/search?${toQuery(query)}`, resource: 'search' }
      }
      case 'item': {
        const id = requirePattern(target.id, ID_PATTERN, 'id')
        return { url: `${API}/items/${id}`, resource: 'item' }
      }
      case 'user': {
        const id = requirePattern(target.id, USER_PATTERN, 'id')
        return { url: `${API}/users/${id}`, resource: 'profile' }
      }
      case 'front': {
        const query: [string, string][] = [
          ['tags', 'front_page'],
          ['hitsPerPage', queryValue(target, 'hitsPerPage') ?? '20'],
          ['page', queryValue(target, 'page') ?? '0'],
        ]
        return { url: `${API}/search?${toQuery(query)}`, resource: 'feed' }
      }
      case 'latest': {
        const query: [string, string][] = [
          ['tags', queryValue(target, 'tags') ?? 'story'],
          ['hitsPerPage', queryValue(target, 'hitsPerPage') ?? '20'],
          ['page', queryValue(target, 'page') ?? '0'],
        ]
        return { url: `${API}/search_by_date?${toQuery(query)}`, resource: 'feed' }
      }
      case 'userPosts': {
        const id = requirePattern(target.id, USER_PATTERN, 'id')
        // Algolia 里“某人的全部条目”是 author_<id> 标签；story_<id> 是“第 1263 号帖子”这种主键标签，
        // 用它当作者过滤会永远返回 0 条（已实测）
        const query: [string, string][] = [
          ['tags', `author_${id}`],
          ['hitsPerPage', queryValue(target, 'hitsPerPage') ?? '20'],
          ['page', queryValue(target, 'page') ?? '0'],
        ]
        const text = queryValue(target, 'query')
        if (text !== undefined && text.length > 0) query.push(['query', text])
        return { url: `${API}/search_by_date?${toQuery(query)}`, resource: 'feed' }
      }
      default:
        throw fail(ErrorCode.NotFound, `unknown hackernews op: ${target.op}`, 404)
    }
  },
}

function requirePattern(value: string, pattern: RegExp, field: string): string {
  if (!pattern.test(value)) {
    throw fail(ErrorCode.InvalidParameter, `invalid ${field}: ${value}`, 400, { field, value })
  }
  return value
}

function toQuery(pairs: [string, string][]): string {
  return pairs
    .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
    .join('&')
}
