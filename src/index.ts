import { Hono } from 'hono'
import type { AppEnv } from './types'
import { cors } from './core/cors'
import { rateLimit } from './core/ratelimit'
import { requestId } from './core/requestId'
import { ApiError, ErrorCode, fail, isStorageError, rawErrorText, storageFail } from './core/errors'
import { errorResponse, jsonBody } from './core/envelope'
import { bumpCounter, logError } from './core/logger'
import { cacheRowCount, pruneExpired } from './core/cache'
import { enqueueRefresh, handleQueueBatch } from './core/queue'
import { encodeTarget } from './core/target'
import { getIntSetting, getSetting, putSettings } from './core/settings'
import { bumpStat } from './core/stats'
import { ensureSchema } from './core/bootstrap'
import v1 from './routes/v1'
import meta from './routes/meta'
import admin from './routes/admin'

const CRON_PRUNE = '7 */2 * * *'
const CRON_WARM = '*/30 * * * *'
const PRUNE_BATCH = 300
const WARM_BATCH = 50

const app = new Hono<AppEnv>()

app.use('*', requestId())
app.use('*', cors())
app.use('*', rateLimit())
// schema 缺失时自动安装。稳态下每个 isolate 只查一次 D1（完整契约比对），
// 之后走模块级记忆直接返回。waitUntil 而非 await：安装是修复动作，
// 不该让第一个真实请求替它买单；失败也不阻断，让请求照常走
// STORAGE_UNAVAILABLE 路径——那才是准确的错误语义。
app.use('*', async (c, next) => {
  c.executionCtx.waitUntil(
    ensureSchema(c.env).catch((error) => {
      logError({ event: 'schema_bootstrap_failed', message: rawErrorText(error) })
    }),
  )
  await next()
})

app.route('/', v1)
app.route('/', meta)
// 注意：管理端必须挂在 /admin 前缀下，否则子应用的 use('*') 鉴权会覆盖全部路由
app.route('/admin', admin)

app.get('/', (c) =>
  jsonBody(c, {
    name: 'uapis',
    version: '0.1.0',
    disclaimer: '本项目与 uapis.cn 无任何关联',
    api: '/api/v1',
    openapi: '/openapi.json',
    docs: '/docs/',
    status: '/status',
  }),
)

app.get('/docs', (c) => c.redirect('/docs/', 301))

app.notFound((c) => {
  if (c.req.path === '/docs' || (c.req.path.startsWith('/docs') && !c.req.path.endsWith('/'))) {
    return c.redirect('/docs/', 301)
  }
  return errorResponse(
    c,
    fail(ErrorCode.NotFound, `no route for ${c.req.method} ${c.req.path}`, 404, {
      openapi: '/openapi.json',
    }),
  )
})

app.onError((error, c) => {
  if (error instanceof ApiError) {
    bumpCounter(`error:${error.code}`)
    return errorResponse(c, error)
  }

  // D1 故障：把 cause 链上的原文一起返回，否则客户端只看到一个 D1_ERROR。
  // 透传表名/列名会暴露内部结构，这是自建实例下的有意取舍。
  if (isStorageError(error)) {
    const reqId = c.get('requestId')
    const storage = storageFail(error, { request_id: reqId })
    bumpCounter(`error:${storage.code}`)
    logError({
      event: 'storage_error',
      path: c.req.path,
      method: c.req.method,
      request_id: reqId,
      message: storage.message,
      stack: error instanceof Error ? error.stack : undefined,
    })
    return errorResponse(c, storage)
  }

  const reqId = c.get('requestId')
  logError({
    event: 'unhandled_error',
    path: c.req.path,
    method: c.req.method,
    request_id: reqId,
    message: rawErrorText(error),
    stack: error instanceof Error ? error.stack : undefined,
  })
  // 这条路径以前完全不计数，/status 里看不到任何 INTERNAL_ERROR
  bumpCounter(`error:${ErrorCode.InternalError}`)
  return errorResponse(
    c,
    new ApiError(ErrorCode.InternalError, 'internal error', 500, { request_id: reqId }),
  )
})

export default {
  fetch: app.fetch,

  async queue(batch: MessageBatch<unknown>, env: Env, ctx: ExecutionContext): Promise<void> {
    const stats = await handleQueueBatch(batch, env)
    ctx.waitUntil(
      (async () => {
        await bumpStat(env, '__queue_processed', stats.processed)
        await bumpStat(env, '__queue_refreshed', stats.refreshed)
        await bumpStat(env, '__queue_retried', stats.retried)
        await bumpStat(env, '__queue_dropped', stats.dropped)
      })(),
    )
  },

  async scheduled(
    controller: ScheduledController,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<void> {
    // cron 兜底：保证「部署后长时间无真实流量」时 schema 也会装好
    ctx.waitUntil(
      ensureSchema(env)
        .then((result) => {
          if (result.applied.length > 0) {
            logError({ event: 'schema_bootstrapped', applied: result.applied })
          }
          if (result.refused.length > 0) {
            logError({ event: 'schema_bootstrap_refused', migrations: result.refused })
          }
          // 列没验证过是持续状态（不是一次性事件），单独记一条：
          // 出现它就说明 /healthz 的 schema 段会长期 ok:false，
          // 而表可能其实都在。看 probe_tier 字段确认 D1 放行了哪一级
          if (result.columnsUnverified === true) {
            logError({ event: 'schema_columns_unverified', applied: result.applied })
          }
          return controller.cron === CRON_WARM ? warm(env) : prune(env)
        })
        .catch((error) => {
          logError({ event: 'schema_bootstrap_failed', message: rawErrorText(error) })
        }),
    )
  },
}

/** 每 2 小时清理过期行并刷新软上限计数（写额度受控：单批 300 行） */
async function prune(env: Env): Promise<void> {
  const deleted = await pruneExpired(env, PRUNE_BATCH)
  const rows = await cacheRowCount(env)
  await putSettings(env, { 'cache.rows': String(rows) })
  await bumpStat(env, '__prune_deleted', deleted)
}

/**
 * 每 30 分钟给 warm.list 里的热门 key 预热。
 * 条目格式：`{cacheKey}|{provider}|{target}`，逗号分隔；受当日队列软上限约束。
 */
async function warm(env: Env): Promise<void> {
  const list = (await getSetting(env, 'warm.list'))
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
  if (list.length === 0) {
    await bumpStat(env, '__warm_skipped', 1)
    return
  }

  // 只读模式下预热没有意义：它就是自动回源，跑起来照常烧队列和上游额度
  if ((await getSetting(env, 'maintenance.mode')).toLowerCase() !== 'active') {
    await bumpStat(env, '__warm_skipped', list.length)
    return
  }

  let queued = 0
  for (const entry of list.slice(0, WARM_BATCH)) {
    const [key, provider, target] = entry.split('|')
    if (key === undefined || provider === undefined || target === undefined) continue
    const result = await enqueueRefresh(env, { v: 1, k: key, p: provider, t: target })
    if (result === 'sent') queued += 1
    else break
  }
  await bumpStat(env, '__warm_queued', queued)
}
