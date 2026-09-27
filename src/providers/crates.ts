import { ErrorCode, fail } from '../core/errors'
import { queryValue } from '../core/target'
import type { ParamDef, ProviderDef } from '../core/registry'
import type { TransformResult, UpstreamPlan, ProviderRuntime } from './runtime'

/**
 * crates.io 官方 API，零 key。
 * <https://crates.io/data-access>
 *
 * 和 PyPI 一个坑：`GET /api/v1/crates/{name}` 的 441KB 里 **99.1% 是 `versions`**
 * （serde 有 316 个版本，每个还带 features/links/audit_actions/trustpub_data 等
 * 大字段），撞上本项目 512KB 上限只是迟早。所以项目档做 transform：
 * `crate` 对象整体保留（只有 ~4KB），`versions` 折叠成 {num, yanked, created_at,
 * downloads, license} 的精简数组。
 * 另有 2 个天然小体积的端点直接透传：单版本 1.7KB、搜索 2.1KB。
 */
const API = 'https://crates.io/api/v1'
/** crate 名：必须字母开头，可含数字 `-` `_` */
const NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/
/** 版本号：semver 及其预发布/构建号形态；`..` 显式拒掉 */
const VERSION_PATTERN = /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}$/
/** 检索词：字母数字开头，空格与常见技术符号，不含控制字符 */
const TEXT_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N} ._+#:,'"/!?()\[\]{}-]{0,99}$/u
const SEARCH_SORTS = ['relevance', 'downloads', 'recent-downloads', 'new', 'alpha', 'stars', 'recent-updates'] as const

export const params: Record<string, ParamDef[]> = {
  crate: [
    { name: 'name', in: 'path', type: 'string', required: true, description: 'crate 名，如 serde / tokio', maxLength: 64 },
  ],
  version: [
    { name: 'name', in: 'path', type: 'string', required: true, description: 'crate 名', maxLength: 64 },
    { name: 'version', in: 'path', type: 'string', required: true, description: '版本号，如 1.0.229', maxLength: 64 },
  ],
  search: [
    { name: 'q', in: 'query', type: 'string', required: true, description: 'crate 名/关键词/描述检索词', maxLength: 100 },
    { name: 'limit', in: 'query', type: 'integer', required: false, description: '每页条数，1-100', default: '10', minimum: 1, maximum: 100 },
    { name: 'sort', in: 'query', type: 'string', required: false, description: 'relevance/downloads/recent-downloads/new/alpha/stars/recent-updates', default: 'relevance' },
  ],
}

export const def: ProviderDef = {
  name: 'crates',
  displayName: 'crates.io',
  tier: 'A-',
  hosts: ['crates.io'],
  minIntervalMs: 1000,
  uaNote: '官方 API，零 key；上游要求带可识别的 User-Agent（本项目发 uapis/1.0 (+SITE_URL)）',
  parseCostMs: 1,
  attribution: 'crate 元数据与代码版权归各发布者，crates.io 只做索引与托管',
  tos: 'https://crates.io/policies',
  limits: '官方未公布硬性限流但要求合理使用；本项目 1000ms 最小间隔自我约束',
  endpoints: [
    {
      op: 'crate',
      resource: 'item',
      method: 'GET',
      path: '/api/v1/crates/crate/{name}',
      summary: 'crate 元数据（versions 折叠成精简数组，不含每版本 features/links 大字段）',
      params: params.crate ?? [],
      // transform 丢掉 versions 里的重型字段：上游这个端点 441KB，接近 512KB 上限
      passthrough: false,
      inline: true,
      costMs: 1,
    },
    {
      op: 'version',
      resource: 'item',
      method: 'GET',
      path: '/api/v1/crates/crate/{name}/{version}',
      summary: '单个版本的元数据与产物（1-2KB）',
      params: params.version ?? [],
      passthrough: true,
      inline: true,
      costMs: 0,
    },
    {
      op: 'search',
      resource: 'search',
      method: 'GET',
      path: '/api/v1/crates/search',
      summary: 'crate 搜索（只放行必要参数）',
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
      case 'crate': {
        return { url: `${API}/crates/${requireName(target.id)}`, resource: 'item' }
      }
      case 'version': {
        const [name = '', ...rest] = target.id.split('/')
        if (rest.length !== 1) {
          throw fail(ErrorCode.InvalidParameter, `invalid target: ${target.id}`, 400, {
            field: 'name/version',
            value: target.id,
          })
        }
        const version = rest[0] ?? ''
        requireName(name)
        if (!VERSION_PATTERN.test(version) || version.includes('..')) {
          throw fail(ErrorCode.InvalidParameter, `invalid version: ${version}`, 400, { version })
        }
        return { url: `${API}/crates/${name}/${version}`, resource: 'item' }
      }
      case 'search': {
        const q = queryValue(target, 'q') ?? ''
        if (q.length === 0 || !TEXT_PATTERN.test(q)) {
          throw fail(ErrorCode.InvalidParameter, `invalid q: ${q}`, 400, { parameter: 'q', value: q })
        }
        const query: [string, string][] = [
          ['q', q],
          ['per_page', queryValue(target, 'limit') ?? '10'],
          ['sort', requireEnum(queryValue(target, 'sort') ?? 'relevance', SEARCH_SORTS, 'sort')],
        ]
        return { url: `${API}/crates?${toQuery(query)}`, resource: 'search' }
      }
      default:
        throw fail(ErrorCode.NotFound, `unknown crates op: ${target.op}`, 404)
    }
  },

  transform(raw): TransformResult {
    return { text: JSON.stringify(slimCrate(raw)), contentType: 'application/json; charset=utf-8' }
  },
}

interface SlimVersion {
  num: string
  yanked?: boolean
  created_at?: string
  downloads?: number
  license?: string
  rust_version?: string
  checksum?: string
  crate_size?: number
}

interface SlimCrate {
  provider: 'crates'
  name: string
  versions: SlimVersion[]
  [key: string]: unknown
}

/** 只认 `/api/v1/crates/{name}` 的固定结构；上游改结构时才需要改这里 */
function slimCrate(raw: string): SlimCrate {
  let doc: Record<string, unknown>
  try {
    doc = JSON.parse(raw) as Record<string, unknown>
  } catch {
    throw fail(ErrorCode.UpstreamError, 'crates.io returned non-JSON', 502)
  }
  const meta = (doc.crate ?? {}) as Record<string, unknown>
  const out: Record<string, unknown> = { provider: 'crates' }
  for (const [key, value] of Object.entries(meta)) {
    if (value !== undefined) out[key] = value
  }
  if (typeof meta.name === 'string') out.name = meta.name
  const versions = Array.isArray(doc.versions) ? (doc.versions as Record<string, unknown>[]) : []
  out.versions = versions.map((entry): SlimVersion => {
    const slim: SlimVersion = { num: String(entry.num ?? '') }
    for (const key of ['yanked', 'created_at', 'downloads', 'license', 'rust_version', 'checksum', 'crate_size'] as const) {
      const value = entry[key]
      if (value !== undefined) (slim as unknown as Record<string, unknown>)[key] = value
    }
    return slim
  })
  if (Array.isArray(doc.keywords)) out.keywords = doc.keywords
  return out as SlimCrate
}

function requireName(value: string): string {
  if (!NAME_PATTERN.test(value)) {
    throw fail(ErrorCode.InvalidParameter, `invalid crate name: ${value}`, 400, {
      field: 'name',
      value,
      hint: 'crate 名：字母开头，只允许字母数字与 - _',
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
