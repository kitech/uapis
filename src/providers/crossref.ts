import { ErrorCode, fail } from '../core/errors'
import { getSetting } from '../core/settings'
import { queryValue } from '../core/target'
import type { ParamDef, ProviderDef } from '../core/registry'
import type { UpstreamPlan, ProviderRuntime } from './runtime'

/**
 * Crossref：DOI 官方注册机构的公开检索 API，零 key。
 * 响应是 `{"status":"ok","message":{...}}` 的信封，和 HN/SE 一样原样透传。
 *
 * polite pool：Crossref 建议在 query 里带 `mailto` 以进入更宽松的池子并接受联系。
 * 这是本项目唯一能表达的"礼貌"（UA 固定不可覆盖），因此做成可选设置
 * `crossref.mailto`，不填也能用，只是走 common pool。
 */
const API = 'https://api.crossref.org'
const SORT_FIELDS = [
  'relevance',
  'published',
  'issued',
  'created-date',
  'deposited-date',
  'indexed-date',
  'is-referenced-by-count',
] as const
/** DOI 前缀固定 10.x，斜杠后允许常见字符；`..` 显式拒掉 */
const DOI_PATTERN = /^10\.[0-9]{4,9}\/[A-Za-z0-9._()/:;+-]{1,180}$/
const TRAVERSAL = /(^|\/)\.\.(\/|$)/
const FILTER_PATTERN = /^[A-Za-z0-9,:;.\-]{1,200}$/
const SELECT_PATTERN = /^[A-Za-z0-9,_-]{1,200}$/
const MAILTO_PATTERN = /^[^\s@]+@[^\s@]+\.[A-Za-z]{2,}$/

export const params: Record<string, ParamDef[]> = {
  search: [
    { name: 'query', in: 'query', type: 'string', required: true, description: '检索词，如 cloudflare waf', maxLength: 200 },
    { name: 'rows', in: 'query', type: 'integer', required: false, description: '每页条数，1-30（上游 rows）', default: '10', minimum: 1, maximum: 30 },
    { name: 'offset', in: 'query', type: 'integer', required: false, description: '偏移量，0 起', default: '0', minimum: 0, maximum: 1000 },
    { name: 'sort', in: 'query', type: 'string', required: false, description: `${SORT_FIELDS.join('/')}；不给则按 relevance` },
    { name: 'order', in: 'query', type: 'string', required: false, description: 'asc/desc（仅在给了 sort 时生效）', default: 'desc' },
    { name: 'filter', in: 'query', type: 'string', required: false, description: '如 from-pub-date:2024-01-01,type:journal-article', maxLength: 200 },
    { name: 'select', in: 'query', type: 'string', required: false, description: '只取部分字段（省流量），如 DOI,title,issued', maxLength: 200 },
  ],
  work: [
    {
      name: 'doi',
      in: 'path',
      type: 'string',
      required: true,
      description: 'DOI，含斜杠，如 10.2172/2407272',
      maxLength: 200,
      // DOI 天然多段（10.<registrant>/<suffix>），单段 :doi 匹配不到
      multiSegment: true,
    },
  ],
}

export const def: ProviderDef = {
  name: 'crossref',
  displayName: 'Crossref',
  tier: 'A-',
  hosts: ['api.crossref.org'],
  // polite pool 官方给的是 50 req/s；1 秒一条已远低于它，这是自我约束
  minIntervalMs: 1000,
  uaNote: '公开检索 API，零 key；设置 crossref.mailto 可进 polite pool',
  parseCostMs: 0,
  attribution: '题录（标题/作者/期刊）版权归出版方与 Crossref',
  tos: 'https://www.crossref.org/documentation/retrieve-metadata/rest-api/',
  limits: 'polite pool 约 50 次/秒，common pool 更严；本项目 1 秒最小间隔自我约束',
  endpoints: [
    {
      op: 'search',
      resource: 'search',
      method: 'GET',
      path: '/api/v1/crossref/search',
      summary: '题录检索（按关键词/年份/类型过滤）',
      params: params.search ?? [],
      passthrough: true,
      inline: true,
      costMs: 0,
    },
    {
      op: 'work',
      resource: 'item',
      method: 'GET',
      path: '/api/v1/crossref/work/{doi}',
      summary: '单个 DOI 的题录',
      params: params.work ?? [],
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
        const query = queryValue(target, 'query') ?? ''
        if (query.length === 0) {
          throw fail(ErrorCode.InvalidParameter, 'missing required parameter: query', 400, {
            parameter: 'query',
          })
        }
        const pairs: [string, string][] = [
          ['query', query],
          ['rows', queryValue(target, 'rows') ?? '10'],
          ['offset', queryValue(target, 'offset') ?? '0'],
        ]
        const sort = queryValue(target, 'sort')
        if (sort !== undefined && sort.length > 0) {
          pairs.push(['sort', requireEnum(sort, SORT_FIELDS, 'sort')])
          pairs.push(['order', requireEnum(queryValue(target, 'order') ?? 'desc', ['asc', 'desc'] as const, 'order')])
        }
        const filter = queryValue(target, 'filter')
        if (filter !== undefined && filter.length > 0) {
          if (!FILTER_PATTERN.test(filter)) {
            throw fail(ErrorCode.InvalidParameter, `invalid filter: ${filter}`, 400, { filter })
          }
          pairs.push(['filter', filter])
        }
        const select = queryValue(target, 'select')
        if (select !== undefined && select.length > 0) {
          if (!SELECT_PATTERN.test(select)) {
            throw fail(ErrorCode.InvalidParameter, `invalid select: ${select}`, 400, { select })
          }
          pairs.push(['select', select])
        }
        const mailto = await politeMailto(env)
        if (mailto !== undefined) pairs.push(['mailto', mailto])
        return { url: `${API}/works?${toQuery(pairs)}`, resource: 'search' }
      }
      case 'work': {
        const doi = target.id
        if (!DOI_PATTERN.test(doi) || TRAVERSAL.test(doi)) {
          throw fail(ErrorCode.InvalidParameter, `invalid doi: ${doi}`, 400, {
            field: 'doi',
            value: doi,
            hint: '形如 10.2172/2407272；只允许 10.x 前缀与字母数字及 . _ ( ) / : ; + -',
          })
        }
        const query: [string, string][] = []
        const mailto = await politeMailto(env)
        if (mailto !== undefined) query.push(['mailto', mailto])
        const suffix = query.length === 0 ? '' : `?${toQuery(query)}`
        return { url: `${API}/works/${doi}${suffix}`, resource: 'item' }
      }
      default:
        throw fail(ErrorCode.NotFound, `unknown crossref op: ${target.op}`, 404)
    }
  },
}

/** 配了 `crossref.mailto` 才带 mailto 进 polite pool；配错就当没配，不报错 */
async function politeMailto(env: Env): Promise<string | undefined> {
  const raw = (await getSetting(env, 'crossref.mailto')).trim()
  return MAILTO_PATTERN.test(raw) ? raw : undefined
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
