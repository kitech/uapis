import { JSON_CT } from './envelope'
import { getBoolSetting, getIntSetting } from './settings'
import { COMPRESS_THRESHOLD_BYTES, T1_MIN_TTL_SECONDS } from './ttl'

/**
 * T2 缓存（D1）为主，T1（Cache API）为可选快路径。
 * Cache API 只在自定义域名下可靠，workers.dev 预览域名会自动降级。
 */
const T1_ORIGIN = 'https://t1.cache.internal'

export interface CacheRecord {
  key: string
  body: Uint8Array
  encoding: 'gzip' | 'identity'
  status: number
  contentType: string
  provider: string
  resource: string
  fetchedAt: number
  expiresAt: number
  staleUntil: number
  size: number
}

export type CacheState = 'HIT' | 'STALE' | 'MISS'
export type CacheLayer = 'T1' | 'T2'

export interface CacheLookup {
  state: CacheState
  layer: CacheLayer
  record: CacheRecord
  text: string
}

export async function isT1Enabled(env: Env): Promise<boolean> {
  return getBoolSetting(env, 'cache.t1')
}

export function t1RequestUrl(key: string): string {
  return `${T1_ORIGIN}/${key}`
}

function cacheApiAvailable(): boolean {
  return typeof caches !== 'undefined' && caches !== null
}

export async function t1Get(
  env: Env,
  key: string,
): Promise<{ body: Uint8Array; contentType: string; expiresAt: number; fetchedAt: number } | null> {
  if (!(await isT1Enabled(env)) || !cacheApiAvailable()) return null
  try {
    const hit = await caches.default.match(new Request(t1RequestUrl(key)))
    if (hit === undefined || hit === null) return null
    const expiresAt = Number.parseInt(hit.headers.get('x-uapis-exp') ?? '0', 10)
    if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) return null
    const buffer = await hit.arrayBuffer()
    return {
      body: new Uint8Array(buffer),
      contentType: hit.headers.get('content-type') ?? JSON_CT,
      expiresAt,
      fetchedAt: readFetchedAt(hit.headers, expiresAt),
    }
  } catch {
    return null
  }
}

/**
 * Cache API 不返回写入时间，只能自己存。
 *
 * `x-uapis-fat` 是新写入的抓取时刻；`cache-control: max-age` 则是写入时算出来的 TTL，
 * 而 `x-uapis-exp = 抓取时刻 + TTL`，所以**老条目（部署前写入、没有 fat 头的）**
 * 还能从这两者反推出来，误差在一个 TTL 取整之内。
 *
 * 反推不出来就返回 0：宁可让 `X-Cache-Age` 少报，也不要报一个假的年龄。
 */
function readFetchedAt(headers: Headers, expiresAt: number): number {
  const explicit = Number.parseInt(headers.get('x-uapis-fat') ?? '', 10)
  if (Number.isFinite(explicit) && explicit > 0) return explicit
  const maxAge = Number.parseInt(/max-age=(\d+)/.exec(headers.get('cache-control') ?? '')?.[1] ?? '', 10)
  if (Number.isFinite(maxAge) && maxAge > 0) return Math.max(0, expiresAt - maxAge * 1000)
  return 0
}

export async function t1Put(
  env: Env,
  key: string,
  body: Uint8Array,
  contentType: string,
  expiresAt: number,
  fetchedAt: number = Date.now(),
): Promise<void> {
  if (!(await isT1Enabled(env)) || !cacheApiAvailable()) return
  const ttl = Math.max(T1_MIN_TTL_SECONDS, Math.ceil((expiresAt - Date.now()) / 1000))
  try {
    const stored = new Response(body, {
      status: 200,
      headers: {
        'content-type': contentType,
        'cache-control': `public, max-age=${ttl}`,
        'x-uapis-exp': String(expiresAt),
        'x-uapis-fat': String(fetchedAt),
      },
    })
    await caches.default.put(new Request(t1RequestUrl(key)), stored)
  } catch {
    // 缓存写入失败不影响主流程
  }
}

export async function t1Delete(key: string): Promise<void> {
  if (!cacheApiAvailable()) return
  try {
    await caches.default.delete(new Request(t1RequestUrl(key)))
  } catch {
    // ignore
  }
}

/** T1 → T2 顺序查找；返回 null 表示完全没有记录 */
export async function lookup(env: Env, key: string): Promise<CacheLookup | null> {
  const fast = await t1Get(env, key)
  if (fast !== null) {
    const record: CacheRecord = {
      key,
      body: fast.body,
      encoding: 'identity',
      status: 200,
      contentType: fast.contentType,
      provider: key.split(':')[1] ?? '',
      resource: key.split(':')[2] ?? '',
      // T1 命中：抓取时刻从响应头读回来（老条目走 max-age 反推）
      fetchedAt: Math.min(fast.fetchedAt, Date.now()),
      expiresAt: fast.expiresAt,
      staleUntil: fast.expiresAt,
      size: fast.body.byteLength,
    }
    return { state: 'HIT', layer: 'T1', record, text: decodeText(fast.body) }
  }

  const row = await env.DB.prepare(
    'SELECT body, encoding, status, content_type, provider, resource, fetched_at, expires_at, stale_until, size FROM cache WHERE k = ?',
  )
    .bind(key)
    .first<{
      body: ArrayBuffer | Uint8Array | string
      encoding: 'gzip' | 'identity'
      status: number
      content_type: string | null
      provider: string
      resource: string
      fetched_at: number
      expires_at: number
      stale_until: number
      size: number
    }>()

  if (row === null || row === undefined) return null

  const raw = toBytes(row.body)
  const body = row.encoding === 'gzip' ? await gunzip(raw) : raw
  const now = Date.now()
  const state: CacheState = now < row.expires_at ? 'HIT' : now < row.stale_until ? 'STALE' : 'MISS'

  return {
    state,
    layer: 'T2',
    record: {
      key,
      body,
      encoding: 'identity',
      status: row.status,
      contentType: row.content_type ?? JSON_CT,
      provider: row.provider,
      resource: row.resource,
      fetchedAt: row.fetched_at,
      expiresAt: row.expires_at,
      staleUntil: row.stale_until,
      size: row.size,
    },
    text: decodeText(body),
  }
}

