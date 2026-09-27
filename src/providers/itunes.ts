import { ErrorCode, fail } from '../core/errors'
import { queryValue } from '../core/target'
import type { ParamDef, ProviderDef } from '../core/registry'
import type { UpstreamPlan, ProviderRuntime } from './runtime'

/**
 * Apple iTunes Search API：查 App Store / Podcasts / Music / 影视等，
 * 零 key、公开、纯 JSON。官方没有文档站，行为以参数表为准：
 * https://performance-partners.apple.com/search-api
 */
const API = 'https://itunes.apple.com'
const MEDIA = [
  'podcast',
  'podcastEpisode',
  'music',
  'musicVideo',
  'song',
  'audiobook',
  'ebook',
  'movie',
  'tvShow',
  'shortFilm',
  'software',
  'macSoftware',
] as const
/** entity 允许子集之外的取值（collection、artist…）；只做长度与字符约束 */
const ID_PATTERN = /^[0-9]{1,15}$/
const COUNTRY_PATTERN = /^[A-Za-z]{2}$/
const TERM_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N} &'"+,.\-!?:]{0,119}$/u

export const params: Record<string, ParamDef[]> = {
  search: [
    { name: 'term', in: 'query', type: 'string', required: true, description: '搜索词，如 cloudflare / 播客名', maxLength: 120 },
    { name: 'media', in: 'query', type: 'string', required: false, description: `内容类型，${MEDIA.join('/')}`, default: 'podcast' },
    { name: 'entity', in: 'query', type: 'string', required: false, description: '细分实体，如 podcastEpisode、songArtist', maxLength: 40 },
    { name: 'country', in: 'query', type: 'string', required: false, description: '两位国家码，如 US / JP', default: 'US' },
    { name: 'limit', in: 'query', type: 'integer', required: false, description: '每次条数，1-200（上游上限）', default: '20', minimum: 1, maximum: 200 },
    { name: 'offset', in: 'query', type: 'integer', required: false, description: '偏移量，0 起（与 page 约定不同：上游用 offset）', default: '0', minimum: 0, maximum: 500 },
  ],
  lookup: [
    { name: 'id', in: 'query', type: 'string', required: true, description: 'collectionId / trackId 等数字 ID' },
    { name: 'entity', in: 'query', type: 'string', required: false, description: '要连带返回的实体', maxLength: 40 },
    { name: 'country', in: 'query', type: 'string', required: false, description: '两位国家码', default: 'US' },
    { name: 'limit', in: 'query', type: 'integer', required: false, description: '每次条数，1-200', default: '20', minimum: 1, maximum: 200 },
  ],
}

export const def: ProviderDef = {
  name: 'itunes',
  displayName: 'iTunes Search',
  tier: 'A-',
  hosts: ['itunes.apple.com'],
  minIntervalMs: 500,
  uaNote: '公开 Search API，零 key',
  parseCostMs: 0,
  attribution: '封面与简介版权归 Apple 及各自权利人；本项目只做元数据转发',
  tos: 'https://performance-partners.apple.com/terms',
  limits: '官方未公布硬性限流；本项目 500ms 最小间隔自我约束',
  endpoints: [
    {
      op: 'search',
      resource: 'search',
      method: 'GET',
      path: '/api/v1/itunes/search',
      summary: '按关键词搜索（播客/音乐/影视/App…）',
      params: params.search ?? [],
      passthrough: true,
      inline: true,
      costMs: 0,
    },
    {
      op: 'lookup',
      resource: 'item',
      method: 'GET',
      path: '/api/v1/itunes/lookup',
      summary: '按 ID 查详情（collectionId / trackId）',
      params: params.lookup ?? [],
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
        const term = queryValue(target, 'term') ?? ''
        if (term.length === 0 || !TERM_PATTERN.test(term)) {
          throw fail(ErrorCode.InvalidParameter, `invalid term: ${term}`, 400, {
            parameter: 'term',
            value: term,
            allowed_chars: '字母、数字、空格与常见标点',
          })
        }
        const query: [string, string][] = [
          ['term', term],
          ['media', requireEnum(queryValue(target, 'media') ?? 'podcast', MEDIA, 'media')],
          ['country', requirePattern(queryValue(target, 'country') ?? 'US', COUNTRY_PATTERN, 'country')],
          ['limit', queryValue(target, 'limit') ?? '20'],
          ['offset', queryValue(target, 'offset') ?? '0'],
        ]
        const entity = queryValue(target, 'entity')
        if (entity !== undefined && entity.length > 0) {
          if (!/^[A-Za-z][A-Za-z]{0,39}$/.test(entity)) {
            throw fail(ErrorCode.InvalidParameter, `invalid entity: ${entity}`, 400, { entity })
          }
          query.push(['entity', entity])
        }
        return { url: `${API}/search?${toQuery(query)}`, resource: 'search' }
      }
      case 'lookup': {
        const id = requirePattern(queryValue(target, 'id') ?? '', ID_PATTERN, 'id')
        const query: [string, string][] = [
          ['id', id],
          ['country', requirePattern(queryValue(target, 'country') ?? 'US', COUNTRY_PATTERN, 'country')],
          ['limit', queryValue(target, 'limit') ?? '20'],
        ]
        const entity = queryValue(target, 'entity')
        if (entity !== undefined && entity.length > 0) {
          if (!/^[A-Za-z][A-Za-z]{0,39}$/.test(entity)) {
            throw fail(ErrorCode.InvalidParameter, `invalid entity: ${entity}`, 400, { entity })
          }
          query.push(['entity', entity])
        }
        return { url: `${API}/lookup?${toQuery(query)}`, resource: 'item' }
      }
      default:
        throw fail(ErrorCode.NotFound, `unknown itunes op: ${target.op}`, 404)
    }
  },
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

function requirePattern(value: string, pattern: RegExp, field: string): string {
  if (!pattern.test(value)) {
    throw fail(ErrorCode.InvalidParameter, `invalid ${field}: ${value}`, 400, {
      parameter: field,
      value,
    })
  }
  return value
}

function toQuery(pairs: [string, string][]): string {
  return pairs.map(([key, value]) => `${key}=${encodeURIComponent(value)}`).join('&')
}
