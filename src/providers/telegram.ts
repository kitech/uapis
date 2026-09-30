import { ErrorCode, fail } from '../core/errors'
import { FORMAT_PARAM } from '../core/uapis'
import { queryValue } from '../core/target'
import type { ParamDef, ProviderDef } from '../core/registry'
import type { TransformResult, UpstreamPlan, ProviderRuntime } from './runtime'

/**
 * Telegram 公开频道的网页预览 `t.me/s/{channel}`，零凭据。
 *
 * **为什么不用 MTProto / Bot API**：
 * - Bot API 要频道管理员把 bot 拉进去，公开频道拿不到这个权限。
 * - MTProto 要 `api_id`/`api_hash` + 手机号登录 + session 文件，
 *   是长连接有状态架构，和本项目的单请求 Worker 形态完全不兼容，
 *   而且自动化 session 有被封风险。
 * `/s/` 是服务端渲染的预览页，任何 UA 都能拿到，无需登录、无需 token。
 *
 * **四个必须挡掉的坑**（全部来自 snscrape / tchan / skraper 三份独立
 * 开源实现的交叉印证；本机连不上 t.me 无法实测，风险记在这里）：
 *
 * 1. **"频道不存在"不是 404。** 私域频道/群组/机器人/不存在的频道都返回
 *    **HTTP 200**，而且页面里没有任何 post 节点——和"频道存在但没消息"
 *    长得一模一样。snscrape 的判据是**重定向后的最终 URL 是否还含 `/s/`**：
 *    无公开预览时 Telegram 会把它 302 到别的路径。所以必须看最终 URL，
 *    不能看状态码，也不能看"post 数为 0"。
 *    本项目拿不到上游最终 URL（`UpstreamPlan` 只有一个 url，无 finalUrl），
 *    所以用等价判据：私域频道/用户账号一律没有 `tgme_channel_info` 块。
 * 2. **`tme_no_messages_found` 不能当空频道。** 请求过密时上游会返回
 *    "没找到消息"页面，此时频道其实是正常的。抛 502 让上层重试，
 *    返回空数组会被负缓存 6 小时。
 * 3. **服务消息混在正文里。** `div.service_message` 是"频道已创建"之类的
 *    系统通知，不是用户内容，直接跳过。
 * 4. **页面是倒序的。** `t.me/s/` DOM 里旧帖在上、最新在末尾（时间正序），
 *    snscrape 和 skraper 都用 `reversed()` 处理。`reversed()` 后输出最新在前，
 *    与页面"新帖置顶"观感一致（已在部署节点对真实页面验证）。
 *
 * **limit 上限只有 20**：一页就是约 20 条，而 `UpstreamPlan` 只支持单个 url
 * （见 `runtime.ts`），框架层没有多请求编排能力。要 N>20 条就得改
 * `fetcher.ts` 支持多 URL，本轮不做。
 *
 * **拿不到的东西**：评论、投票详情、reactions 数量、转发次数——
 * 这些只在 MTProto 里暴露，网页预览没有。
 */
const BASE = 'https://t.me'
/**
 * 频道用户名：字母开头，3-32 位字母数字下划线。
 * Telegram 规则是 5-32 位，这里放宽到 3 以免误杀短名，
 * 但仍强制字母开头（挡住纯数字被当成 id 解析）。
 */
const CHANNEL_PATTERN = /^[A-Za-z][A-Za-z0-9_]{2,31}$/
/** 单页最多 20 条，超出框架能力，见文件头说明 */
const MAX_LIMIT = 20

export const params: Record<string, ParamDef[]> = {
  channel: [
    { name: 'channel', in: 'path', type: 'string', required: true, description: '频道用户名，如 telegram / durov（不带 @）', maxLength: 32 },
    { name: 'limit', in: 'query', type: 'integer', required: false, description: '返回最近 N 条，1-20（单页上限）', default: '20', minimum: 1, maximum: MAX_LIMIT },
    FORMAT_PARAM,
  ],
}

