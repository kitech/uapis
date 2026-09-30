import type { EndpointDef, ParamDef } from './registry'
import type { TransformResult } from '../providers/runtime'
import type { Target } from './target'
import { queryValue } from './target'

/**
 * `?format=` 结构切换：`uapis`（默认）= 兼容 uapis.cn `misc/hotboard` 结构，
 * `original` = 保留 provider 原本结构（透传上游字节 / 各自 transform 信封）。
 *
 * 整形只发生在落库前（refresh.ts），缓存键已含 `format` 参数，两种形态天然分桶；
 * `original` 路径字节零改动。条目一律 lossless：`extra` 保留原条目的完整对象。
 */
export const FORMAT_PARAM: ParamDef = {
  name: 'format',
  in: 'query',
  type: 'string',
  required: false,
  description:
    '响应结构：uapis=兼容 uapis.cn misc/hotboard 结构（默认）；original=保留 provider 原本结构',
  enum: ['original', 'uapis'],
  default: 'uapis',
}

export type OutputFormat = 'original' | 'uapis'

export function resolveFormat(target: Target): OutputFormat {
  return queryValue(target, 'format') === 'original' ? 'original' : 'uapis'
}

interface FeedSlice {
  type: string
  updateTime: string
  /** 原 provider 顶层附加字段（不与 type/update_time/list 冲突） */
  top?: Record<string, unknown>
  items: Array<{
    title: string
    url: string
    hot_value: string
    cover?: string
    extra: unknown
  }>
}

type Extractor = (legacy: unknown, target: Target) => FeedSlice | undefined

function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

/** 毫秒时间戳 → ISO 8601 Z；解析不出来（NaN/0）时用当前时点 */
function isoOf(ms: number): string {
  return Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : new Date().toISOString()
}

/** 字符串日期（RFC-822/ISO 都可能）→ ISO 8601 Z；解析不出来用当前时点 */
function isoOfStr(value: string): string {
  return isoOf(Date.parse(value))
}

/** 去掉一个键拿其余顶层字段（保留原 provider 的附加信息，同时不与 hotboard 保留键冲突） */
function without(source: Record<string, unknown>, key: string): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, value] of Object.entries(source)) {
    if (k === key || k === 'type' || k === 'update_time' || k === 'list') continue
    out[k] = value
  }
  return out
}

function fourchanCatalog(legacy: unknown, target: Target): FeedSlice | undefined {
  const box = legacy as { threads?: Array<Record<string, unknown>> }
  const threads = box.threads
  if (!Array.isArray(threads)) return undefined
  let last = 0
  const items = threads.map((thread) => {
    const no = typeof thread.no === 'number' ? thread.no : 0
    const lm = typeof thread.last_modified === 'number' ? thread.last_modified : 0
    if (lm > last) last = lm
    const sub = str(thread.sub)
    return {
      title: sub.length > 0 ? sub : `Thread #${no}`,
      url: `https://boards.4chan.org/${target.id}/thread/${no}`,
      hot_value: typeof thread.replies === 'number' ? String(thread.replies) : '0',
      extra: { ...thread },
    }
  })
  return {
    type: `fourchan:${target.id}`,
    updateTime: isoOf(last * 1000),
    items,
  }
}

function telegramChannel(legacy: unknown, target: Target): FeedSlice | undefined {
  const box = legacy as { posts?: Array<Record<string, unknown>>; [k: string]: unknown }
  const posts = box.posts
  if (!Array.isArray(posts)) return undefined
  const first = posts[0]
  return {
    type: `telegram:${target.id}`,
    updateTime: isoOfStr(str(first?.date)),
    top: without(box, 'posts'),
    items: posts.map((post) => ({
      title: str(post.text),
      url: str(post.url),
      hot_value: typeof post.views === 'number' ? String(post.views) : '0',
      extra: { ...post },
    })),
  }
}

function mediumSlice(op: string): Extractor {
  return (legacy, target): FeedSlice | undefined => {
    const box = legacy as { posts?: Array<Record<string, unknown>>; [k: string]: unknown }
    const posts = box.posts
    if (!Array.isArray(posts)) return undefined
    return {
      type: `medium:${op}:${target.id}`,
      // Medium 的 lastBuildDate 是 RFC-822，解析不了就用整形时点（不能把 822 塞进
      // uapis.cn 的 update_time——那个字段约定是 ISO 8601）
      updateTime: isoOfStr(str(box.updated)),
      top: without(box, 'posts'),
      items: posts.map((post) => ({
        title: str(post.title),
        url: str(post.url),
        hot_value: '0',
        cover: str(post.image) || undefined,
        extra: { ...post },
      })),
    }
  }
}

