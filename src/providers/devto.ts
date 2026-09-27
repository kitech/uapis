import { ErrorCode, fail } from '../core/errors'
import { queryValue } from '../core/target'
import type { Target } from '../core/target'
import type { ParamDef, ProviderDef } from '../core/registry'
import type { UpstreamPlan, ProviderRuntime } from './runtime'

const API = 'https://dev.to/api'
const SLUG_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/
const USERNAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/

export const params: Record<string, ParamDef[]> = {
  articles: [
    { name: 'tag', in: 'query', type: 'string', required: false, description: '按标签过滤', maxLength: 30 },
    { name: 'username', in: 'query', type: 'string', required: false, description: '按作者过滤', maxLength: 40 },
    { name: 'state', in: 'query', type: 'string', required: false, description: 'fresh/rising/all', default: 'fresh' },
    { name: 'top', in: 'query', type: 'integer', required: false, description: 'state=top 时的天数窗口，1-999', minimum: 1, maximum: 999 },
    { name: 'page', in: 'query', type: 'integer', required: false, description: '页码，1 起（DEV.to 从 1 开始）', default: '1', minimum: 1, maximum: 30 },
    { name: 'per_page', in: 'query', type: 'integer', required: false, description: '每页条数，1-100', default: '30', minimum: 1, maximum: 100 },
  ],
  article: [
    { name: 'id', in: 'path', type: 'string', required: true, description: '文章 ID 或 slug' },
  ],
  user: [
    { name: 'username', in: 'path', type: 'string', required: true, description: 'DEV.to 用户名' },
  ],
}

export const def: ProviderDef = {
  name: 'devto',
  displayName: 'DEV Community',
  tier: 'A-',
  hosts: ['dev.to'],
  minIntervalMs: 500,
  uaNote: '匿名可用，DEV.to 公开 API 不需要 key',
  parseCostMs: 0,
  attribution: '文章版权归作者，遵循 CC BY-NC-SA 4.0',
  tos: 'https://dev.to/terms',
  limits: '公开 API 约 1000 次/5 分钟（按 IP 计）',
  endpoints: [
    {
      op: 'articles',
      resource: 'feed',
      method: 'GET',
      path: '/api/v1/devto/articles',
      summary: '文章列表：按标签/作者过滤，分页',
      params: params.articles ?? [],
      passthrough: true,
      inline: true,
      costMs: 0,
    },
    {
      op: 'article',
      resource: 'item',
      method: 'GET',
      path: '/api/v1/devto/article/{id}',
      summary: '单篇文章（ID 或 slug）',
      params: params.article ?? [],
      passthrough: true,
      inline: true,
      costMs: 0,
    },
    {
      op: 'user',
      resource: 'profile',
      method: 'GET',
      path: '/api/v1/devto/user/{username}',
      summary: '作者资料',
      params: params.user ?? [],
      passthrough: true,
      inline: true,
      costMs: 0,
    },
  ],
}

export const runtime: ProviderRuntime = {
  name: def.name,
  async buildPlan(env, target): Promise<UpstreamPlan> {
    switch (target.op) {
      case 'articles': {
        const query: [string, string][] = [['page', queryValue(target, 'page') ?? '1']]
        const tag = queryValue(target, 'tag')
        if (tag !== undefined && tag.length > 0) {
          if (!SLUG_PATTERN.test(tag)) {
            throw fail(ErrorCode.InvalidParameter, `invalid tag: ${tag}`, 400, { tag })
          }
          query.push(['tag', tag])
        }
        const username = queryValue(target, 'username')
        if (username !== undefined && username.length > 0) {
          if (!USERNAME_PATTERN.test(username)) {
            throw fail(ErrorCode.InvalidParameter, `invalid username: ${username}`, 400, { username })
          }
          query.push(['username', username])
        }
        const state = requireState(target)
        query.push(['state', state])
        if (state === 'top') query.push(['top', queryValue(target, 'top') ?? '7'])
        query.push(['per_page', queryValue(target, 'per_page') ?? '30'])
        return { url: `${API}/articles?${toQuery(query)}`, resource: 'feed' }
      }
      case 'article': {
        const id = requirePattern(target.id, SLUG_PATTERN, 'id')
        return { url: `${API}/articles/${id}`, resource: 'item' }
      }
      case 'user': {
        const username = requirePattern(target.id, USERNAME_PATTERN, 'username')
        return { url: `${API}/users/by_username?url=${encodeURIComponent(username)}`, resource: 'profile' }
      }
      default:
        throw fail(ErrorCode.NotFound, `unknown devto op: ${target.op}`, 404)
    }
  },
}

/** DEV.to 只认 fresh/rising/all/top，别的值上游会 400，这里先给出更清楚的错误 */
function requireState(target: Target): string {
  const state = queryValue(target, 'state') ?? 'fresh'
  if (!['fresh', 'rising', 'all', 'top'].includes(state)) {
    throw fail(ErrorCode.InvalidParameter, `invalid state: ${state}`, 400, {
      allowed: ['fresh', 'rising', 'all', 'top'],
    })
  }
  return state
}

function requirePattern(value: string, pattern: RegExp, field: string): string {
  if (!pattern.test(value)) {
    throw fail(ErrorCode.InvalidParameter, `invalid ${field}: ${value}`, 400, { field, value })
  }
  return value
}

function toQuery(pairs: [string, string][]): string {
  return pairs.map(([key, value]) => `${key}=${encodeURIComponent(value)}`).join('&')
}