export const def: ProviderDef = {
  name: 'telegram',
  displayName: 'Telegram',
  tier: 'A',
  hosts: ['t.me'],
  minIntervalMs: 1000,
  uaNote: '公开网页预览 t.me/s/，无需 api_id/api_hash、无需登录',
  parseCostMs: 3,
  attribution: '各帖版权归频道作者所有',
  tos: 'https://telegram.org/tos',
  limits: '官方未公布预览页限流；本项目取 1000ms 自我约束',
  endpoints: [
    {
      op: 'channel',
      resource: 'feed',
      method: 'GET',
      path: '/api/v1/telegram/channel/{channel}',
      summary: '公开频道最近 N 条消息（解析 t.me/s/ 预览页）',
      params: params.channel ?? [],
      // 上游是 HTML，必须 transform 成 JSON
      passthrough: false,
      inline: true,
      costMs: 3,
    },
  ],
}

export const runtime: ProviderRuntime = {
  name: def.name,
  async buildPlan(env, target): Promise<UpstreamPlan> {
    switch (target.op) {
      case 'channel': {
        const channel = requirePattern(target.id, CHANNEL_PATTERN, 'channel')
        return {
          url: `${BASE}/s/${channel}`,
          resource: 'feed',
          timeoutMs: 5000,
          retries: 0,
        }
      }
      default:
        throw fail(ErrorCode.NotFound, `unknown telegram op: ${target.op}`, 404)
    }
  },

  transform(raw, target): TransformResult {
    const limit = readLimit(target)
    return {
      text: JSON.stringify(parseChannel(raw, limit)),
      contentType: 'application/json; charset=utf-8',
    }
  },
}

interface ChannelPost {
  id: number
  date?: string
  text?: string
  views?: number
  has_photo?: boolean
  has_video?: boolean
  forwarded_from?: string
  url: string
}

interface ChannelInfo {
  provider: 'telegram'
  channel: string
  title?: string
  description?: string
  subscribers?: number
  posts: ChannelPost[]
}

/**
 * 上游是 HTML，这里用字符串定位而非 DOM 解析——
 * Worker 里没有 DOMParser，而目标类名（`tgme_widget_message` 等）经三份
 * 独立实现交叉印证是稳定的，走"切块 + 正则取字段"够用。
 * 代价是 Telegram 改版时这里要跟着调，风险已在文件头记录。
 */
function parseChannel(html: string, limit: number): ChannelInfo {
  // 坑 2：请求过密时上游回"没找到消息"，不能当成空频道
  if (html.includes('tme_no_messages_found')) {
    throw fail(ErrorCode.UpstreamError, 'telegram preview reported no messages found (likely rate limited)', 502)
  }

  const title = firstMatch(html, /class="tgme_channel_info_header_title"[^>]*>[\s\S]*?<span[^>]*>([^<]*)<\/span>/)
  // username 可能被 <a> 包裹（真实页面是 <a href="…/@durov">），整块捕获后剥标签
  const username = firstMatch(html, /class="tgme_channel_info_header_username"[^>]*>([\s\S]*?)<\/div>/)
    ?.replace(/<[^>]*>/g, '')
    .trim()

  // 坑 1：无公开预览时 Telegram 会 302 走，最终 URL 不含 /s/。
  // 私域频道/机器人/用户账号一律没有 tgme_channel_info 块，
  // 用它当等价判据——否则会把"频道不存在"当成"空结果"缓存 6 小时。
  if (title === undefined && username === undefined) {
    throw fail(ErrorCode.NotFound, 'telegram channel not found or has no public preview', 404)
  }

  const counterValue = firstMatch(html, /class="counter_value"[^>]*>([^<]*)</)
  const counterType = firstMatch(html, /class="counter_type"[^>]*>([^<]*)</)

  // channel 回退：username 块解析失败时用页面首条消息的 data-post 段
  const channel =
    (username ?? '')
      .replace(/^@/, '')
      .trim() ||
    firstMatch(html, /data-post="([^/"]+)\//) ||
    ''

  const info: ChannelInfo = {
    provider: 'telegram',
    channel,
    title,
    description: firstMatch(html, /class="tgme_channel_info_description"[^>]*>([\s\S]*?)<\/div>/)
      ?.replace(/<[^>]*>/g, '')
      .trim(),
    subscribers: counterType === 'subscribers' && counterValue !== undefined ? parseCount(counterValue) : undefined,
    posts: parsePosts(html, limit),
  }
  // 字段可选就整个不出现，而不是输出 null（与项目其他 provider 一致）
  for (const key of Object.keys(info) as (keyof ChannelInfo)[]) {
    if (info[key] === undefined) delete info[key]
  }
  return info
}