function hnSlice(op: string): Extractor {
  return (legacy): FeedSlice | undefined => {
    const box = legacy as { hits?: Array<Record<string, unknown>>; [k: string]: unknown }
    const hits = box.hits
    if (!Array.isArray(hits)) return undefined
    let maxMs = 0
    const items = hits.map((hit) => {
      const raw = hit.created_at_i
      if (typeof raw === 'number' && raw > maxMs) maxMs = raw
      const title = str(hit.title) || str(hit.story_title) || str(hit.comment_text) || ''
      const objectID = str(hit.objectID)
      return {
        title: title || `HN item #${objectID}`,
        url:
          str(hit.url) ||
          (objectID.length > 0 ? `https://news.ycombinator.com/item?id=${objectID}` : ''),
        hot_value: typeof hit.points === 'number' ? String(hit.points) : '0',
        extra: { ...hit },
      }
    })
    return {
      type: `hackernews:${op}`,
      updateTime: isoOf(maxMs * 1000),
      // Algolia 的 nbHits/page/hitsPerPage 等分页元信息一并保留
      top: without(box, 'hits'),
      items,
    }
  }
}

function devtoArticles(legacy: unknown): FeedSlice | undefined {
  if (!Array.isArray(legacy)) return undefined
  let maxMs = 0
  const items = (legacy as Array<Record<string, unknown>>).map((article) => {
    const parsed = Date.parse(str(article.published_at))
    if (Number.isFinite(parsed) && parsed > maxMs) maxMs = parsed
    return {
      title: str(article.title),
      url: str(article.url),
      hot_value:
        typeof article.positive_reactions_count === 'number'
          ? String(article.positive_reactions_count)
          : '0',
      cover: str(article.cover_image) || undefined,
      extra: { ...article },
    }
  })
  return {
    type: 'devto:articles',
    updateTime: isoOf(maxMs),
    items,
  }
}

function gitlabCommits(legacy: unknown, target: Target): FeedSlice | undefined {
  if (!Array.isArray(legacy)) return undefined
  const project = target.query.find(([key]) => key === 'project')?.[1] ?? ''
  let maxMs = 0
  const items = (legacy as Array<Record<string, unknown>>).map((commit) => {
    const parsed = Date.parse(str(commit.committed_date) || str(commit.created_at))
    if (Number.isFinite(parsed) && parsed > maxMs) maxMs = parsed
    const message = str(commit.message)
    const shortId = str(commit.short_id)
    return {
      title: str(commit.title) || message.split('\n')[0] || `commit ${shortId}`,
      url:
        str(commit.web_url) ||
        (shortId.length > 0 && project.length > 0 ? `https://gitlab.com/${project}/-/commit/${shortId}` : ''),
      hot_value: '0',
      extra: { ...commit },
    }
  })
  return {
    type: 'gitlab:commits',
    updateTime: isoOf(maxMs),
    items,
  }
}

function lobstersSlice(op: string): Extractor {
  return (legacy): FeedSlice | undefined => {
    if (!Array.isArray(legacy)) return undefined
    let maxMs = 0
    const items = (legacy as Array<Record<string, unknown>>).map((story) => {
      const parsed = Date.parse(str(story.created_at))
      if (Number.isFinite(parsed) && parsed > maxMs) maxMs = parsed
      const shortId = str(story.short_id)
      return {
        title: str(story.title),
        url: str(story.url) || (shortId.length > 0 ? `https://lobste.rs/s/${shortId}` : ''),
        hot_value: typeof story.score === 'number' ? String(story.score) : '0',
        extra: { ...story },
      }
    })
    return {
      type: `lobsters:${op}`,
      updateTime: isoOf(maxMs),
      items,
    }
  }
}

