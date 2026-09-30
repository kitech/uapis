import { ErrorCode, fail } from '../core/errors'
import { queryValue } from '../core/target'
import type { ParamDef, ProviderDef } from '../core/registry'
import type { TransformResult, UpstreamPlan, ProviderRuntime } from './runtime'

/**
 * Medium 官方公开 RSS 接口，零凭据。URL scheme 由 Medium 官方 Help Center
 * 文档化（`help.medium.com/hc/en-us/articles/214874118`），不是逆向出来的：
 * 官方明确列出 profile / publication / publication+tag / topic 四种 feed。
 *
 * 1. **为什么 RSS 而不是 JSON**：Medium 2019 年废弃了 `api.medium.com`（且它从来
 *    只能写不能读），社区至今唯一稳定的机器可读面就是 feed。
 *    `medium.com/@x/latest?format=json` 这种"看起来像 JSON API"的路径**不能用**——
 *    它已落到 Cloudflare DDoS 防护后面，稳定返回 reCAPTCHA HTML 而非 JSON。
 * 2. **只做 medium.com 上的 4 种**：官方还列了 `{user}.medium.com/feed` 和
 *    `{customdomain}/feed`，但 `fetcher.ts` 的白名单是 `includes()` 精确匹配
 *    （fetcher.ts:46），自定义域意味着任意 host 出口 = SSRF，故不做。
 * 3. **必须 transform，原因是体积**：`content:encoded` 是文章全文 HTML，
 *    10 篇加起来经常上百 KB。只取纯文本摘要后输出约 3KB。
 * 4. **上游固定 10 条且不可分页**（社区实测请求 25 条仍只回 10 条），
 *    所以 `limit` 只是客户端截断，不是上游参数。
 * 5. **重试关掉**：Medium 限流不带 `Retry-After`（Cloudflare 挂在前面），
 *    社区实测要等几分钟。`fetcher.ts` 的退避只有 200/600/1500ms，
 *    对这种持续封锁纯属浪费负载，不如快速失败让 60s 负缓存去压。
 */
const FEED = 'https://medium.com/feed'

/**
 * 路径段字符白名单。三个值都直接拼进上游 URL，显式拒掉 `/`（路径穿越）
 * 与 `& % ? #`（query 注入）。Medium 的 slug 只可能是小写字母数字加连字符。
 */
const TAG_PATTERN = /^[a-z0-9][a-z0-9-]{0,49}$/
const PUBLICATION_PATTERN = /^[a-z0-9][a-z0-9-]{0,49}$/
/** 账号名额外允许 `.` `_` `-`，但仍要拒掉 `..`（负向前瞻） */
const USER_PATTERN = /^(?!.*\.\.)[A-Za-z0-9][A-Za-z0-9._-]{0,49}$/

/** 上游固定 10 条，这是唯一真实的取值上限 */
const MAX_POSTS = 10
/** 上游不听话时的硬上限 */
const HARD_ITEM_CAP = 12
/** 摘要字数上限 */
const EXCERPT_MAX = 200

/** 上游固定 10 条不可分页，所以 limit 只是客户端截断，四个 op 共用一份声明 */
const LIMIT_PARAM: ParamDef = {
  name: 'limit',
  in: 'query',
  type: 'integer',
  required: false,
  description: '返回最近 N 条，1-10（上游固定 10 条不可分页）',
  default: '10',
  minimum: 1,
  maximum: 10,
}

const TAG_PARAM: ParamDef = {
  name: 'tag',
  in: 'path',
  type: 'string',
  required: true,
  description: 'topic 标签 slug，如 programming',
  maxLength: 50,
}

const PUBLICATION_PARAM: ParamDef = {
  name: 'publication',
  in: 'path',
  type: 'string',
  required: true,
  description: '出版物 slug，如 towards-data-science',
  maxLength: 50,
}

const USER_PARAM: ParamDef = {
  name: 'user',
  in: 'path',
  type: 'string',
  required: true,
  description: '作者账号名，不含 @',
  maxLength: 50,
}

