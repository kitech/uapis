import { ErrorCode, fail } from '../core/errors'
import { FORMAT_PARAM } from '../core/uapis'
import { queryValue } from '../core/target'
import type { ParamDef, ProviderDef } from '../core/registry'
import type { UpstreamPlan, ProviderRuntime } from './runtime'

/**
 * GitLab 公开项目 API v4，零 key（只读公开数据，不需要 token）。
 * <https://docs.gitlab.com/ee/api/>
 *
 * 匿名配额实测是 `ratelimit-limit: 500`（每分钟每 IP），比多数零 key 源宽松，
 * 但共享出口 IP 会被一起算，所以最小间隔只放到 200ms。
 * 全部用 `simple=true` 精简列表字段：2 个项目 2.8KB、20 个约 28KB。
 */
const API = 'https://gitlab.com/api/v4'
/** `namespace/project`（子组可多层），或纯数字项目 id */
const PATH_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}(?:\/[A-Za-z0-9][A-Za-z0-9._-]{0,63}){0,19}$/
const NUMERIC_ID_PATTERN = /^[0-9]{1,12}$/
/** 分支/标签/sha：GitLab 允许斜杠（feature/x），但不许 `..` */
const REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/
/** 检索词：字母数字、空格与常见技术符号，不含控制字符 */
const TEXT_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N} ._+#:,'"/!?()\[\]{}-]{0,99}$/u
const ORDER_FIELDS = ['last_activity_at', 'created_at', 'name', 'path', 'id'] as const
const SORTS = ['asc', 'desc'] as const

export const params: Record<string, ParamDef[]> = {
  search: [
    { name: 'q', in: 'query', type: 'string', required: true, description: '项目名/路径/描述检索词', maxLength: 100 },
    { name: 'limit', in: 'query', type: 'integer', required: false, description: '每页条数，1-100', default: '20', minimum: 1, maximum: 100 },
    { name: 'order_by', in: 'query', type: 'string', required: false, description: 'last_activity_at/created_at/name/path/id', default: 'last_activity_at' },
    { name: 'sort', in: 'query', type: 'string', required: false, description: 'asc/desc', default: 'desc' },
  ],
  project: [
    { name: 'id', in: 'path', type: 'string', required: true, description: '`namespace/project`（子组可多层）或数字项目 id', maxLength: 400, multiSegment: true },
  ],
  commits: [
    { name: 'project', in: 'query', type: 'string', required: true, description: '`namespace/project` 或数字项目 id', maxLength: 400 },
    { name: 'ref', in: 'query', type: 'string', required: false, description: '分支/标签/sha，默认项目默认分支', maxLength: 128 },
    { name: 'limit', in: 'query', type: 'integer', required: false, description: '条数，1-100', default: '20', minimum: 1, maximum: 100 },
    FORMAT_PARAM,
  ],
}

export const def: ProviderDef = {
  name: 'gitlab',
  displayName: 'GitLab',
  tier: 'A-',
  hosts: ['gitlab.com'],
  minIntervalMs: 200,
  uaNote: '官方公开 API v4，只读公开项目，零 key；私有项目一律不碰',
  parseCostMs: 0,
  attribution: '项目元数据与代码版权归各项目作者/组织，GitLab 只做托管与索引',
  tos: 'https://about.gitlab.com/terms/',
  limits: '匿名 500 次/分钟/IP（实测 ratelimit-limit 头）；本项目 200ms 最小间隔',
  endpoints: [
    {
      op: 'search',
      resource: 'search',
      method: 'GET',
      path: '/api/v1/gitlab/projects',
      summary: '公开项目搜索（simple 精简字段，20 个约 28KB）',
      params: params.search ?? [],
      passthrough: true,
      inline: true,
      costMs: 0,
    },
    {
      op: 'project',
      resource: 'profile',
      method: 'GET',
      path: '/api/v1/gitlab/project/{id}',
      summary: '单个公开项目详情（namespace/project，支持多层子组）',
      params: params.project ?? [],
      passthrough: true,
      inline: true,
      costMs: 0,
    },
    {
      op: 'commits',
      resource: 'feed',
      method: 'GET',
      path: '/api/v1/gitlab/commits',
      summary: '项目最近提交（项目走 query 参数，避免和路径参数抢多段路由）',
      params: params.commits ?? [],
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
      case 'search': {
        const q = queryValue(target, 'q') ?? ''
        if (q.length === 0 || !TEXT_PATTERN.test(q)) {
          throw fail(ErrorCode.InvalidParameter, `invalid q: ${q}`, 400, { parameter: 'q', value: q })
        }
        const query: [string, string][] = [
          ['search', q],
          ['per_page', queryValue(target, 'limit') ?? '20'],
          ['simple', 'true'],
          ['order_by', requireEnum(queryValue(target, 'order_by') ?? 'last_activity_at', ORDER_FIELDS, 'order_by')],
          ['sort', requireEnum(queryValue(target, 'sort') ?? 'desc', SORTS, 'sort')],
        ]
        return { url: `${API}/projects?${toQuery(query)}`, resource: 'search' }
      }
      case 'project': {
        // 路由把多段 id 拼成 `group/sub/project`，上游要的是单段 URL 编码形式
        return { url: `${API}/projects/${encodeProject(target.id)}`, resource: 'profile' }
      }
      case 'commits': {
        const project = encodeProject(queryValue(target, 'project') ?? '')
        const query: [string, string][] = [
          ['per_page', queryValue(target, 'limit') ?? '20'],
        ]
        const ref = queryValue(target, 'ref')
        if (ref !== undefined && ref.length > 0) {
          if (!REF_PATTERN.test(ref) || ref.includes('..')) {
            throw fail(ErrorCode.InvalidParameter, `invalid ref: ${ref}`, 400, { parameter: 'ref', value: ref })
          }
          query.push(['ref_name', ref])
        }
        return { url: `${API}/projects/${project}/repository/commits?${toQuery(query)}`, resource: 'feed' }
      }
      default:
        throw fail(ErrorCode.NotFound, `unknown gitlab op: ${target.op}`, 404)
    }
  },
}

/** `group/sub/project` → `group%2Fsub%2Fproject`；数字项目 id 原样透传 */
function encodeProject(value: string): string {
  if (NUMERIC_ID_PATTERN.test(value)) return value
  if (!PATH_PATTERN.test(value)) {
    throw fail(ErrorCode.InvalidParameter, `invalid project: ${value}`, 400, {
      field: 'project',
      value,
      hint: '项目路径形如 group/project（子组可多层），或数字项目 id',
    })
  }
  return encodeURIComponent(value)
}

function requireEnum<T extends readonly string[]>(value: string, allowed: T, field: string): string {
  if (!(allowed as readonly string[]).includes(value)) {
    throw fail(ErrorCode.InvalidParameter, `invalid ${field}: ${value}`, 400, {
      parameter: field,
      allowed: [...allowed],
    })
  }
  return value
}

function toQuery(pairs: [string, string][]): string {
  return pairs.map(([key, value]) => `${key}=${encodeURIComponent(value)}`).join('&')
}
