import { ErrorCode, fail } from '../core/errors'
import { queryValue } from '../core/target'
import type { ParamDef, ProviderDef } from '../core/registry'
import type { Resource } from '../core/ttl'
import type { UpstreamPlan, ProviderRuntime } from './runtime'

/**
 * MusicBrainz 官方 web service，零 key。
 * <https://musicbrainz.org/doc/MusicBrainzAPI>
 *
 * 三个实测出来的约束直接决定了这里的参数上界：
 *
 * 1. **限流是写在响应头里的**：`search` 类端点 `X-RateLimit-Limit: 400`（每分钟），
 *    按 MBID 查实体是 `1900`。1 req/s 的平均速率是官方口头约定，
 *    1000ms 闸门对两种端点都在额度内。
 * 2. **搜索体积随查询宽度爆炸**：`query=radiohead&limit=25` 只有 15KB，
 *    但 `query=a&limit=10` 就是 **146KB**、limit=100 是 296KB 且**要 22.8s**
 *    （上游还会间歇性回 503 "The MusicBrainz web server is currently busy"）。
 *    所以 `limit` 硬卡 25，超时 6s 且关掉重试——宽查询宁可 502 也不要拖垮内联请求。
 * 3. **必须固定 `fmt=json`**：漏掉 `fmt` 上游回 **200 + XML**（`<metadata xmlns=...>`）。
 *    和 PubMed 的 `retmode=json` 同一个坑，只是这里回的是 XML 不是 JSON。
 *
 * `inc` 只放行**单值**：实测 `inc=genres,tags`（无论逗号是否 URL 编码）上游都回 400，
 * 所以不做逗号组合，直接按枚举校验。
 */
const WS = 'https://musicbrainz.org/ws/2'
/**
 * MBID 是标准 UUID，官方规范形式是**小写**，这里也只收小写。
 *
 * 故意不做"大写也接受、然后归一化"：缓存键是由**原始路径 id** 算出来的
 * （`Target.id` 明确保留大小写，且在 buildPlan 之前就已定型），
 * 所以 `.../A74B1B7F-...` 和 `.../a74b1b7f-...` 会是两条不同的缓存条目、
 * 两次一模一样的上游请求。缓存键之前没有 provider 级归一化钩子，
 * 为一个机器生成的 UUID 加框架改动不划算——直接只收规范形式，
 * 大写输入回 400 并在提示里说清怎么改（和 npm 拒大写包名同一思路）。
 */
const MBID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
/**
 * 检索词直接透传给上游的 **Lucene** 语法（官方文档明确支持 `AND`/`OR`/`NOT`/字段前缀），
 * 所以这里只挡控制字符和超长值，不替用户改写查询语义。
 * `\p{P}\p{S}` 覆盖除字母数字空格外的所有可打印字符（含非 ASCII 检索词）。
 */
const TEXT_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N} \p{P}\p{S}]{0,199}$/u
const SEARCH_TYPES = ['artist', 'release-group', 'release'] as const
const ARTIST_INCS = ['url-rels', 'aliases', 'genres', 'tags'] as const
const RELEASE_GROUP_INCS = ['releases', 'artist-credits', 'url-rels'] as const
const RELEASE_INCS = ['recordings', 'artist-credits', 'labels', 'media'] as const

export const params: Record<string, ParamDef[]> = {
  search: [
    { name: 'q', in: 'query', type: 'string', required: true, description: '检索词（透传上游 Lucene 语法）', maxLength: 200 },
    { name: 'type', in: 'query', type: 'string', required: false, description: 'artist/release-group/release', default: 'artist' },
    { name: 'limit', in: 'query', type: 'integer', required: false, description: '条数，1-25', default: '10', minimum: 1, maximum: 25 },
  ],
  artist: [
    { name: 'mbid', in: 'path', type: 'string', required: true, description: '艺人 MBID（UUID）', maxLength: 36 },
    { name: 'inc', in: 'query', type: 'string', required: false, description: 'url-rels/aliases/genres/tags（单值）' },
  ],
  'release-group': [
    { name: 'mbid', in: 'path', type: 'string', required: true, description: '发行组 MBID（UUID）', maxLength: 36 },
    { name: 'inc', in: 'query', type: 'string', required: false, description: 'releases/artist-credits/url-rels（单值）' },
  ],
  release: [
    { name: 'mbid', in: 'path', type: 'string', required: true, description: '发行 MBID（UUID）', maxLength: 36 },
    { name: 'inc', in: 'query', type: 'string', required: false, description: 'recordings/artist-credits/labels/media（单值）' },
  ],
}

