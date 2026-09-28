import { ErrorCode, fail } from '../core/errors'
import { getSetting } from '../core/settings'
import { queryValue } from '../core/target'
import type { ParamDef, ProviderDef } from '../core/registry'
import type { UpstreamPlan, ProviderRuntime, TransformResult } from './runtime'

const API = 'https://api.github.com'
const LOGIN_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/
const REPO_PATTERN = /^[A-Za-z0-9._-]{1,100}$/
const SINCE_PATTERN = /^\d{4}-\d{2}-\d{2}$/
const API_VERSION = '2022-11-28'

/** `search/repositories` 官方 `sort` 枚举四项，与 cli/cli 的 StringEnumFlag 一致 */
const SEARCH_SORTS = ['stars', 'forks', 'help-wanted-issues', 'updated'] as const

export const params: Record<string, ParamDef[]> = {
  repo: [
    { name: 'owner', in: 'path', type: 'string', required: true, description: '仓库所有者' },
    { name: 'repo', in: 'path', type: 'string', required: true, description: '仓库名' },
  ],
  search: [
    { name: 'q', in: 'query', type: 'string', required: true, description: '搜索表达式', maxLength: 120 },
    {
      name: 'sort',
      in: 'query',
      type: 'string',
      required: false,
      description: 'stars/forks/help-wanted-issues/updated',
    },
    { name: 'order', in: 'query', type: 'string', required: false, description: 'asc/desc', default: 'desc' },
    // 封 30 是因为体积：实测 per_page=100 返回 557,300B，超过 fetcher.ts 的
    // MAX_UPSTREAM_BYTES（512KB）会被直接判超限，不是超时问题
    {
      name: 'per_page',
      in: 'query',
      type: 'integer',
      required: false,
      description: '每页条数，1-30（100 条会超 512KB 上限）',
      default: '30',
      minimum: 1,
      maximum: 30,
    },
    { name: 'page', in: 'query', type: 'integer', required: false, description: '页码，1 起（GitHub 搜索从 1 开始）', default: '1', minimum: 1, maximum: 10 },
  ],
  rising: [
    {
      name: 'since',
      in: 'query',
      type: 'string',
      required: true,
      description: '时间窗起点 YYYY-MM-DD，只收录该日之后新建的仓库',
      maxLength: 10,
    },
    {
      name: 'per_page',
      in: 'query',
      type: 'integer',
      required: false,
      description: '每页条数，1-30（100 条会超 512KB 上限）',
      default: '20',
      minimum: 1,
      maximum: 30,
    },
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
      op: 'androidRising',
      resource: 'search',
      method: 'GET',
      path: '/api/v1/github/android/rising',
      summary: 'Android 新星榜（时间窗内新建、star 最高的仓库）',
      params: params.rising ?? [],
      // 上游 30 项 164,439B、每项 82 字段，transform 后只剩 15,246B
      passthrough: false,
      inline: true,
      costMs: 2,
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
          if (!SEARCH_SORTS.includes(sort as (typeof SEARCH_SORTS)[number])) {
            throw fail(ErrorCode.InvalidParameter, `invalid sort: ${sort}`, 400, {
              allowed: [...SEARCH_SORTS],
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
        // 上游 30 条实测 1.9~4.7s（偶发 9s），而 fetcher.ts 的默认超时是 3s
        return {
          url: `${API}/search/repositories?${toQuery(query)}`,
          headers,
          resource: 'search',
          timeoutMs: 12_000,
          retries: 0,
        }
      }
      case 'androidRising': {
        const since = queryValue(target, 'since') ?? ''
        if (!isRealDate(since)) {
          throw fail(ErrorCode.InvalidParameter, `invalid since: ${since}`, 400, {
            field: 'since',
            value: since,
            expected: 'YYYY-MM-DD',
          })
        }
        // topic 与 sort/order 都写死：topic 放开就退化成通用搜索器，
        // sort 放开这个端点就不再是"热榜"而是任意排序
        const query: [string, string][] = [
          ['q', `topic:android created:>${since}`],
          ['sort', 'stars'],
          ['order', 'desc'],
          ['per_page', queryValue(target, 'per_page') ?? '20'],
          ['page', queryValue(target, 'page') ?? '1'],
        ]
        return {
          url: `${API}/search/repositories?${toQuery(query)}`,
          headers,
          resource: 'search',
          timeoutMs: 12_000,
          retries: 0,
        }
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

  transform(raw): TransformResult {
    return { text: JSON.stringify(slimSearch(raw)), contentType: 'application/json; charset=utf-8' }
  },
}

/**
 * 形状过了不等于日期存在：`2026-13-45` / `2026-08-32` 都会被 SINCE_PATTERN 放过，
 * 但上游一律回 422 Validation Failed（实测三种非法形态都是 422）。
 * 本地挡掉能让错误体带上 field/expected，而不是白回源一次再转成 502。
 */
function isRealDate(value: string): boolean {
  if (!SINCE_PATTERN.test(value)) return false
  const [y, m, d] = value.split('-').map(Number) as [number, number, number]
  const dt = new Date(Date.UTC(y, m - 1, d))
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d
}

/**
 * 留 8 个字段的依据：热榜只需要"谁、什么语言、多少星、什么时候建的"，
 * 上游每项 82 个字段里剩下的是 license 树、owner 详情、security_and_analysis 等重型字段。
 * 30 项 164,439B → 15,246B（省 92%），和 pypi / crates 丢掉 releases 与 README 全文同理。
 */
const KEEP = [
  'full_name',
  'html_url',
  'description',
  'stargazers_count',
  'language',
  'created_at',
  'updated_at',
  'topics',
] as const

interface RisingList {
  provider: 'github'
  total_count: number
  incomplete_results: boolean
  items: Record<string, unknown>[]
}

function slimSearch(raw: string): RisingList {
  let doc: Record<string, unknown>
  try {
    doc = JSON.parse(raw) as Record<string, unknown>
  } catch {
    throw fail(ErrorCode.UpstreamError, 'github returned non-JSON', 502)
  }
  const source = Array.isArray(doc.items) ? (doc.items as Record<string, unknown>[]) : []
  return {
    provider: 'github',
    total_count: typeof doc.total_count === 'number' ? doc.total_count : source.length,
    // 上游查询超时会把已找到的部分连同 incomplete_results=true 一起返回，这是正常业务态，
    // 不当错误处理，也不隐藏这个标记
    incomplete_results: doc.incomplete_results === true,
    items: source.map((item) => {
      const out: Record<string, unknown> = {}
      for (const key of KEEP) {
        if (item[key] !== undefined) out[key] = item[key]
      }
      return out
    }),
  }
}

function toQuery(pairs: [string, string][]): string {
  return pairs.map(([key, value]) => `${key}=${encodeURIComponent(value)}`).join('&')
}