export const params: Record<string, ParamDef[]> = {
  tag: [TAG_PARAM, LIMIT_PARAM],
  publication: [PUBLICATION_PARAM, LIMIT_PARAM],
  user: [USER_PARAM, LIMIT_PARAM],
  tagged: [PUBLICATION_PARAM, TAG_PARAM, LIMIT_PARAM],
}

export const def: ProviderDef = {
  name: 'medium',
  displayName: 'Medium',
  tier: 'A-',
  hosts: ['medium.com'],
  // 无官方数值。Cloudflare 对数据中心 IP 敏感，社区实测并发拉 feed 会吃 429，
  // 取 2000ms 自我约束；再低只会撞限流而不会换来更高成功率。
  minIntervalMs: 2000,
  uaNote: '官方公开 RSS 接口，零 key',
  parseCostMs: 3,
  attribution: '各文章版权归作者所有，Medium 托管',
  tos: 'https://help.medium.com/hc/en-us/articles/214874118-Using-RSS-feeds-of-profiles-publications-and-topics',
  limits:
    '上游固定 10 条且不可分页；只返回纯文本摘要不返回正文；付费文章仅给预览（无绕过）；' +
    '限流不带 Retry-After；不支持 {user}.medium.com 与自定义域 feed（白名单精确匹配，放开即 SSRF）',
  endpoints: [
    {
      op: 'tag',
      resource: 'feed',
      method: 'GET',
      path: '/api/v1/medium/tag/{tag}',
      summary: 'topic 热贴（RSS 转 JSON，取前 N 条）',
      params: params.tag ?? [],
      passthrough: false,
      inline: true,
      costMs: 3,
    },
    {
      op: 'publication',
      resource: 'feed',
      method: 'GET',
      path: '/api/v1/medium/publication/{publication}',
      summary: '出版物最新文章（RSS 转 JSON，取前 N 条）',
      params: params.publication ?? [],
      passthrough: false,
      inline: true,
      costMs: 3,
    },
    {
      op: 'user',
      resource: 'feed',
      method: 'GET',
      path: '/api/v1/medium/user/{user}',
      summary: '作者最新文章（RSS 转 JSON，取前 N 条）',
      params: params.user ?? [],
      passthrough: false,
      inline: true,
      costMs: 3,
    },
    {
      op: 'tagged',
      resource: 'feed',
      method: 'GET',
      path: '/api/v1/medium/tagged/{publication}/{tag}',
      summary: '出版物内某标签的最新文章（RSS 转 JSON，取前 N 条）',
      params: params.tagged ?? [],
      passthrough: false,
      inline: true,
      costMs: 3,
    },
  ],
}

export const runtime: ProviderRuntime = {
  name: def.name,
  async buildPlan(env, target): Promise<UpstreamPlan> {
    let url: string
    switch (target.op) {
      case 'tag':
        url = `${FEED}/tag/${requirePattern(target.id, TAG_PATTERN, 'tag')}`
        break
      case 'publication':
        url = `${FEED}/${requirePattern(target.id, PUBLICATION_PATTERN, 'publication')}`
        break
      case 'user':
        url = `${FEED}/@${requirePattern(target.id, USER_PATTERN, 'user')}`
        break
      case 'tagged': {
        // 多路径参数由 v1.ts 按声明顺序用 `/` 拼进 target.id（先例：github repo/owner）
        const parts = target.id.split('/')
        if (parts.length !== 2) {
          throw fail(ErrorCode.InvalidParameter, `invalid publication/tag: ${target.id}`, 400, {
            field: 'publication/tag',
            value: target.id,
          })
        }
        const publication = requirePattern(parts[0] ?? '', PUBLICATION_PATTERN, 'publication')
        const tag = requirePattern(parts[1] ?? '', TAG_PATTERN, 'tag')
        url = `${FEED}/${publication}/tagged/${tag}`
        break
      }
      default:
        throw fail(ErrorCode.NotFound, `unknown medium op: ${target.op}`, 404)
    }
    // retries: 0 —— Medium 限流是持续封锁，1.5s 退避救不回来
    return { url, resource: 'feed', timeoutMs: 5000, retries: 0 }
  },

  transform(raw, target): TransformResult {
    return {
      text: JSON.stringify(parseFeed(raw, readLimit(target))),
      contentType: 'application/json; charset=utf-8',
    }
  },
}