function parsePosts(html: string, limit: number): ChannelPost[] {
  const blocks = html.split('class="tgme_widget_message_wrap')
  const posts: ChannelPost[] = []

  for (const block of blocks) {
    if (posts.length >= limit) break
    if (!block.includes('data-post=')) continue

    const idRaw = firstMatch(block, /data-post="[^/"]+\/(\d+)"/)
    if (idRaw === undefined) continue
    const id = Number.parseInt(idRaw, 10)
    if (!Number.isFinite(id)) continue

    // 坑 3：系统消息不是内容
    if (block.includes('service_message')) continue

    const channel = firstMatch(block, /data-post="([^/"]+)\//)
    const views = firstMatch(block, /class="tgme_widget_message_views"[^>]*>([^<]*)</)
    const post: ChannelPost = {
      id,
      date: firstMatch(block, /<time[^>]*datetime="([^"]*)"/),
      // 保守实现：正文遇内嵌 <div>（如引用回复块）会在首个 </div> 截断，属刻意取舍
      text: firstMatch(block, /class="tgme_widget_message_text"[^>]*>([\s\S]*?)<\/div>/)
        ?.replace(/<br\s*\/?>/gi, '\n')
        .replace(/<[^>]*>/g, '')
        // 刻意的链式解码取舍：&amp;lt; 会被二次解成 <，正文以 JSON 下发，无注入风险
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .trim(),
      views: views === undefined ? undefined : parseCount(views),
      has_photo: block.includes('tgme_widget_message_photo_wrap') || undefined,
      has_video: block.includes('tgme_widget_message_video_player') || undefined,
      forwarded_from: firstMatch(block, /class="tgme_widget_message_forwarded_from_name"[^>]*>\s*(?:<[^>]*>)*([^<]+)/)?.trim(),
      url: channel === undefined ? '' : `https://t.me/${channel}/${id}`,
    }
    for (const key of Object.keys(post) as (keyof ChannelPost)[]) {
      if (post[key] === undefined || post[key] === '') delete post[key]
    }
    posts.push(post)
  }

  // 坑 4：DOM 旧帖在上、最新在末尾；反转后输出最新在前
  return posts.reverse()
}

/** `1.36M` / `12.5K` / `934` → 整数；不可解析时返回 undefined 而不是 0 */
function parseCount(raw: string): number | undefined {
  const text = raw.replace(/\s+/g, '').trim()
  const match = /^([0-9]+(?:\.[0-9]+)?)([KMB]?)$/i.exec(text)
  if (match === null) return undefined
  const value = Number.parseFloat(match[1] ?? '0')
  if (!Number.isFinite(value)) return undefined
  const suffix = (match[2] ?? '').toUpperCase()
  const scale = suffix === 'K' ? 1e3 : suffix === 'M' ? 1e6 : suffix === 'B' ? 1e9 : 1
  return Math.round(value * scale)
}

function firstMatch(input: string, pattern: RegExp): string | undefined {
  return pattern.exec(input)?.[1]
}

function readLimit(target: { query: [string, string][] }): number {
  const raw = queryValue(target, 'limit')
  if (raw === undefined) return MAX_LIMIT
  const value = Number.parseInt(raw, 10)
  return Number.isFinite(value) && value > 0 ? Math.min(value, MAX_LIMIT) : MAX_LIMIT
}

function requirePattern(value: string, pattern: RegExp, field: string): string {
  if (!pattern.test(value)) {
    throw fail(ErrorCode.InvalidParameter, `invalid ${field}: ${value}`, 400, { field, value })
  }
  return value
}
