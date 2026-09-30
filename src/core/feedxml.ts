import type { TransformResult } from '../providers/runtime'
import type { FeedSlice } from './uapis'
import { ATOM_CT, RSS_CT } from './envelope'
import { hashPairs } from './ttl'

/** 体积护栏：只防单条撑爆文档，不是内容策略 */
const TITLE_MAX = 2000
const SUMMARY_MAX = 1000

/** XML 1.0 不接受这些码点，留着整份文档不合法、阅读器直接拒收 */
const ILLEGAL_XML = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g
/** 孤立代理项同样不合法；但成对代理项是合法字符（emoji），不能整段删 */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g

/**
 * 序列化所需的 provider 上下文。
 * 刻意不含请求 origin：刷新有队列那条路径（core/queue.ts）拿不到 request，
 * 更关键的是缓存字节必须与请求方无关——把 origin 写进 XML，一个域名下抓到的
 * 条目会被另一个域名的客户端拿到，link 会指错地方。
 */
export interface FeedXmlContext {
  providerName: string
  displayName: string
  hosts: string[]
  op: string
  id: string
  /**
   * 端点的 query 参数。注意有些 feed 的区分信息**只**在 query 里：
   * usgs search 的 minmagnitude、gitlab commits 的 project、
   * openmeteo hourly 的经纬度、hn front/latest 的 page/tags——
   * 它们的 id 与 op 都是空的，不并进 id 会让不同查询共用同一个 feed id。
   */
  query: [string, string][]
}

function xmlSafe(value: string): string {
  return value.replace(ILLEGAL_XML, '').replace(LONE_SURROGATE, '')
}

