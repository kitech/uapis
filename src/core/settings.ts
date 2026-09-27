/**
 * D1 `settings` 读取层。
 * 隔离实例内做 30s 记忆化，避免每个请求都为配置付出一次 D1 行读。
 * 未写入的值回落到代码默认值，部署不依赖 seed。
 */
export const SETTINGS_DEFAULTS: Readonly<Record<string, string>> = Object.freeze({
  'maintenance.mode': 'active',
  'cache.t1': 'on',
  'cache.inline': 'on',
  'cache.soft_rows': '80000',
  'cache.rows': '0',
  'cache.negative_ttl': '21600',
  'cache.max_key_bytes': '400',
  'ratelimit.rpm': '60',
  'gate.min_ms': '',
  'cors.origins': '*',
  'upstream.allowlist':
    'api.stackexchange.com,hn.algolia.com,api.github.com,dev.to,export.arxiv.org,api.zenrows.com,r.jina.ai,lobste.rs,itunes.apple.com,api.crossref.org,pypi.org,registry.npmjs.org,eutils.ncbi.nlm.nih.gov,earthquake.usgs.gov,gitlab.com,crates.io',
  'queue.daily_limit': '3000',
  'queue.soft_limit': '2700',
  'warm.list': '',
  'proxy.mode': 'off',
  'proxy.zenrows_url':
    'https://api.zenrows.com/v1/key?apikey={key}&url={url}&mode={mode}&javascript=allowed&wait=20000',
  'proxy.jina_url': 'https://r.jina.ai/?url={url}',
  // 付费通道的每日上限：走 credits.ts 的 quota.<provider>.<channel> 维度，
  // 之前只有 proxy.* 这两个键而没人读，等于付费通道完全没有上限
  'quota.proxy.zenrows': '33',
  'quota.proxy.jina': '50',
  'quota.stackexchange.default': '9500',
  'quota.hackernews.default': '10000',
  'quota.github.default': '4500',
  'quota.devto.default': '9000',
  'quota.arxiv.default': '4000',
  'quota.lobsters.default': '6000',
  'quota.itunes.default': '9000',
  'quota.crossref.default': '5000',
  'quota.pypi.default': '6000',
  'quota.npm.default': '8000',
  'quota.pubmed.default': '10000',
  'quota.usgs.default': '4000',
  'quota.gitlab.default': '5000',
  'quota.crates.default': '3000',
})

const MEMO_TTL_MS = 30_000
const MEMO_MAX = 200
const memo = new Map<string, { value: string; at: number }>()

export async function getSetting(env: Env, key: string): Promise<string> {
  const cached = memo.get(key)
  const now = Date.now()
  if (cached !== undefined && now - cached.at < MEMO_TTL_MS) return cached.value

  const fallback = SETTINGS_DEFAULTS[key] ?? ''
  let value = fallback
  try {
    const row = await env.DB.prepare('SELECT v FROM settings WHERE k = ?').bind(key).first<{
      v: string
    }>()
    if (row !== null && typeof row.v === 'string') value = row.v
  } catch {
    value = fallback
  }

  if (memo.size >= MEMO_MAX) memo.clear()
  memo.set(key, { value, at: now })
  return value
}

export async function getIntSetting(env: Env, key: string): Promise<number> {
  const raw = await getSetting(env, key)
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) ? parsed : 0
}

export async function getBoolSetting(env: Env, key: string): Promise<boolean> {
  const raw = (await getSetting(env, key)).toLowerCase()
  return raw === 'on' || raw === 'true' || raw === '1' || raw === 'yes'
}

export async function getCsvSetting(env: Env, key: string): Promise<string[]> {
  const raw = await getSetting(env, key)
  return raw
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter((item) => item.length > 0)
}

export async function allSettings(env: Env): Promise<Record<string, string>> {
  const merged: Record<string, string> = { ...SETTINGS_DEFAULTS }
  try {
    const result = await env.DB.prepare('SELECT k, v FROM settings').all<{ k: string; v: string }>()
    for (const row of result.results ?? []) {
      if (typeof row.k === 'string' && typeof row.v === 'string') merged[row.k] = row.v
    }
  } catch {
    // 保留默认值
  }
  return merged
}

/** 管理端写入；不缓存刚写入的值 */
export async function putSettings(env: Env, entries: Record<string, string>): Promise<number> {
  const keys = Object.keys(entries)
  if (keys.length === 0) return 0
  const now = Date.now()
  const statements = keys.map((key) =>
    env.DB.prepare(
      'INSERT INTO settings (k, v, updated_at) VALUES (?, ?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v, updated_at = excluded.updated_at',
    ).bind(key, entries[key] ?? '', now),
  )
  await env.DB.batch(statements)
  for (const key of keys) memo.delete(key)
  return keys.length
}

export function clearSettingsMemo(): void {
  memo.clear()
}
