/** 资源类型 → 缓存策略 */
export type Resource =
  | 'search'
  | 'feed'
  | 'item'
  | 'profile'
  | 'passthrough'
  | 'archive'
  | 'wall'
  | 'error'

export interface TtlPolicy {
  ttlSeconds: number
  staleSeconds: number
}

export const TTL_POLICIES: Readonly<Record<Resource, TtlPolicy>> = Object.freeze({
  search: { ttlSeconds: 60, staleSeconds: 600 },
  feed: { ttlSeconds: 120, staleSeconds: 604_800 },
  item: { ttlSeconds: 600, staleSeconds: 2_592_000 },
  profile: { ttlSeconds: 300, staleSeconds: 604_800 },
  passthrough: { ttlSeconds: 300, staleSeconds: 86_400 },
  // 上游明确要求长缓存的源（arXiv 官方要求结果至少缓存 15 分钟）
  archive: { ttlSeconds: 900, staleSeconds: 86_400 },
  wall: { ttlSeconds: 86_400, staleSeconds: 604_800 },
  error: { ttlSeconds: 21_600, staleSeconds: 21_600 },
})

export function policyFor(resource: Resource): TtlPolicy {
  return TTL_POLICIES[resource] ?? TTL_POLICIES.passthrough
}

export const COMPRESS_THRESHOLD_BYTES = 1024
export const T1_MIN_TTL_SECONDS = 60
/**
 * v3：键里多了 op 这一段、且 id 保留大小写。
 * 之前只有 provider/resource/id/query，像 lobsters/hot 与 lobsters/newest 这种
 * 既无路径参数又无 query 的端点 id 都是空串（落到 `root`），于是共用一个缓存条目，
 * 请求 newest 会直接吐 hot 的内容。加 op 段彻底分开。
 *
 * 同时 sanitizeId 不再小写化：target.ts 明确说 id 保留大小写（有的站点 handle
 * 大小写敏感），但键里被 lower 了，`tag/Rust` 会命中 `tag/rust` 的缓存——两次整批作废。
 */
export const CACHE_KEY_VERSION = 'v3'

/** 归一化资源 id：去掉多余空白与路径穿越字符；大小写必须保留，否则大小写不同的 id 会撞键 */
export function sanitizeId(raw: string): string {
  return raw
    .trim()
    .replace(/[^A-Za-z0-9._:@-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 120)
}

/** FNV-1a 32bit：用于把白名单 query 折叠成稳定的短哈希 */
export function hashPairs(pairs: [string, string][]): string {
  if (pairs.length === 0) return 'q'
  const canonical = pairs
    .map(([k, v]) => `${k}=${v}`)
    .sort()
    .join('&')
  let hash = 0x811c9dc5
  for (let i = 0; i < canonical.length; i++) {
    hash ^= canonical.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

export function buildCacheKey(
  provider: string,
  resource: Resource,
  op: string,
  id: string,
  queryPairs: [string, string][] = [],
): string {
  const idPart = sanitizeId(id) || 'root'
  const q = hashPairs(queryPairs)
  return `${CACHE_KEY_VERSION}:${provider}:${resource}:${op}:${idPart}:${q}`
}

export function parseCacheKey(key: string): { provider: string; resource: string } | null {
  const parts = key.split(':')
  if (parts.length < 4 || parts[0] !== CACHE_KEY_VERSION) return null
  return { provider: parts[1] ?? '', resource: parts[2] ?? '' }
}
