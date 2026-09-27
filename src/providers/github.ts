import { ErrorCode, fail } from '../core/errors'
import { getSetting } from '../core/settings'
import { queryValue } from '../core/target'
import type { ParamDef, ProviderDef } from '../core/registry'
import type { UpstreamPlan, ProviderRuntime } from './runtime'

const API = 'https://api.github.com'
const LOGIN_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/
const REPO_PATTERN = /^[A-Za-z0-9._-]{1,100}$/
const API_VERSION = '2022-11-28'

export const params: Record<string, ParamDef[]> = {
  repo: [
    { name: 'owner', in: 'path', type: 'string', required: true, description: '仓库所有者' },
    { name: 'repo', in: 'path', type: 'string', required: true, description: '仓库名' },
  ],
  search: [
    { name: 'q', in: 'query', type: 'string', required: true, description: '搜索表达式', maxLength: 120 },
    { name: 'sort', in: 'query', type: 'string', required: false, description: 'stars/forks/updated' },
    { name: 'order', in: 'query', type: 'string', required: false, description: 'asc/desc', default: 'desc' },
    { name: 'per_page', in: 'query', type: 'integer', required: false, description: '每页条数，1-100', default: '30', minimum: 1, maximum: 100 },
    { name: 'page', in: 'query', type: 'integer', required: false, description: '页码，1 起（GitHub 搜索从 1 开始）', default: '1', minimum: 1, maximum: 10 },
  ],
  user: [
    { name: 'login', in: 'path', type: 'string', required: true, description: 'GitHub 用户名' },
  ],
}

export const def: ProviderDef = {
  name: 'github',
  displayName: 'GitHub',
  tier: 'A-',
  auth: {
    settingKey: 'gh.token',
    label: 'GitHub fine-grained PAT（可选）',
    signupUrl: 'https://github.com/settings/personal-access-tokens',
  },
  hosts: ['api.github.com'],
  // GitHub 搜索端点是 10 次/分钟，core 是 60 次/小时，取最严的那个当闸门
  minIntervalMs: 6000,
  uaNote: '匿名 60 次/小时（core）、10 次/分钟（search）；配 gh.token 后 5000 次/小时',
  parseCostMs: 0,
  attribution: '仓库与用户元数据版权归 GitHub 及各自作者',
  tos: 'https://docs.github.com/site-policy/github-terms/github-terms-of-service',
  limits: '匿名 core 60 次/小时、search 10 次/分钟；token 认证 5000 次/小时',
  endpoints: [
    {
      op: 'repo',
      resource: 'item',
      method: 'GET',
      path: '/api/v1/github/repo/{owner}/{repo}',
      summary: '仓库元数据（README 全文请自行取 raw）',
      params: params.repo ?? [],
      passthrough: true,
      inline: true,
      costMs: 0,
      auth: 'optional',
    },
    {
      op: 'search',
      resource: 'search',
      method: 'GET',
      path: '/api/v1/github/search/repositories',
      summary: '仓库搜索（白名单参数）',
      params: params.search ?? [],
      passthrough: true,
      inline: true,
      costMs: 0,
      auth: 'optional',
    },
    {
      op: 'user',
      resource: 'profile',
      method: 'GET',
      path: '/api/v1/github/user/{login}',
      summary: '用户资料',
      params: params.user ?? [],
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
    const token = await getSetting(env, 'gh.token')
    const headers: Record<string, string> = { 'X-GitHub-Api-Version': API_VERSION }
    // token 走 Authorization 头，不进 query：避免被日志和缓存键记录
    if (token.length > 0) headers.Authorization = `Bearer ${token}`

    switch (target.op) {
      case 'repo': {
        const [owner = '', repo = ''] = target.id.split('/')
        if (!LOGIN_PATTERN.test(owner) || !REPO_PATTERN.test(repo)) {
          throw fail(ErrorCode.InvalidParameter, `invalid repo: ${target.id}`, 400, {
            field: 'owner/repo',
            value: target.id,
          })
        }
        return { url: `${API}/repos/${owner}/${repo}`, headers, resource: 'item' }
      }
      case 'search': {
        const q = queryValue(target, 'q') ?? ''
        if (q.length === 0) {
          throw fail(ErrorCode.InvalidParameter, 'missing required parameter: q', 400, { parameter: 'q' })
        }
        const query: [string, string][] = [
          ['q', q],
          ['per_page', queryValue(target, 'per_page') ?? '30'],
          ['page', queryValue(target, 'page') ?? '1'],
        ]
        const sort = queryValue(target, 'sort')
        if (sort !== undefined && sort.length > 0) {
          if (!['stars', 'forks', 'updated'].includes(sort)) {
            throw fail(ErrorCode.InvalidParameter, `invalid sort: ${sort}`, 400, {
              allowed: ['stars', 'forks', 'updated'],
            })
          }
          query.push(['sort', sort])
        }
        const order = queryValue(target, 'order') ?? 'desc'
        if (order !== 'asc' && order !== 'desc') {
          throw fail(ErrorCode.InvalidParameter, `invalid order: ${order}`, 400, {
            allowed: ['asc', 'desc'],
          })
        }
        query.push(['order', order])
        return { url: `${API}/search/repositories?${toQuery(query)}`, headers, resource: 'search' }
      }
      case 'user': {
        const login = target.id
        if (!LOGIN_PATTERN.test(login)) {
          throw fail(ErrorCode.InvalidParameter, `invalid login: ${login}`, 400, {
            field: 'login',
            value: login,
          })
        }
        return { url: `${API}/users/${login}`, headers, resource: 'profile' }
      }
      default:
        throw fail(ErrorCode.NotFound, `unknown github op: ${target.op}`, 404)
    }
  },
}

function toQuery(pairs: [string, string][]): string {
  return pairs.map(([key, value]) => `${key}=${encodeURIComponent(value)}`).join('&')
}
