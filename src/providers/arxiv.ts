import { ErrorCode, fail } from '../core/errors'
import { queryValue } from '../core/target'
import type { ParamDef, ProviderDef } from '../core/registry'
import type { TransformResult, UpstreamPlan, ProviderRuntime } from './runtime'

const API = 'https://export.arxiv.org/api'
/** arXiv 查询语法只用到这些字符；`&` `%` 之类一律拒掉，避免拼出意外的 URL */
const QUERY_PATTERN = /^[A-Za-z0-9_:+\-()"*.,\/\s]{1,200}$/
const PAPER_PATTERN = /^\d{4}\.\d{4,5}(v\d{1,2})?$/
const SORT_BY = ['relevance', 'lastUpdatedDate', 'submittedDate']
const SORT_ORDER = ['ascending', 'descending']
/** 上游不听话时的硬上限：参数已经限到 30，这里再兜一层 */
const HARD_ENTRY_CAP = 50

export const params: Record<string, ParamDef[]> = {
  search: [
    {
      name: 'search_query',
      in: 'query',
      type: 'string',
      required: true,
      description: 'arXiv 查询式，如 `cat:cs.LG AND all:cloudflare`',
      maxLength: 200,
    },
    { name: 'start', in: 'query', type: 'integer', required: false, description: '起始偏移，0 起', default: '0', minimum: 0, maximum: 10_000 },
    { name: 'max_results', in: 'query', type: 'integer', required: false, description: '返回条数，1-30', default: '10', minimum: 1, maximum: 30 },
    { name: 'sortBy', in: 'query', type: 'string', required: false, description: 'relevance/lastUpdatedDate/submittedDate', default: 'relevance' },
    { name: 'sortOrder', in: 'query', type: 'string', required: false, description: 'ascending/descending', default: 'descending' },
  ],
  paper: [
    { name: 'id', in: 'path', type: 'string', required: true, description: 'arXiv ID，如 2609.30258' },
  ],
}

export const def: ProviderDef = {
  name: 'arxiv',
  displayName: 'arXiv',
  tier: 'A-',
  hosts: ['export.arxiv.org'],
  // arXiv 官方明确要求：最多 1 次/3 秒
  minIntervalMs: 3000,
  uaNote: 'arXiv 要求提供可识别的 User-Agent；本项目强制注入带站点 URL 的 UA',
  parseCostMs: 2,
  attribution: '论文版权归作者，arXiv 采用永久非独占许可',
  tos: 'https://info.arxiv.org/help/api/tou.html',
  limits: '官方要求 ≤1 次/3 秒；本端点新鲜期取 15 分钟以符合其缓存要求',
  endpoints: [
    {
      op: 'search',
      resource: 'archive',
      method: 'GET',
      path: '/api/v1/arxiv/search',
      summary: '论文检索（Atom XML 转 JSON）',
      params: params.search ?? [],
      passthrough: false,
      inline: true,
      costMs: 2,
    },
    {
      op: 'paper',
      resource: 'archive',
      method: 'GET',
      path: '/api/v1/arxiv/paper/{id}',
      summary: '按 arXiv ID 取单篇论文元数据',
      params: params.paper ?? [],
      passthrough: false,
      inline: true,
      costMs: 1,
    },
  ],
}

export const runtime: ProviderRuntime = {
  name: def.name,
  async buildPlan(env, target): Promise<UpstreamPlan> {
    const query: [string, string][] = []

    switch (target.op) {
      case 'search': {
        const searchQuery = queryValue(target, 'search_query') ?? ''
        if (!QUERY_PATTERN.test(searchQuery)) {
          throw fail(ErrorCode.InvalidParameter, `invalid search_query: ${searchQuery}`, 400, {
            field: 'search_query',
            max_length: 200,
          })
        }
        query.push(['search_query', searchQuery])
        query.push(['start', queryValue(target, 'start') ?? '0'])
        query.push(['max_results', queryValue(target, 'max_results') ?? '10'])
        query.push(['sortBy', requireEnum(queryValue(target, 'sortBy') ?? 'relevance', SORT_BY, 'sortBy')])
        query.push(['sortOrder', requireEnum(queryValue(target, 'sortOrder') ?? 'descending', SORT_ORDER, 'sortOrder')])
        break
      }
      case 'paper': {
        const id = target.id
        if (!PAPER_PATTERN.test(id)) {
          throw fail(ErrorCode.InvalidParameter, `invalid id: ${id}`, 400, {
            field: 'id',
            example: '2609.30258',
          })
        }
        query.push(['id_list', id])
        break
      }
      default:
        throw fail(ErrorCode.NotFound, `unknown arxiv op: ${target.op}`, 404)
    }

    // arXiv 延迟抖动很大（实测 0.5s~7.6s），3s 默认超时不够；15s 是实测上限的两倍余量。
    // 关掉重试：慢上游重试只会把内联请求拖成 2×15s，不如快速失败让客户端自己决定要不要 Prefer: respond-async
    return {
      url: `${API}/query?${toQuery(query)}`,
      resource: 'archive',
      timeoutMs: 15_000,
      retries: 0,
    }
  },

  transform(raw): TransformResult {
    return { text: JSON.stringify(parseAtom(raw)), contentType: 'application/json; charset=utf-8' }
  },
}

interface ArxivEntry {
  id: string
  abs: string
  pdf: string
  title: string
  summary: string
  published: string
  updated: string
  authors: string[]
  primary: string
  categories: string[]
}

interface ArxivFeed {
  provider: 'arxiv'
  updated: string
  total: number
  count: number
  entries: ArxivEntry[]
}

/**
 * 有界的 Atom 提取，不是通用 XML 解析器。
 * 上游结构固定为 arXiv 的 `api/query` 输出，因此按 entry 块正则抽取即可，
 * 换来的是零依赖与 ~2ms 的解析成本。
 */
export function parseAtom(raw: string): ArxivFeed {
  const feedTag = /<feed[^>]*>([\s\S]*?)<\/feed>/.exec(raw)?.[1] ?? raw
  const total = Number.parseInt(/<opensearch:totalResults[^>]*>(\d+)</.exec(feedTag)?.[1] ?? '0', 10)
  const updated = tagText(feedTag, 'updated')

  const blocks = feedTag.match(/<entry>[\s\S]*?<\/entry>/g) ?? []
  const entries: ArxivEntry[] = []
  for (const block of blocks.slice(0, HARD_ENTRY_CAP)) {
    const abs = attrValue(/<link[^>]*rel="alternate"[^>]*>/.exec(block)?.[0], 'href')
    const pdf = attrValue(/<link[^>]*title="pdf"[^>]*>/.exec(block)?.[0], 'href')
    const absUrl = abs ?? tagText(block, 'id')
    const authors = [...block.matchAll(/<author>\s*<name>([\s\S]*?)<\/name>/g)]
      .map((m) => collapse(decode(m[1] ?? '')))
      .filter((name) => name.length > 0)
    const categories = [...block.matchAll(/<category[^>]*term="([^"]+)"/g)].map((m) => m[1] ?? '')
    const primary = attrValue(/<arxiv:primary_category[^>]*\/?>/.exec(block)?.[0], 'term') ?? ''

    entries.push({
      id: (absUrl.match(/\/abs\/(.+)$/)?.[1] ?? '').trim(),
      abs: absUrl,
      pdf: pdf ?? '',
      title: collapse(decode(tagText(block, 'title'))),
      summary: collapse(decode(tagText(block, 'summary'))),
      published: tagText(block, 'published'),
      updated: tagText(block, 'updated'),
      authors,
      primary,
      categories: categories.filter((value) => value.length > 0),
    })
  }

  return {
    provider: 'arxiv',
    updated,
    total: Number.isFinite(total) ? total : 0,
    count: entries.length,
    entries,
  }
}

function tagText(block: string, tag: string): string {
  return new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(block)?.[1] ?? ''
}

function attrValue(tag: string | undefined, name: string): string {
  if (tag === undefined) return ''
  return new RegExp(`${name}="([^"]*)"`).exec(tag)?.[1] ?? ''
}

function collapse(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

const NAMED_ENTITIES: Readonly<Record<string, string>> = Object.freeze({
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
})

function decode(value: string): string {
  return value
    .replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body: string) => {
      if (body.startsWith('#x') || body.startsWith('#X')) {
        const code = Number.parseInt(body.slice(2), 16)
        return Number.isFinite(code) ? String.fromCodePoint(code) : whole
      }
      if (body.startsWith('#')) {
        const code = Number.parseInt(body.slice(1), 10)
        return Number.isFinite(code) ? String.fromCodePoint(code) : whole
      }
      return NAMED_ENTITIES[body] ?? whole
    })
}

function requireEnum(value: string, allowed: string[], field: string): string {
  if (!allowed.includes(value)) {
    throw fail(ErrorCode.InvalidParameter, `invalid ${field}: ${value}`, 400, {
      allowed,
    })
  }
  return value
}

function toQuery(pairs: [string, string][]): string {
  return pairs.map(([key, value]) => `${key}=${encodeURIComponent(value)}`).join('&')
}
