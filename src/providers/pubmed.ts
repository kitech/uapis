import { ErrorCode, fail } from '../core/errors'
import { getSetting } from '../core/settings'
import { queryValue } from '../core/target'
import type { ParamDef, ProviderDef } from '../core/registry'
import type { UpstreamPlan, ProviderRuntime } from './runtime'

/**
 * PubMed E-utilities（NCBI），零 key 可用：
 * <https://www.ncbi.nlm.nih.gov/books/NBK25501/>
 *
 * 不用 efetch：那只能返回 XML/MEDLINE 文本，要引正则解析器；
 * esearch（查 PMID）+ esummary（取题录）都支持 retmode=json，够用且是纯 JSON。
 *
 * 两个上游坑，都必须在 runtime 挡掉，否则会把 200 + 错误体缓存下来：
 * 1. term 为空时 esearch 返回 **200** + "Empty term and query_key - nothing todo"
 * 2. id 非法时 esummary 返回 **200** + `{"error":"Invalid uid notanumber at position= 0"}`
 */
const EUTILS = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils'
/** PMID 是纯数字，最多 8 位 */
const PMID_PATTERN = /^[0-9]{1,8}$/
const ID_LIST_PATTERN = /^[0-9]{1,8}(,[0-9]{1,8}){0,19}$/
const TERM_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N} "'()[\]+\-/*.:^$|~]{0,300}$/u
const SORTS = ['relevance', 'pub_date', 'Author', 'JournalName'] as const
const API_KEY_PATTERN = /^[A-Za-z0-9_-]{8,64}$/
/** esummary 一次最多给多少个 id（题录体积线性增长，20 个约 30KB） */
const MAX_IDS = 20

export const params: Record<string, ParamDef[]> = {
  search: [
    { name: 'term', in: 'query', type: 'string', required: true, description: '检索式，如 cloudflare AND (waf OR ddos)', maxLength: 300 },
    { name: 'retmax', in: 'query', type: 'integer', required: false, description: '返回条数，1-100（默认 20；最大 10000 但本项目只给 100）', default: '20', minimum: 1, maximum: 100 },
    { name: 'retstart', in: 'query', type: 'integer', required: false, description: '偏移量，0 起', default: '0', minimum: 0, maximum: 9900 },
    { name: 'sort', in: 'query', type: 'string', required: false, description: 'relevance/pub_date/Author/JournalName', default: 'relevance' },
  ],
  summary: [
    { name: 'id', in: 'query', type: 'string', required: true, description: `PMID，逗号分隔，最多 ${MAX_IDS} 个`, maxLength: 180 },
  ],
}

export const def: ProviderDef = {
  name: 'pubmed',
  displayName: 'PubMed',
  tier: 'A-',
  auth: {
    settingKey: 'ncbi.api_key',
    label: 'NCBI API key（可选，3 → 10 次/秒）',
    signupUrl: 'https://www.ncbi.nlm.nih.gov/account/settings/',
  },
  hosts: ['eutils.ncbi.nlm.nih.gov'],
  // NCBI 硬要求：3 次/秒（无 key）/ 10 次/秒（有 key）。400ms ≈ 2.5 次/秒，
  // 无 key 也在官方额度内；配了 key 想更快可以调低 gate.min_ms。
  minIntervalMs: 400,
  uaNote: 'E-utilities 零 key 可用；配 ncbi.api_key 后走官方更高的速率档',
  parseCostMs: 0,
  attribution: '题录（标题/作者/期刊）版权归作者与出版商，PubMed 只做索引',
  tos: 'https://www.ncbi.nlm.nih.gov/home/about/policies/',
  limits: '3 次/秒（无 key）、10 次/秒（有 key）；本项目闸门 400ms',
  endpoints: [
    {
      op: 'search',
      resource: 'search',
      method: 'GET',
      path: '/api/v1/pubmed/search',
      summary: '检索 PMID 列表（esearch）',
      params: params.search ?? [],
      passthrough: true,
      inline: true,
      costMs: 0,
      auth: 'optional',
    },
    {
      op: 'summary',
      resource: 'item',
      method: 'GET',
      path: '/api/v1/pubmed/summary',
      summary: '按 PMID 取题录（esummary，逗号分隔多个）',
      params: params.summary ?? [],
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
    switch (target.op) {
      case 'search': {
        const term = queryValue(target, 'term') ?? ''
        // 上游空 term 是 200 + "nothing todo"，必须自己拒掉，否则缓存下来就是脏数据
        if (term.length === 0) {
          throw fail(ErrorCode.InvalidParameter, 'missing required parameter: term', 400, {
            parameter: 'term',
            hint: 'NCBI 对空检索式返回 200 + "nothing todo"，因此本项目直接 400',
          })
        }
        if (!TERM_PATTERN.test(term)) {
          throw fail(ErrorCode.InvalidParameter, `invalid term: ${term}`, 400, { parameter: 'term' })
        }
        const query: [string, string][] = [
          ['db', 'pubmed'],
          ['term', term],
          ['retmode', 'json'],
          ['retmax', queryValue(target, 'retmax') ?? '20'],
          ['retstart', queryValue(target, 'retstart') ?? '0'],
          ['sort', requireEnum(queryValue(target, 'sort') ?? 'relevance', SORTS, 'sort')],
        ]
        const key = await apiKey(env)
        if (key !== undefined) query.push(['api_key', key])
        return { url: `${EUTILS}/esearch.fcgi?${toQuery(query)}`, resource: 'search' }
      }
      case 'summary': {
        const id = queryValue(target, 'id') ?? ''
        if (!ID_LIST_PATTERN.test(id)) {
          throw fail(ErrorCode.InvalidParameter, `invalid id: ${id}`, 400, {
            parameter: 'id',
            value: id,
            hint: `PMID 是数字，最多 ${MAX_IDS} 个（上游非法 id 是 200 + error 字段）`,
          })
        }
        const query: [string, string][] = [
          ['db', 'pubmed'],
          ['id', id],
          ['retmode', 'json'],
          // 2.0 的题录结构更干净（没有 1.x 的 uid/EthernetScience 首字母缩写）
          ['version', '2.0'],
        ]
        const key = await apiKey(env)
        if (key !== undefined) query.push(['api_key', key])
        return { url: `${EUTILS}/esummary.fcgi?${toQuery(query)}`, resource: 'item' }
      }
      default:
        throw fail(ErrorCode.NotFound, `unknown pubmed op: ${target.op}`, 404)
    }
  },
}

/**
 * NCBI 只认 query 里的 api_key，没法走头。配了才带；配得不像 key 就当没配。
 * 它只发往 eutils.ncbi.nlm.nih.gov（白名单内的唯一出口），且不进本项目的缓存键。
 */
async function apiKey(env: Env): Promise<string | undefined> {
  const raw = (await getSetting(env, 'ncbi.api_key')).trim()
  return API_KEY_PATTERN.test(raw) ? raw : undefined
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