export const def: ProviderDef = {
  name: 'musicbrainz',
  displayName: 'MusicBrainz',
  tier: 'A-',
  hosts: ['musicbrainz.org'],
  minIntervalMs: 1000,
  uaNote: '官方 web service，零 key；上游要求带可识别的 User-Agent（本项目发 uapis/1.0 (+SITE_URL)）',
  parseCostMs: 0,
  attribution: '音乐元数据（艺人名、发行信息、封面）版权归各权利人，MusicBrainz 只做开放元数据索引',
  tos: 'https://musicbrainz.org/doc/MusicBrainzAPI/About/Terms%20of%20Use',
  limits: 'search 端点实测 X-RateLimit-Limit 400/分钟，实体查询 1900/分钟；本项目 1000ms 最小间隔',
  endpoints: [
    {
      op: 'search',
      resource: 'search',
      method: 'GET',
      path: '/api/v1/musicbrainz/search',
      summary: '艺人/发行组/发行搜索（limit≤25；宽查询可能 502，宽窄差别可达 10 倍体积）',
      params: params.search ?? [],
      passthrough: true,
      inline: true,
      costMs: 0,
    },
    {
      op: 'artist',
      resource: 'profile',
      method: 'GET',
      path: '/api/v1/musicbrainz/artist/{mbid}',
      summary: '艺人条目（673B；inc=url-rels 约 21KB）',
      params: params.artist ?? [],
      passthrough: true,
      inline: true,
      costMs: 0,
    },
    {
      op: 'release-group',
      resource: 'item',
      method: 'GET',
      path: '/api/v1/musicbrainz/release-group/{mbid}',
      summary: '发行组条目（299B；inc=releases 约 0.9KB）',
      params: params['release-group'] ?? [],
      passthrough: true,
      inline: true,
      costMs: 0,
    },
    {
      op: 'release',
      resource: 'item',
      method: 'GET',
      path: '/api/v1/musicbrainz/release/{mbid}',
      summary: '发行条目（667B；inc=recordings 约 1.7KB）',
      params: params.release ?? [],
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
        const type = requireEnum(queryValue(target, 'type') ?? 'artist', SEARCH_TYPES, 'type')
        return {
          url: `${WS}/${type}?query=${encodeURIComponent(q)}&fmt=json&limit=${queryValue(target, 'limit') ?? '10'}`,
          resource: 'search',
          // 宽查询实测能到 16s，上游还会间歇 503；宁可 502 也不 2× 超时拖垮内联请求
          timeoutMs: 6000,
          retries: 0,
        }
      }
      case 'artist':
      case 'release-group':
      case 'release': {
        const mbid = requireMbid(target.id)
        const allowed = target.op === 'artist' ? ARTIST_INCS : target.op === 'release-group' ? RELEASE_GROUP_INCS : RELEASE_INCS
        const inc = queryValue(target, 'inc')
        const query = inc === undefined || inc.length === 0 ? '' : `&inc=${requireEnum(inc, allowed, 'inc')}`
        // artist 是"人/乐队"的稳定档案（profile 档 300s），release-group 与 release 是条目（item 档 600s）
        const resource: Resource = target.op === 'artist' ? 'profile' : 'item'
        return { url: `${WS}/${target.op}/${mbid}?fmt=json${query}`, resource, timeoutMs: 6000, retries: 0 }
      }
      default:
        throw fail(ErrorCode.NotFound, `unknown musicbrainz op: ${target.op}`, 404)
    }
  },
}

function requireMbid(value: string): string {
  if (!MBID_PATTERN.test(value)) {
    throw fail(ErrorCode.InvalidParameter, `invalid mbid: ${value}`, 400, {
      field: 'mbid',
      value,
      hint: 'MBID 是 36 位小写 UUID，如 a74b1b7f-71a5-4011-9441-d0b5e4122711（大写会被拒，避免同一实体占两条缓存）',
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
