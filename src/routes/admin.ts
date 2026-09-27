import type { Context, MiddlewareHandler } from 'hono'
import { Hono } from 'hono'
import type { AppEnv } from '../types'
import { ErrorCode, fail } from '../core/errors'
import { jsonBody } from '../core/envelope'
import { allSettings, putSettings, getSetting } from '../core/settings'
import { queueBudget, readAllQuota, readCredits, resetCredits } from '../core/credits'
import { readGate, holdProvider } from '../core/gate'
import { enqueueRefresh } from '../core/queue'
import { endpointByOp, providerByName, REGISTRY } from '../core/registry'
import { cacheKeyFor } from '../core/refresh'
import { encodeTarget, type Target } from '../core/target'
import { TTL_POLICIES } from '../core/ttl'
import { getAllowlist } from '../core/fetcher'
import { cacheRowCount, pruneExpired, remove } from '../core/cache'
import { bumpStat } from '../core/stats'

const requireAdmin: MiddlewareHandler<AppEnv> = async (c, next) => {
  const expected = c.env.ADMIN_TOKEN
  if (typeof expected !== 'string' || expected.length === 0) {
    throw fail(ErrorCode.ServiceUnavailable, 'ADMIN_TOKEN not configured', 503)
  }
  const header = c.req.header('authorization') ?? ''
  const token = header.startsWith('Bearer ') ? header.slice(7) : ''
  if (!constantTimeEquals(token, expected)) {
    throw fail(ErrorCode.Unauthorized, 'missing or invalid admin token', 401)
  }
  await next()
}

const admin = new Hono<AppEnv>()

admin.use('*', requireAdmin)

admin.get('/settings', async (c) => {
  const settings = await allSettings(c.env)
  return jsonBody(c, { settings: maskSecrets(settings) })
})

admin.put('/settings', async (c) => {
  const body = await readJson(c)
  const entries: Record<string, string> = {}
  for (const [key, value] of Object.entries(body)) {
    if (!/^[a-z0-9._-]{1,64}$/.test(key)) {
      throw fail(ErrorCode.InvalidParameter, `invalid setting key: ${key}`, 400)
    }
    if (typeof value !== 'string') {
      throw fail(ErrorCode.InvalidParameter, `setting ${key} must be a string`, 400)
    }
    if (value.length > 4000) {
      throw fail(ErrorCode.FileTooLarge, `setting ${key} too long`, 413)
    }
    entries[key] = value
  }
  const written = await putSettings(c.env, entries)
  await bumpStat(c.env, '__admin_setting_writes', written)
  return jsonBody(c, { written, settings: maskSecrets(await allSettings(c.env)) })
})

admin.get('/quota', async (c) => {
  const soft = Number.parseInt(await getSetting(c.env, 'queue.soft_limit'), 10) || 2700
  return jsonBody(c, {
    queue: await queueBudget(c.env, soft),
    rows: await readAllQuota(c.env),
  })
})

admin.post('/quota/reset', async (c) => {
  const body = await readJson(c)
  const provider = typeof body.provider === 'string' ? body.provider : ''
  const channel = typeof body.channel === 'string' ? body.channel : 'default'
  if (provider.length === 0) {
    throw fail(ErrorCode.InvalidParameter, 'provider is required', 400)
  }
  await resetCredits(c.env, provider, channel)
  return jsonBody(c, { reset: { provider, channel } })
})

admin.get('/providers', async (c) => {
  const allowlist = await getAllowlist(c.env)
  return jsonBody(c, {
    allowlist,
    providers: await Promise.all(
      REGISTRY.map(async (provider) => ({
        ...provider,
        configured:
          provider.auth === undefined
            ? true
            : (await getSetting(c.env, provider.auth.settingKey)).length > 0,
        credits:
          provider.auth === undefined
            ? null
            : await readCredits(c.env, provider.name, 'default'),
      })),
    ),
  })
})

admin.post('/rebuild', async (c) => {
  const body = await readJson(c)
  const providerName = typeof body.provider === 'string' ? body.provider : ''
  const op = typeof body.op === 'string' ? body.op : ''
  const provider = providerByName(providerName)
  if (provider === undefined) {
    throw fail(ErrorCode.InvalidParameter, `unknown provider: ${providerName}`, 400)
  }
  const endpoint = endpointByOp(provider, op)
  if (endpoint === undefined) {
    throw fail(ErrorCode.InvalidParameter, `unknown op: ${op}`, 400)
  }
  const id = typeof body.id === 'string' ? body.id : ''
  const query: [string, string][] = Array.isArray(body.query)
    ? body.query
        .filter((pair): pair is [string, string] => Array.isArray(pair) && pair.length === 2)
        .map((pair) => [String(pair[0]), String(pair[1])])
    : []
  const target: Target = { op, id, query }
  const key = cacheKeyFor(providerName, endpoint.resource, target)
  await remove(c.env, key).catch(() => undefined)
  const result = await enqueueRefresh(c.env, { v: 1, k: key, p: providerName, t: encodeTarget(target) })
  return jsonBody(c, { key, provider: providerName, queued: result === 'sent' })
})

admin.post('/maintenance', async (c) => {
  const mode = c.req.query('mode') ?? 'active'
  if (mode !== 'active' && mode !== 'readonly') {
    throw fail(ErrorCode.InvalidParameter, 'mode must be active or readonly', 400)
  }
  await putSettings(c.env, { 'maintenance.mode': mode })
  return jsonBody(c, { maintenance: mode })
})

admin.post('/kill', async (c) => {
  const providerName = c.req.query('provider') ?? ''
  const minutes = Number.parseInt(c.req.query('minutes') ?? '30', 10)
  if (providerByName(providerName) === undefined) {
    throw fail(ErrorCode.InvalidParameter, `unknown provider: ${providerName}`, 400)
  }
  const until = await holdProvider(c.env, providerName, Number.isFinite(minutes) ? minutes : 30)
  return jsonBody(c, { provider: providerName, until: new Date(until).toISOString() })
})

admin.get('/gate', async (c) => jsonBody(c, { gate: await readGate(c.env) }))

admin.post('/prune', async (c) => {
  const limit = Number.parseInt(c.req.query('limit') ?? '300', 10) || 300
  const deleted = await pruneExpired(c.env, Math.min(limit, 1000))
  const rows = await cacheRowCount(c.env)
  await putSettings(c.env, { 'cache.rows': String(rows) })
  return jsonBody(c, { deleted, rows })
})

admin.get('/cache/policies', (c) => jsonBody(c, { policies: TTL_POLICIES }))

const SECRET_LIKE = /(key|token|secret|password|client_secret)$/i

function maskSecrets(settings: Record<string, string>): Record<string, string> {
  const masked: Record<string, string> = {}
  for (const [key, value] of Object.entries(settings)) {
    const leaf = key.split('.').pop() ?? key
    masked[key] = SECRET_LIKE.test(leaf) ? (value.length > 0 ? '***set***' : '') : value
  }
  return masked
}

async function readJson(c: Context<AppEnv>): Promise<Record<string, unknown>> {
  try {
    const body: unknown = await c.req.json()
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      throw fail(ErrorCode.InvalidArgument, 'body must be a JSON object', 400)
    }
    return body as Record<string, unknown>
  } catch (error) {
    if (error instanceof Error && error.name === 'ApiError') throw error
    throw fail(ErrorCode.InvalidArgument, 'invalid JSON body', 400)
  }
}

function constantTimeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  }
  return diff === 0
}

export default admin