interface MediumPost {
  id: string
  title: string
  url: string
  author: string
  published: string
  updated: string
  tags: string[]
  image: string
  excerpt: string
  metered: boolean
}

interface MediumFeed {
  provider: 'medium'
  title: string
  url: string
  updated: string
  count: number
  posts: MediumPost[]
}

/**
 * 有界的 RSS 2.0 提取，不是通用 XML 解析器。
 * 骨架照 arXiv 的 `parseAtom`（零依赖、~2ms），但 Medium 有四个 arXiv 没有的坑：
 *
 * - **CDATA**：`title` / `dc:creator` / `category` / `content:encoded` 全部包在
 *   `<![CDATA[...]]>` 里，必须先剥壳。CDATA 内部实体不转义，是字面文本。
 * - **`<guid isPermaLink="false">` 带属性**：arXiv 的 `tagText` 写死 `<${tag}>`，
 *   这里改成 `<${tag}(?:\s[^>]*)?>` 才吃得到。
 * - **`<link>` 挂 `?source=rss-XXXX------2`**：不剥会污染 URL 和缓存键。
 * - **正文插零宽字符**：见 `stripInvisible`。
 *
 * 结构性错误一律抛 502（会重试），不抛 404：`transform` 拿不到 HTTP 状态，
 * 无法区分"上游改版"和"资源不存在"，猜错就是全站该 feed 被负缓存 6 小时。
 */
export function parseFeed(raw: string, limit: number): MediumFeed {
  if (!/<rss[\s>]/i.test(raw) || !/<channel[\s>]/i.test(raw)) {
    throw fail(ErrorCode.UpstreamError, 'medium response is not an RSS feed', 502)
  }
  // RSS 2.0 规定 channel 至多一个，用贪婪匹配；拿不到就整体当结构不符
  const channel = /<channel[^>]*>([\s\S]*)<\/channel>/i.exec(raw)?.[1]
  if (channel === undefined) {
    throw fail(ErrorCode.UpstreamError, 'medium feed has no channel element', 502)
  }

  const blocks = channel.match(/<item[^>]*>[\s\S]*?<\/item>/gi) ?? []
  // 0 items 抛 502 而不是返回空数组：社区实测 Medium 被限流时会"200 + 空 body"，
  // 朴素抓取器会当成成功写 0 行。空结果被缓存 120s 意味着热贴凭空消失，
  // 而 502 至少能让下次请求重试。代价是真正冷清的 tag 也会 502——已知取舍。
  if (blocks.length === 0) {
    throw fail(ErrorCode.UpstreamError, 'medium feed returned no items', 502)
  }

  const posts: MediumPost[] = []
  for (const block of blocks.slice(0, HARD_ITEM_CAP)) {
    if (posts.length >= limit) break

    const description = unwrapCdata(tagText(block, 'description'))
    const content = unwrapCdata(tagText(block, 'content:encoded'))
    const url = stripSource(tagText(block, 'link').trim())
    // `description` 里 Medium 自己渲染的 snippet 段比剥全文稳，优先用
    const snippet = /<p[^>]*class="[^"]*medium-feed-snippet[^"]*"[^>]*>([\s\S]*?)<\/p>/i.exec(
      description,
    )?.[1]
    const image =
      /<img[^>]+src="([^"]+)"/i.exec(content)?.[1] ??
      /<img[^>]+src="([^"]+)"/i.exec(description)?.[1] ??
      ''

    posts.push({
      id: stripSource(tagText(block, 'guid').trim()),
      title: collapse(clean(unwrapCdata(tagText(block, 'title')))),
      url,
      author: collapse(clean(unwrapCdata(tagText(block, 'dc:creator')))),
      // RFC-822 原样透传：RSS 规范只要求 822，且各源统一到 ISO 会引入解析歧义
      published: tagText(block, 'pubDate').trim(),
      updated: tagText(block, 'atom:updated').trim(),
      tags: [...block.matchAll(/<category[^>]*>([\s\S]*?)<\/category>/gi)]
        .map((m) => collapse(clean(unwrapCdata(m[1] ?? ''))))
        .filter((value) => value.length > 0),
      image,
      excerpt: collapse(clean(htmlToText(snippet ?? content))).slice(0, EXCERPT_MAX).trimEnd(),
      // 付费/计量文章在预览末尾留这句，本项目不做任何绕过
      metered: /Continue reading on/i.test(description) || /Continue reading on/i.test(content),
    })
  }

  return {
    provider: 'medium',
    title: collapse(clean(unwrapCdata(tagText(channel, 'title')))),
    url: stripSource(tagText(channel, 'link').trim()),
    updated: tagText(channel, 'lastBuildDate').trim(),
    count: posts.length,
    posts,
  }
}

