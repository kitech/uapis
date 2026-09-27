import { ErrorCode, fail } from '../core/errors'
import { queryValue } from '../core/target'
import type { ParamDef, ProviderDef } from '../core/registry'
import type { UpstreamPlan, ProviderRuntime } from './runtime'

/**
 * npm 官方 registry，零 key。
 *
 * 故意**不**暴露 packument（`GET /{name}`）：实测体积 react 2.9MB、@types/node 2.3MB、
 * lodash 70KB，同样的包差距三个数量级，本项目 512KB 的上游上限会让最热的包全部 413。
 * 改用 `/{name}/latest`（1.6-3.5KB）与 `/{name}/{version}`（单版本 manifest），
 * 加上 `/-/v1/search`（几 KB），三个都是可控体积。
 */
const REGISTRY = 'https://registry.npmjs.org'
/** 包名：小写、无空格；scoped 走 multiSegment，路由与校验都自己处理 */
const NAME_PATTERN = /^(?:@[a-z0-9][a-z0-9._-]{0,58}\/)?[a-z0-9][a-z0-9._-]{0,98}$/
/** 版本号：semver 及其预发布/构建号形态；`..` 显式拒掉 */
const VERSION_PATTERN = /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}$/
/** 允许首字符是 `@`（`@types/node` 这类 scoped 包是常见检索词），其余仍是白名单字符 */
const TEXT_PATTERN = /^[@\p{L}\p{N}][\p{L}\p{N} @._+#:,'"/!?()\[\]{}-]{0,119}$/u
const SEARCH_SORTS = ['relevance', 'popularity', 'quality', 'maintenance', 'created', 'updated'] as const

export const params: Record<string, ParamDef[]> = {
  latest: [
    {
      name: 'name',
      in: 'path',
      type: 'string',
      required: true,
      description: '包名，可带 scope（`@scope/pkg`）',
      maxLength: 120,
      multiSegment: true,
    },
  ],
  version: [
    { name: 'name', in: 'path', type: 'string', required: true, description: '包名，可带 scope', maxLength: 120, multiSegment: true },
    { name: 'version', in: 'path', type: 'string', required: true, description: '版本号，如 18.3.1', maxLength: 64 },
  ],
  search: [
    { name: 'text', in: 'query', type: 'string', required: true, description: '搜索词（包名/关键词/描述全文匹配）', maxLength: 120 },
    { name: 'size', in: 'query', type: 'integer', required: false, description: '每页条数，1-50', default: '10', minimum: 1, maximum: 50 },
    { name: 'from', in: 'query', type: 'integer', required: false, description: '偏移量，0 起', default: '0', minimum: 0, maximum: 250 },
    { name: 'sort', in: 'query', type: 'string', required: false, description: 'relevance/popularity/quality/maintenance/created/updated', default: 'relevance' },
  ],
}

export const def: ProviderDef = {
  name: 'npm',
  displayName: 'npm registry',
  tier: 'A-',
  hosts: ['registry.npmjs.org'],
  minIntervalMs: 500,
  uaNote: '官方 registry，零 key；只取 manifest 与搜索结果，不代理 tarball',
  parseCostMs: 0,
  attribution: '包元数据版权归各发布者，registry 只做索引',
  tos: 'https://docs.npmjs.com/policies/terms',
  limits: '官方未公布硬性限流；本项目 500ms 最小间隔自我约束',
  endpoints: [
    {
      op: 'latest',
      resource: 'item',
      method: 'GET',
      path: '/api/v1/npm/latest/{name}',
      summary: 'dist-tags.latest 对应版本的 manifest（1-4KB）',
      params: params.latest ?? [],
      passthrough: true,
      inline: true,
      costMs: 0,
    },
    {
      op: 'version',
      resource: 'item',
      method: 'GET',
      path: '/api/v1/npm/version/{name}/{version}',
      summary: '指定版本的 manifest',
      params: params.version ?? [],
      passthrough: true,
      inline: true,
      costMs: 0,
    },
    {
      op: 'search',
      resource: 'search',
      method: 'GET',
      path: '/api/v1/npm/search',
      summary: '包搜索（只放行必要参数）',
      params: params.search ?? [],
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
      case 'latest': {
        // scoped 包的 `@scope/pkg` 会被路由拼进 id（`name` 是多段参数）
        return { url: `${REGISTRY}/${requireName(target.id)}/latest`, resource: 'item' }
      }
      case 'version': {
        const { name, version, ok } = splitNameVersion(target.id)
        if (!ok) {
          throw fail(ErrorCode.InvalidParameter, `invalid target: ${target.id}`, 400, {
            field: 'name/version',
            value: target.id,
          })
        }
        requireName(name)
        if (!VERSION_PATTERN.test(version) || version.includes('..')) {
          throw fail(ErrorCode.InvalidParameter, `invalid version: ${version}`, 400, { version })
        }
        return { url: `${REGISTRY}/${name}/${version}`, resource: 'item' }
      }
      case 'search': {
        const text = queryValue(target, 'text') ?? ''
        if (text.length === 0 || !TEXT_PATTERN.test(text)) {
          throw fail(ErrorCode.InvalidParameter, `invalid text: ${text}`, 400, {
            parameter: 'text',
            value: text,
          })
        }
        const query: [string, string][] = [
          ['text', text],
          ['size', queryValue(target, 'size') ?? '10'],
          ['from', queryValue(target, 'from') ?? '0'],
        ]
        const sort = queryValue(target, 'sort')
        if (sort !== undefined && sort.length > 0 && sort !== 'relevance') {
          query.push(['sort', requireEnum(sort, SEARCH_SORTS, 'sort')])
        }
        return { url: `${REGISTRY}/-/v1/search?${toQuery(query)}`, resource: 'search' }
      }
      default:
        throw fail(ErrorCode.NotFound, `unknown npm op: ${target.op}`, 404)
    }
  },
}

function splitNameVersion(id: string): { name: string; version: string; ok: boolean } {
  const parts = id.split('/')
  // scoped 包本身就是两段（@scope/pkg），再往后一段才是版本
  const cut = parts[0]?.startsWith('@') === true ? 2 : 1
  if (parts.length !== cut + 1) return { name: '', version: '', ok: false }
  return { name: parts.slice(0, cut).join('/'), version: parts[cut] ?? '', ok: true }
}

function requireName(value: string): string {
  if (!NAME_PATTERN.test(value)) {
    throw fail(ErrorCode.InvalidParameter, `invalid package name: ${value}`, 400, {
      field: 'name',
      value,
      hint: 'npm 包名：可带 @scope/ 前缀，只允许小写字母数字与 . _ -',
    })
  }
  return value
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