/**
 * 行数估算：COUNT(*) 在 D1 上是全表扫描，不能每次写都跑。
 * 隔离实例内缓存估算值，每 RECOUNT_EVERY 次写入或定时清理后重新对齐一次。
 */
let estimatedRows: number | null = null
let storesSinceRecount = 0
const RECOUNT_EVERY = 50

async function currentRowCount(env: Env): Promise<number> {
  if (estimatedRows === null || storesSinceRecount >= RECOUNT_EVERY) {
    estimatedRows = await cacheRowCount(env)
    storesSinceRecount = 0
  }
  storesSinceRecount += 1
  return estimatedRows
}

/** 定时清理后调用，下一次写入前重新 COUNT */
export function resetRowCountCache(): void {
  estimatedRows = null
  storesSinceRecount = 0
}

/** 写入 D1 并同步 T1；超过软上限时只允许覆盖已有行 */
export async function store(env: Env, record: CacheRecord): Promise<boolean> {
  const softRows = await getIntSetting(env, 'cache.soft_rows')
  if (softRows > 0 && (await currentRowCount(env)) >= softRows) {
    const exists = await env.DB.prepare('SELECT 1 AS ok FROM cache WHERE k = ?')
      .bind(record.key)
      .first<{ ok: number }>()
    if (exists === null || exists === undefined) return false
  }

  const shouldGzip = record.body.byteLength > COMPRESS_THRESHOLD_BYTES
  const raw = shouldGzip ? await gzip(record.body) : record.body
  const encoding: 'gzip' | 'identity' = shouldGzip ? 'gzip' : 'identity'

  await env.DB.prepare(
    `INSERT INTO cache (k, body, encoding, status, content_type, provider, resource, fetched_at, expires_at, stale_until, size)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(k) DO UPDATE SET
       body = excluded.body, encoding = excluded.encoding, status = excluded.status,
       content_type = excluded.content_type, provider = excluded.provider, resource = excluded.resource,
       fetched_at = excluded.fetched_at, expires_at = excluded.expires_at,
       stale_until = excluded.stale_until, size = excluded.size`,
  )
    .bind(
      record.key,
      toExactBuffer(raw),
      encoding,
      record.status,
      record.contentType,
      record.provider,
      record.resource,
      record.fetchedAt,
      record.expiresAt,
      record.staleUntil,
      record.size,
    )
    .run()

  estimatedRows = (estimatedRows ?? 0) + 1
  if (record.status === 200) {
    await t1Put(env, record.key, record.body, record.contentType, record.expiresAt, record.fetchedAt)
  }
  return true
}

export async function remove(env: Env, key: string): Promise<void> {
  await env.DB.prepare('DELETE FROM cache WHERE k = ?').bind(key).run()
  estimatedRows = estimatedRows === null ? null : Math.max(0, estimatedRows - 1)
  await t1Delete(key)
}

/** 定时清理过期行；每次最多 limit 行，保护 D1 写额度 */
export async function pruneExpired(env: Env, limit: number): Promise<number> {
  const now = Date.now()
  const expired = await env.DB.prepare(
    'SELECT k FROM cache WHERE expires_at < ? ORDER BY expires_at LIMIT ?',
  )
    .bind(now, limit)
    .all<{ k: string }>()

  const keys = (expired.results ?? []).map((row) => row.k)
  if (keys.length === 0) return 0
  resetRowCountCache()

  // T1 靠 cacheTtl 自动过期，这里只需删 D1 行
  const statements = keys.map((key) => env.DB.prepare('DELETE FROM cache WHERE k = ?').bind(key))
  await env.DB.batch(statements)
  return keys.length
}

export async function cacheRowCount(env: Env): Promise<number> {
  const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM cache').first<{ n: number }>()
  return row?.n ?? 0
}

export async function gzip(input: Uint8Array): Promise<Uint8Array> {
  return transform(input, new CompressionStream('gzip'))
}

export async function gunzip(input: Uint8Array): Promise<Uint8Array> {
  return transform(input, new DecompressionStream('gzip'))
}

async function transform(input: Uint8Array, stream: TransformStream<Uint8Array, Uint8Array>): Promise<Uint8Array> {
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(input)
      controller.close()
    },
  })
  return new Uint8Array(await new Response(source.pipeThrough(stream)).arrayBuffer())
}

export function decodeText(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes)
}

export function encodeText(text: string): Uint8Array {
  return new TextEncoder().encode(text)
}

function toBytes(value: ArrayBuffer | Uint8Array | string): Uint8Array {
  if (typeof value === 'string') return new TextEncoder().encode(value)
  if (value instanceof Uint8Array) return value
  return new Uint8Array(value)
}

/** D1 绑定 BLOB 需要长度精确的 ArrayBuffer，避免多余的 byteOffset 视图 */
function toExactBuffer(bytes: Uint8Array): ArrayBuffer {
  if (bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength) {
    return bytes.buffer as ArrayBuffer
  }
  return bytes.slice().buffer as ArrayBuffer
}
