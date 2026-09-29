import { Hono } from 'hono'
import type { AppEnv } from '../types'
import { jsonBody, textBody } from '../core/envelope'
import { allEndpoints, REGISTRY } from '../core/registry'
import { buildOpenApi } from '../core/openapi'
import { cacheRowCount } from '../core/cache'
import { bumpCounter, countersSnapshot, loggerState, logError } from '../core/logger'
import { getIntSetting, getSetting } from '../core/settings'
import { siteUrlOf } from '../core/site'
import {
  queueBudget,
  readAllQuota,
  readCredits,
  type CreditsSnapshot,
} from '../core/credits'
import { readGate } from '../core/gate'
import { readStats } from '../core/stats'
import { rawErrorText } from '../core/errors'
import { runHealthChecks } from '../core/health'
import { ensureSchema } from '../core/bootstrap'
import { PROBE_PREFIX } from '../core/queue'
import type { ProxyChannel } from '../core/fetcher'

const meta = new Hono<AppEnv>()

meta.get('/openapi.json', (c) => {
  const siteUrl = siteUrlOf(c.req)
  return jsonBody(c, buildOpenApi(siteUrl), {
    headers: { 'cache-control': 'public, max-age=300' },
  })
})

meta.get('/healthz', async (c) => {
  const report = await runHealthChecks(c.env)

  // 兜底自举：监控总会轮询 healthz，而真实流量可能长时间为零。
  // 幂等 DDL 重跑是安全的，所以这一处不判断「是否已试过」。
  if (!report.schema) {
    c.executionCtx.waitUntil(
      ensureSchema(c.env).catch((error) => {
        logError({ event: 'schema_bootstrap_failed', message: rawErrorText(error) })
      }),
    )
  }

  return jsonBody(c, report, { status: report.status === 'ok' ? 200 : 503 })
})

meta.get('/status', async (c) => {
  const degraded: string[] = []

  /**
   * 单个区块失败不该拖垮整页——/status 恰恰是 D1 故障时最该活着的那一页，
   * 拿它排障的人正需要看到 degraded 列表和各段的降级标记。
   * 失败记进 degraded、计入 minute.buckets，字段回落中性值。
   */
  const section = async <T>(label: string, fn: () => Promise<T>, fallback: T): Promise<T> => {
    try {
      return await fn()
    } catch (error) {
      degraded.push(label)
      bumpCounter(`degraded:${label}`)
      logError({ event: 'status_section_failed', section: label, message: rawErrorText(error) })
      return fallback
    }
  }

  const softRows = await getIntSetting(c.env, 'cache.soft_rows')
  const softQueue = await getIntSetting(c.env, 'queue.soft_limit')
  const budget = await section(
    'queue',
    () => queueBudget(c.env, softQueue > 0 ? softQueue : 2700),
    { used: 0, limit: 0, softLimit: softQueue, exhausted: true, throttled: true },
  )
  const rows = await section('cache', () => cacheRowCount(c.env), 0)

  const providers = await Promise.all(
    REGISTRY.map(async (provider) => {
      // 端点级 optional（如 GitHub 全家、SE /sites）意味着没配 key 也能用，
      // 因此只有"全部端点都要凭据"的 provider 才算 unconfigured
      const needsKey =
        provider.auth !== undefined &&
        provider.endpoints.some((endpoint) => endpoint.auth !== 'optional')
      const configured =
        !needsKey ? true : (await getSetting(c.env, provider.auth!.settingKey)).length > 0
      // 直连的 provider 每次回源都扣 quota.<provider>.default，所以要报；
      // tier C 记在付费通道维度，用 channels[].credits 表达，这里留 null 免得两处数字打架
      const isTierC = (provider.requiredAnyOf ?? []).length > 0
      // 额度表缺失/故障时不能回落成 used:0——那正是"迁移没跑"最难查的假象。
      // 置 null 并把原始错误放进 credits_error，让客户端能区分
      // "tier C 看 channels" 和 "读不到额度"。
      let credits: CreditsSnapshot | null = null
      let creditsError: string | null = null
      if (!isTierC) {
        try {
          credits = await readCredits(c.env, provider.name, 'default')
        } catch (error) {
          degraded.push(`credits:${provider.name}`)
          bumpCounter('degraded:credits')
          creditsError = rawErrorText(error)
          logError({
            event: 'status_section_failed',
            section: `credits:${provider.name}`,
            message: creditsError,
          })
        }
      }

      // tier C 没有单一 auth key，而是"任一付费通道可用即可"；
      // /status 要能一眼看出当前到底配了哪条通道、各剩多少 credits
      const channelKeys = provider.requiredAnyOf ?? []
      const channels =
        channelKeys.length === 0
          ? null
          : await Promise.all(
              channelKeys.map(async (key) => {
                let channelCredits: CreditsSnapshot | null = null
                let channelError: string | null = null
                try {
                  channelCredits = await readCredits(c.env, 'proxy', channelOf(key))
                } catch (error) {
                  degraded.push(`credits:${key}`)
                  bumpCounter('degraded:credits')
                  channelError = rawErrorText(error)
                  logError({
                    event: 'status_section_failed',
                    section: `credits:${key}`,
                    message: channelError,
                  })
                }
                return {
                  setting: key,
                  configured: (await getSetting(c.env, key)).length > 0,
                  credits:
                    channelCredits === null
                      ? null
                      : {
                          used: channelCredits.used,
                          limit: channelCredits.limit,
                          remaining: Number.isFinite(channelCredits.remaining)
                            ? channelCredits.remaining
                            : null,
                        },
                  credits_error: channelError,
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
            : {
                used: credits.used,
                limit: credits.limit,
                remaining: Number.isFinite(credits.remaining) ? credits.remaining : null,
              },
        credits_error: creditsError,
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
    // 补上只进 Workers Logs 的盲区：gate/stats/settings 的原始错误不经过
    // 响应体，这里给出「缺哪张表 / 哪一列 / 哪条迁移」的可操作结论。
    // 不跑队列探针：这个页面是给人排障时打开看的，每看一次就发一条队列
    // 消息 + 写一行，属于纯浪费
    schema: await section(
      'schema',
      async () => {
        const report = await runHealthChecks(c.env, { probeQueue: false })
        return {
          ok: report.schema,
          missing_tables: report.checks.schema.diff.missingTables,
          missing_columns: report.checks.schema.diff.missingColumns,
          missing_indexes: report.checks.schema.diff.missingIndexes,
          migrations_pending: report.checks.migrations.pending,
          write_ok: report.checks.write.ok,
          warnings: report.warnings,
        }
      },
      {
        ok: false,
        missing_tables: [],
        missing_columns: {},
        missing_indexes: [],
        migrations_pending: [],
        write_ok: false,
        warnings: [],
      },
    ),
    // stats 不走 section：readStats 本身就吞异常返回 []，由它自己的
    // stats_read_failed 计数器暴露，套 section 反而永远不会触发
    quota: await section('quota', () => readAllQuota(c.env), []),
    // readGate 是全表读，会带出 healthz 探针的哨兵行。滤掉，否则线上
    // /status 会多出几条 provider=__healthz_probe__* 的假闸门
    gate: await section(
      'gate',
      async () => (await readGate(c.env)).filter((row) => !row.provider.startsWith(PROBE_PREFIX)),
      [],
    ),
    stats: await readStats(c.env),
    degraded,
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
  const siteUrl = siteUrlOf(c.req)
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
