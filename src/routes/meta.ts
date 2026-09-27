import { Hono } from 'hono'
import type { AppEnv } from '../types'
import { jsonBody, textBody } from '../core/envelope'
import { allEndpoints, REGISTRY } from '../core/registry'
import { buildOpenApi } from '../core/openapi'
import { cacheRowCount } from '../core/cache'
import { countersSnapshot, loggerState } from '../core/logger'
import { getIntSetting, getSetting } from '../core/settings'
import { queueBudget, readAllQuota, readCredits } from '../core/credits'
import { readGate } from '../core/gate'
import { readStats } from '../core/stats'
import type { ProxyChannel } from '../core/fetcher'

const meta = new Hono<AppEnv>()

meta.get('/openapi.json', (c) => {
  const siteUrl = (c.env.SITE_URL ?? 'https://uapis.example.workers.dev').replace(/\/+$/, '')
  return jsonBody(c, buildOpenApi(siteUrl), {
    headers: { 'cache-control': 'public, max-age=300' },
  })
})

meta.get('/healthz', async (c) => {
  let d1 = true
  try {
    await c.env.DB.prepare('SELECT 1 AS ok').first()
  } catch {
    d1 = false
  }
  return jsonBody(
    c,
    { status: d1 ? 'ok' : 'degraded', d1, ts: new Date().toISOString() },
    { status: d1 ? 200 : 503 },
  )
})

meta.get('/status', async (c) => {
  const softRows = await getIntSetting(c.env, 'cache.soft_rows')
  const softQueue = await getIntSetting(c.env, 'queue.soft_limit')
  const budget = await queueBudget(c.env, softQueue > 0 ? softQueue : 2700)
  const rows = await cacheRowCount(c.env).catch(() => 0)

  const providers = await Promise.all(
    REGISTRY.map(async (provider) => {
      // 端点级 optional（如 GitHub 全家、SE /sites）意味着没配 key 也能用，
      // 因此只有"全部端点都要凭据"的 provider 才算 unconfigured
      const needsKey =
        provider.auth !== undefined &&
        provider.endpoints.some((endpoint) => endpoint.auth !== 'optional')
      const configured =
        !needsKey ? true : (await getSetting(c.env, provider.auth!.settingKey)).length > 0
      const credits = needsKey ? await readCredits(c.env, provider.name, 'default') : null

      // tier C 没有单一 auth key，而是"任一付费通道可用即可"；
      // /status 要能一眼看出当前到底配了哪条通道、各剩多少 credits
      const channelKeys = provider.requiredAnyOf ?? []
      const channels =
        channelKeys.length === 0
          ? null
          : await Promise.all(
              channelKeys.map(async (key) => {
                const channelCredits = await readCredits(c.env, 'proxy', channelOf(key))
                return {
                  setting: key,
                  configured: (await getSetting(c.env, key)).length > 0,
                  credits: {
                    used: channelCredits.used,
                    limit: channelCredits.limit,
                    remaining: Number.isFinite(channelCredits.remaining)
                      ? channelCredits.remaining
                      : null,
                  },
                }
              }),
            )
      const channelReady =
        channelKeys.length === 0 || (channels ?? []).some((item) => item.configured)

      return {
        name: provider.name,
        display_name: provider.displayName,
        tier: provider.tier,
        status: configured && channelReady ? 'active' : 'unconfigured',
        endpoints: provider.endpoints.length,
        min_interval_ms: provider.minIntervalMs,
        attribution: provider.attribution ?? null,
        tos: provider.tos ?? null,
        limits: provider.limits ?? null,
        auth: provider.auth === undefined ? null : provider.auth.settingKey,
        auth_required: needsKey,
        auth_optional: provider.auth !== undefined && !needsKey,
        channels,
        credits:
          credits === null
            ? null
            : { used: credits.used, limit: credits.limit, remaining: Number.isFinite(credits.remaining) ? credits.remaining : null },
      }
    }),
  )

  return jsonBody(c, {
    name: 'uapis',
    version: '0.1.0',
    disclaimer: '本项目与 uapis.cn 无任何关联',
    ts: new Date().toISOString(),
    runtime: {
      node: (globalThis as { navigator?: { userAgent?: string } }).navigator?.userAgent ?? 'workerd',
    },
    settings: {
      maintenance: await getSetting(c.env, 'maintenance.mode'),
      cache_t1: await getSetting(c.env, 'cache.t1'),
      cache_inline: await getSetting(c.env, 'cache.inline'),
      ratelimit_rpm: await getIntSetting(c.env, 'ratelimit.rpm'),
    },
    cache: { rows, soft_rows: softRows },
    queue: { used: budget.used, limit: budget.limit, soft_limit: budget.softLimit, throttled: budget.throttled },
    quota: await readAllQuota(c.env),
    gate: await readGate(c.env),
    stats: await readStats(c.env),
    minute: countersSnapshot(),
    logs: loggerState(),
    providers,
    free_tier_budget: {
      requests_per_day: 100_000,
      queue_operations_per_day: 10_000,
      d1_rows_read_per_day: 5_000_000,
      d1_rows_written_per_day: 100_000,
      log_events_per_day: 200_000,
      cpu_ms: 10,
    },
  })
})

meta.get('/llms.txt', (c) => {
  const siteUrl = (c.env.SITE_URL ?? '').replace(/\/+$/, '')
  const lines: string[] = [
    '# uapis',
    '',
    '> 与 uapis.cn 无关联的自建同类项目。',
    '',
    `- OpenAPI: ${siteUrl}/openapi.json`,
    `- 文档: ${siteUrl}/docs/`,
    `- 状态: ${siteUrl}/status`,
    '',
    '## 接口',
    '',
  ]
  for (const { provider, endpoint } of allEndpoints()) {
    lines.push(`- ${endpoint.method} ${siteUrl}${endpoint.path} — ${endpoint.summary}`)
  }
  lines.push(
    '',
    '## 约定',
    '',
    '- 成功响应为裸业务对象',
    '- 错误响应为 {code, message, details?}',
    '- 响应头含 X-Request-ID、X-Cache、RateLimit',
    '',
  )
  return textBody(c, lines.join('\n'), { headers: { 'cache-control': 'public, max-age=3600' } })
})

export default meta

/** `zenrows.key` → `zenrows`；`proxy` 维度的额度按通道名记账 */
function channelOf(settingKey: string): ProxyChannel {
  return settingKey.split('.')[0] as ProxyChannel
}