function openmeteoHourly(legacy: unknown): FeedSlice | undefined {
  const box = legacy as { hourly?: Record<string, unknown>; [k: string]: unknown }
  const hourly = box.hourly
  if (hourly === undefined || hourly === null || typeof hourly !== 'object') return undefined
  const time = hourly.time
  if (!Array.isArray(time)) return undefined
  // 上游时间串是本地时区（timezone=auto 下无偏移），无法可靠转成 UTC，
  // update_time 用整形时点，各行的原始 time 保留在 extra。
  const items: FeedSlice['items'] = []
  // 一个时刻一条，变量收进 extra.values。逐（时刻 × 变量）展开会把 16 天 8 变量
  // 的 20KB 上游撑成 3000+ 条、几百 KB——而上游本来就是列存结构，按时刻成条
  // 才是它的自然切法，且一条不丢。
  const variables: string[] = []
  for (const [key, value] of Object.entries(hourly)) {
    if (key === 'time') continue
    if (Array.isArray(value)) variables.push(key)
  }
  for (let i = 0; i < time.length; i++) {
    const at = String(time[i])
    const values: Record<string, unknown> = {}
    for (const variable of variables) {
      const column = hourly[variable]
      if (Array.isArray(column)) values[variable] = column[i]
    }
    items.push({
      title: at,
      url: '',
      hot_value: '0',
      extra: { time: at, values },
    })
  }
  return {
    type: 'openmeteo:hourly',
    updateTime: new Date().toISOString(),
    top: without(box, 'hourly'),
    items,
  }
}

function usgsSearch(legacy: unknown): FeedSlice | undefined {
  const box = legacy as { features?: Array<Record<string, unknown>>; [k: string]: unknown }
  const features = box.features
  if (!Array.isArray(features)) return undefined
  let maxMs = 0
  const items = features.map((feature) => {
    const props = (feature.properties ?? {}) as Record<string, unknown>
    const raw = props.time
    if (typeof raw === 'number' && raw > maxMs) maxMs = raw
    return {
      title: str(props.title) || str(props.place) || '',
      url: str(props.url),
      hot_value: typeof props.mag === 'number' ? String(props.mag) : '0',
      extra: { ...feature },
    }
  })
  return {
    type: 'usgs:search',
    updateTime: isoOf(maxMs),
    top: without(box, 'features'),
    items,
  }
}

const EXTRACTORS: Record<string, Extractor> = {
  'fourchan:catalog': fourchanCatalog,
  'telegram:channel': telegramChannel,
  'hackernews:front': hnSlice('front'),
  'hackernews:latest': hnSlice('latest'),
  'hackernews:userPosts': hnSlice('userPosts'),
  'devto:articles': devtoArticles,
  'gitlab:commits': gitlabCommits,
  'lobsters:hot': lobstersSlice('hot'),
  'lobsters:newest': lobstersSlice('newest'),
  'lobsters:tag': lobstersSlice('tag'),
  'openmeteo:hourly': openmeteoHourly,
  'usgs:search': usgsSearch,
  'medium:tag': mediumSlice('tag'),
  'medium:publication': mediumSlice('publication'),
  'medium:user': mediumSlice('user'),
  'medium:tagged': mediumSlice('tagged'),
}

/**
 * 把 feed 端点的 legacy 输出（透传上游 JSON 或 transform 信封）整形为
 * uapis.cn `misc/hotboard` 兼容结构：
 * `{ type, update_time, list: [{ index, title, url, hot_value, cover?, extra }], ...originTop }`。
 * 非 feed 端点或解析失败返回 undefined（原样保留）。
 */
export function reshapeToHotboard(
  providerName: string,
  endpoint: EndpointDef,
  target: Target,
  legacyText: string,
): TransformResult | undefined {
  if (endpoint.resource !== 'feed') return undefined
  const extract = EXTRACTORS[`${providerName}:${endpoint.op}`]
  if (extract === undefined) return undefined

  let legacy: unknown
  try {
    legacy = JSON.parse(legacyText)
  } catch {
    return undefined
  }
  const slice = extract(legacy, target)
  if (slice === undefined) return undefined

  const list: Array<Record<string, unknown>> = slice.items.map((item, i) => ({
    index: i + 1,
    title: item.title,
    url: item.url,
    hot_value: item.hot_value,
    ...(item.cover === undefined ? {} : { cover: item.cover }),
    extra: item.extra,
  }))

  return {
    text: JSON.stringify({
      type: slice.type,
      update_time: slice.updateTime,
      list,
      ...(slice.top ?? {}),
    }),
    contentType: 'application/json; charset=utf-8',
  }
}