/**
 * 容忍属性的取标签文本。RSS 里 `<guid isPermaLink="false">` 带属性，
 * 写死 `<${tag}>` 匹配不到（arXiv 的 `tagText` 就有这个盲区）。
 */
function tagText(block: string, tag: string): string {
  return new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`).exec(block)?.[1] ?? ''
}

/** CDATA 剥壳：CDATA 内部不做实体转义，是字面文本 */
function unwrapCdata(value: string): string {
  const match = /^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/.exec(value)
  return match?.[1] ?? value
}

/**
 * 剥掉 Medium 挂在链接上的追踪后缀。
 * `<link>https://medium.com/p/abc123?source=rss-XXXXXXXXX------2</link>`
 * 与 `<guid isPermaLink="false">https://medium.com/p/abc123</guid>` 都要过这里。
 */
function stripSource(value: string): string {
  return value.replace(/[?&]source=rss[^&#]*/, '').replace(/[?&]$/, '')
}

/**
 * HTML 片段 → 纯文本。
 *
 * 顺序是**先剥标签再解实体**：反过来（telegram.ts:199-204 那样链式 replace）
 * 会把正文里字面意义的 `&amp;lt;script&amp;gt;` 二次解码成 `<script>`，
 * 而 `JSON.stringify` 不转义 `<`，等于开了一条注入通道。
 */
function htmlToText(value: string): string {
  return value
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(?:p|div|li|blockquote|h[1-6]|figure)>/gi, '\n')
    .replace(/<[^>]*>/g, '')
}

/** 剥标签 → 解实体 → 去零宽，文本进 JSON 前的固定清洗链 */
function clean(value: string): string {
  return stripInvisible(decode(htmlToText(value)))
}

const NAMED_ENTITIES: Readonly<Record<string, string>> = Object.freeze({
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  mdash: '—', ndash: '–', hellip: '…',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”',
  laquo: '«', raquo: '»', middot: '·', bull: '•',
  copy: '©', reg: '®', trade: '™', deg: '°',
  times: '×', divide: '÷', minus: '−', plusmn: '±',
  frac12: '½', frac14: '¼', sup2: '²', sup3: '³', micro: 'µ',
  euro: '€', pound: '£', yen: '¥', cent: '¢',
  sect: '§', para: '¶', dagger: '†', permil: '‰', prime: '′', Prime: '″',
  larr: '←', rarr: '→', harr: '↔', ne: '≠', le: '≤', ge: '≥',
  eacute: 'é', egrave: 'è', agrave: 'à', ccedil: 'ç', uuml: 'ü',
  ouml: 'ö', auml: 'ä', szlig: 'ß', ntilde: 'ñ',
})

/**
 * 单次正则回调解实体。**未知实体原样保留**（返回 `whole`），
 * 避免把上游的合法实体吞成空串。单次遍历也不会二次解码。
 */
function decode(value: string): string {
  return value.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body.startsWith('#x') || body.startsWith('#X')) {
      const code = Number.parseInt(body.slice(2), 16)
      return readableCodePoint(code, whole)
    }
    if (body.startsWith('#')) {
      const code = Number.parseInt(body.slice(1), 10)
      return readableCodePoint(code, whole)
    }
    return NAMED_ENTITIES[body] ?? whole
  })
}

