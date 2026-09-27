import { ErrorCode, fail } from '../core/errors'
import { getSetting } from '../core/settings'
import { queryValue } from '../core/target'
import type { ParamDef, ProviderDef } from '../core/registry'
import type { UpstreamPlan, ProviderRuntime } from './runtime'

/**
 * tier C：只能走付费代理通道的源。
 *
 * 这里只放**允许转发/代理**的公开内容源，且不提供任何"免费绕过"路径：
 * 没配 `zenrows.key` / `jina.key` 就是 503 `PROVIDER_UNCONFIGURED`。
 *
 * 目标 host 写死在 registry 里（`hosts`），出口 host 写死在 `egressHosts`
 * ——出口只有 ZenRows / Jina 自己，`validateRegistry()` 会分别校验两组。
 */
const TARGET_HOST = 'www.economist.com'
const ZENROWS_HOST = 'api.zenrows.com'
const JINA_HOST = 'r.jina.ai'

export const params: Record<string, ParamDef[]> = {
  article: [
    {
      name: 'slug',
      in: 'path',
      type: 'string',
      required: true,
      description: '文章路径（可含 `/`，如 finance/2026/01/01/some-article）',
      maxLength: 200,
      // Economist 的文章 URL 天然多段；单段 `:slug` 匹配不到
      multiSegment: true,
    },
  ],
}

export const def: ProviderDef = {
  name: 'economist',
  displayName: 'The Economist',
  tier: 'C',
  hosts: [TARGET_HOST],
  // 白名单存的是 hostname（不带 scheme），与 settings.upstream.allowlist 同一形态
  egressHosts: [ZENROWS_HOST, JINA_HOST],
  // 付费通道的节流交给 credits（每日 N 次），这里仍给个最小间隔兜底突发
  minIntervalMs: 10_000,
  uaNote: 'tier C 源只走 ZenRows / Jina，双通道都未配置时直接 503',
  parseCostMs: 1,
  // 两条付费通道任一可用即可；全空 = 这个 provider 现在没法回源
  requiredAnyOf: ['zenrows.key', 'jina.key'],
  attribution: '内容版权归 The Economist 所有，仅缓存标题与摘要',
  tos: 'https://www.economist.com/help/legal/terms-of-use',
  limits: '按 ZenRows credits / Jina 请求数计费，额度见 /status',
  endpoints: [
    {
      op: 'article',
      resource: 'wall',
      method: 'GET',
      path: '/api/v1/economist/article/{slug}',
      summary: '文章标题与摘要（经付费通道取回，缓存 24h）',
      params: params.article ?? [],
      // 上游是 HTML/Markdown，必须过 transform，不能原样透传
      passthrough: false,
      // 明确不内联：同步路径上没有额度节流
      inline: false,
      costMs: 1,
      // 不写死 channel：ZenRows 有额度就用 ZenRows，没有就退到 Jina
      proxy: { host: TARGET_HOST },
    },
  ],
}

const SLUG_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,180}$/
/** 显式拒掉相对路径段：`.` 允许（slug 里可能出现），`..` 不允许 */
const TRAVERSAL = /(^|\/)\.\.(\/|$)/

export const runtime: ProviderRuntime = {
  name: def.name,
  async buildPlan(env, target): Promise<UpstreamPlan> {
    // 双通道都没配就直接拒，不做任何"先试试免费路径"的事
    const zenrowsKey = await getSetting(env, 'zenrows.key')
    const jinaKey = await getSetting(env, 'jina.key')
    if (zenrowsKey.length === 0 && jinaKey.length === 0) {
      throw fail(
        ErrorCode.ProviderUnconfigured,
        'no paid channel configured for tier C source',
        503,
        { setting: 'zenrows.key', alternative: 'jina.key' },
      )
    }

    switch (target.op) {
      case 'article': {
        const slug = target.id.replace(/^\/+|\/+$/g, '')
        if (!SLUG_PATTERN.test(slug) || TRAVERSAL.test(slug)) {
          throw fail(ErrorCode.InvalidParameter, `invalid slug: ${target.id}`, 400, {
            field: 'slug',
            value: target.id,
          })
        }
        return {
          // 目标 host 来自 registry 常量，不接受调用方传入
          url: `https://${TARGET_HOST}/${slug}`,
          resource: 'wall',
          proxy: { provider: def.name, url: `https://${TARGET_HOST}/${slug}`, mode: 'raw' },
        }
      }
      default:
        throw fail(ErrorCode.NotFound, `unknown economist op: ${target.op}`, 404)
    }
  },

  transform(raw): { text: string; contentType: string } {
    return {
      text: JSON.stringify(extractArticle(raw)),
      contentType: 'application/json; charset=utf-8',
    }
  },
}

interface ArticleSummary {
  provider: 'economist'
  title: string
  description: string
  standfirst: string
  published: string
  section: string
}

/**
 * 有界提取：只取标题/描述这类公开元数据，不搬运正文。
 * 付费墙内容的正文不进缓存——转载它既违反条款也超出本项目的定位。
 */
export function extractArticle(raw: string): ArticleSummary {
  const meta = (property: string): string => {
    const pattern = new RegExp(
      `<meta[^>]+(?:property|name)=["']${property}["'][^>]*content=["']([^"']*)["']`,
      'i',
    )
    const reverse = new RegExp(
      `<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["']${property}["']`,
      'i',
    )
    return clean(decode(matchOf(pattern, raw) ?? matchOf(reverse, raw) ?? ''))
  }

  const title =
    meta('og:title') ||
    meta('twitter:title') ||
    clean(decode(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(raw)?.[1] ?? ''))

  return {
    provider: 'economist',
    title: title.slice(0, 200),
    description: meta('og:description').slice(0, 400) || meta('description').slice(0, 400),
    standfirst: meta('twitter:text').slice(0, 400),
    published: meta('article:published_time'),
    section: meta('article:section'),
  }
}

function matchOf(pattern: RegExp, raw: string): string | undefined {
  return pattern.exec(raw)?.[1]
}

function clean(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

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
      const named: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }
      return named[body] ?? whole
    })
    .replace(/<[^>]+>/g, '')
}