/** 顺序要紧：先 `&` 再其余，否则 `&lt;` 会被二次转义成 `&amp;lt;` */
function esc(value: string): string {
  return xmlSafe(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function escAttr(value: string): string {
  return esc(value).replace(/"/g, '&quot;')
}

function el(name: string, value: string): string {
  return `<${name}>${esc(value)}</${name}>`
}

/**
 * 上游摘要基本都是 HTML（devto.description / HN story_text / lobsters.description）。
 * 这里降成纯文本，而不是在 Atom 里用 `type="html"`、在 RSS 里塞 CDATA：
 * 前者等于把上游 HTML 引进阅读器的渲染面，后者的 `]]>` 要另开注入分支，
 * 纯文本在两种格式下行为一致。
 *
 * 实体解码顺序也不能改——`&amp;` 必须最后解，否则 `&amp;lt;script&amp;gt;`
 * 会被二次解成 `<script>`，与 medium/provider 那侧刻意保留的链式解码取舍冲突。
 *
 * 只对**确实是 HTML** 的字段用。Medium 的 excerpt 在 provider 里已经过了
 * htmlToText（src/providers/medium.ts），再套一遍就是二次解码。
 */
export function plainText(value: string): string {
  return value
    // 先摘掉整个 script/style 块。只靠后面那条剥标签规则的话，<script> 的**内容**
    // 会留下来变成正文文字（虽然转义后不算注入，但订阅者会看到一段垃圾）
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<\s*(?:br|hr)\s*\/?>/gi, '\n')
    .replace(/<\s*\/\s*(?:p|div|li|h[1-6])\s*>/gi, '\n\n')
    .replace(/<\s*li[^>]*>/gi, '• ')
    .replace(/<[^>]{0,200}>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&amp;/gi, '&')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** 截断可能切开代理对，残留的半个由 xmlSafe 剔除 */
function clamp(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value
}

/** RSS 要求 item 至少有 title 或 description，空标题兜底成序号 */
function titleOf(item: { title: string }, index: number): string {
  return clamp(item.title, TITLE_MAX) || `#${index + 1}`
}

function msOf(iso: string): number {
  const ms = Date.parse(iso)
  return Number.isFinite(ms) ? ms : Date.now()
}

/** RSS 日期字段要 RFC-822；`toUTCString()` 产出的 `Wdy, DD Mon YYYY HH:MM:SS GMT` 合法 */
function rfc822(iso: string): string {
  return new Date(msOf(iso)).toUTCString()
}

/** Atom 要 RFC-3339；`toISOString()` 正是它 */
function rfc3339(iso: string): string {
  return new Date(msOf(iso)).toISOString()
}

function isHttpUrl(value: string): boolean {
  return /^https?:\/\/[^\s]+$/i.test(value)
}

function channelLink(hosts: string[]): string {
  const host = hosts[0] ?? ''
  return host.length > 0 ? `https://${host}` : 'https://uapis.invalid'
}

/**
 * feed 级 id。用 urn 而不是 URL：不假装可解引用，也不受部署域名影响。
 *
 * 必须带上 query。usgs search / gitlab commits / openmeteo hourly / hn front+latest
 * 这几个端点的 id 与 op 都是空的，只拼 provider:op:id 会让 `minmagnitude=2.5`
 * 和 `minmagnitude=4.5` 产出同一个 id，违反 Atom 对 feed id 全局唯一的要求
 * （两者本来就在不同缓存桶里，于是成了两份内容相同、id 却撞车的文档）。
 *
 * query 段复用 hashPairs（core/ttl.ts）：它先 sort()，所以参数顺序无关，
 * 且和缓存键口径完全一致。滤掉 format —— 同一 feed 的 rss 与 atom 两种序列化
 * 本就该共用一个 id。query 为空时不加这一段，旧 id 形态保持不变。
 *
 * RSS 侧刻意不做对应的事：RSS 2.0 的 channel 没有 id 元素，身份由指向站点的
 * channel link 承担，跨查询恒定正合规范。
 */
function feedUrn(ctx: FeedXmlContext): string {
  const parts = [ctx.providerName, ctx.op, ctx.id]
    .filter((part) => part.length > 0)
    .map(encodeURIComponent)
  const base = `urn:uapis:${parts.join(':')}`
  const scoped = ctx.query.filter(([key]) => key !== 'format')
  return scoped.length === 0 ? base : `${base}:${hashPairs(scoped)}`
}

function itemUrn(slice: FeedSlice, index: number): string {
  return `urn:uapis:${slice.type}:item:${index + 1}`
}

function channelTitle(slice: FeedSlice): string {
  const raw = slice.top?.title
  const title = typeof raw === 'string' ? raw.trim() : ''
  return title.length > 0 ? title : `uapis ${slice.type}`
}

function summaryOf(item: { summary?: string }): string | undefined {
  return item.summary === undefined || item.summary.length === 0
    ? undefined
    : clamp(item.summary, SUMMARY_MAX)
}

/**
 * RSS 2.0：channel 必须齐 title/link/description；item 至少 title 或 description。
 * RSS 2.0 没有 item 级图片的标准元素，enclosure 又强制要求 length+type（都拿不到），
 * 所以 cover 在这里必然丢失——要封面用 Atom 或 uapis 格式。
 */
export function toRss(slice: FeedSlice, ctx: FeedXmlContext): TransformResult {
  const out: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<rss version="2.0">',
    '<channel>',
    el('title', channelTitle(slice)),
    el('link', channelLink(ctx.hosts)),
    el('description', `uapis ${slice.type} feed via ${ctx.displayName}`),
    el('generator', 'uapis/0.1.0'),
    el('lastBuildDate', rfc822(slice.updateTime)),
  ]
  // 同一 feed 内 guid 不能重复。四个 provider 都不去重（medium 在 provider 层去了），
  // url 撞过就退回 urn 形态，否则会撞车
  const seen = new Set<string>()
  slice.items.forEach((item, i) => {
    const absolute = isHttpUrl(item.url)
    const permalink = absolute && !seen.has(item.url)
    if (absolute) seen.add(item.url)
    out.push('<item>')
    out.push(el('title', titleOf(item, i)))
    if (absolute) out.push(el('link', item.url))
    out.push(
      permalink
        ? `<guid isPermaLink="true">${esc(item.url)}</guid>`
        : `<guid isPermaLink="false">${esc(itemUrn(slice, i))}</guid>`,
    )
    if (item.date !== undefined) out.push(el('pubDate', rfc822(item.date)))
    const summary = summaryOf(item)
    if (summary !== undefined) out.push(el('description', summary))
    out.push('</item>')
  })
  out.push('</channel>', '</rss>')
  return { text: out.join('\n'), contentType: RSS_CT }
}

/**
 * Atom 1.0：feed 与每条 entry 都必须齐 id/title/updated；
 * author 要么 feed 级有，要么每条 entry 都有，所以这里恒在 feed 级兜一个。
 */
export function toAtom(slice: FeedSlice, ctx: FeedXmlContext): TransformResult {
  const out: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<feed xmlns="http://www.w3.org/2005/Atom">',
    el('id', feedUrn(ctx)),
    el('title', channelTitle(slice)),
    el('updated', rfc3339(slice.updateTime)),
    `<author><name>${esc(ctx.displayName)}</name></author>`,
    el('generator', 'uapis/0.1.0'),
    // Atom 的 link 是无内容元素，走 href 属性，不能当文本节点写
    `<link rel="alternate" href="${escAttr(channelLink(ctx.hosts))}"/>`,
  ]
  // 同一 feed 内 id 不能重复：url 撞过就退回 urn 形态
  const seen = new Set<string>()
  slice.items.forEach((item, i) => {
    const absolute = isHttpUrl(item.url)
    const permalink = absolute && !seen.has(item.url)
    if (absolute) seen.add(item.url)
    out.push('<entry>')
    out.push(el('id', permalink ? item.url : itemUrn(slice, i)))
    out.push(el('title', titleOf(item, i)))
    out.push(el('updated', rfc3339(item.date ?? slice.updateTime)))
    if (absolute) out.push(`<link rel="alternate" href="${escAttr(item.url)}"/>`)
    const summary = summaryOf(item)
    if (summary !== undefined) out.push(el('summary', summary))
    out.push('</entry>')
  })
  out.push('</feed>')
  return { text: out.join('\n'), contentType: ATOM_CT }
}