/**
 * 只有合法 Unicode 标量才解码。孤立代理对（`&#xD800;`）和越界值（`&#x110000;`）
 * 会让 `String.fromCodePoint` 抛 RangeError——inline 路径的 transform 没包 try/catch，
 * 一旦抛出来就是漏成 500 且不写负缓存。这类值保留原文，不吞不炸。
 */
function readableCodePoint(code: number, whole: string): string {
  if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return whole
  if (code >= 0xd800 && code <= 0xdfff) return whole
  return String.fromCodePoint(code)
}

/**
 * 零宽字符清洗。
 *
 * Medium 在正文里插 U+2060 / U+200C / U+200D 当排版扰动，实测
 * "build" 会变成 "bui<U+2060>d<U+200C>l<U+2060>t"。不清理则字符串比对、
 * 搜索、去重全部失效，而且这些字符会静默改变 `title` / `excerpt` 的长度。
 *
 * **但不能无脑全删**：U+200D 是 emoji 序列的载体（👨‍👩‍👧‍👦 = 4 个码位 + 3 个 ZWJ），
 * U+200C/200D 在波斯语、阿拉伯语、天城文里承担真实的连字 shaping。
 * 删掉等于静默改写正文，而且因为字符不可见，出问题要到很久以后才被发现。
 * 所以只删"两侧都不是 pictographic、也不在 shaping 文字里"的那些。
 */
function stripInvisible(value: string): string {
  const chars = Array.from(value)
  const out: string[] = []
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i] as string
    const cp = ch.codePointAt(0) as number
    // 散文里无语义的零宽：word joiner / ZWSP / BOM / soft hyphen
    if (cp === 0x2060 || cp === 0x200b || cp === 0xfeff || cp === 0x00ad) continue
    if (cp === 0x200c || cp === 0x200d) {
      const prev = i > 0 ? (chars[i - 1] as string).codePointAt(0) : undefined
      const next = i + 1 < chars.length ? (chars[i + 1] as string).codePointAt(0) : undefined
      if (isPictographic(prev) && isPictographic(next)) {
        out.push(ch)
        continue
      }
      if (isShapingScript(prev) || isShapingScript(next)) {
        out.push(ch)
        continue
      }
      continue
    }
    out.push(ch)
  }
  return out.join('')
}

/** emoji 区段：Misc Symbols、Emoticons、Transport、Supplemental Symbols 等 */
function isPictographic(cp: number | undefined): boolean {
  if (cp === undefined) return false
  return (
    (cp >= 0x1f000 && cp <= 0x1faff) ||
    (cp >= 0x1f900 && cp <= 0x1f9ff) ||
    (cp >= 0x2600 && cp <= 0x27bf) ||
    cp === 0xfe0f ||
    cp === 0x2b50
  )
}

/** 依赖 joining 的文字区段：阿拉伯/波斯、叙利亚、天城文、阿拉伯增补 */
function isShapingScript(cp: number | undefined): boolean {
  if (cp === undefined) return false
  return (
    (cp >= 0x0600 && cp <= 0x06ff) ||
    (cp >= 0x0700 && cp <= 0x074f) ||
    (cp >= 0x0750 && cp <= 0x077f) ||
    (cp >= 0x0900 && cp <= 0x0d7f) ||
    (cp >= 0xfb50 && cp <= 0xfdff) ||
    (cp >= 0xfe70 && cp <= 0xfeff)
  )
}

function collapse(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

/**
 * 队列路径的 target 来自 `decodeTarget`，完全不做范围校验（target.ts:25-53），
 * 绕过了 v1.ts 的 `collectQuery`。所以 clamp 是必需防御，不是冗余。
 */
function readLimit(target: { query: [string, string][] }): number {
  const raw = queryValue(target, 'limit')
  if (raw === undefined) return MAX_POSTS
  const value = Number.parseInt(raw, 10)
  return Number.isFinite(value) && value > 0 ? Math.min(value, MAX_POSTS) : MAX_POSTS
}

function requirePattern(value: string, pattern: RegExp, field: string): string {
  if (!pattern.test(value)) {
    throw fail(ErrorCode.InvalidParameter, `invalid ${field}: ${value}`, 400, { field, value })
  }
  return value
}
