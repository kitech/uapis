import { env as cloudflareEnv } from 'cloudflare:workers'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  cacheRowCount,
  decodeText,
  encodeText,
  gzip,
  gunzip,
  lookup,
  pruneExpired,
  remove,
  resetRowCountCache,
  store,
  t1Delete,
  t1Put,
} from '../src/core/cache'
import { clearSettingsMemo, putSettings } from '../src/core/settings'

const env = cloudflareEnv as unknown as Env

type CacheInput = Parameters<typeof store>[1]

function record(overrides: Partial<CacheInput> = {}): CacheInput {
  const now = Date.now()
  return {
    key: 'v1:hackernews:item:1:q',
    body: encodeText('{"id":1}'),
    encoding: 'identity',
    status: 200,
    contentType: 'application/json; charset=utf-8',
    provider: 'hackernews',
    resource: 'item',
    fetchedAt: now,
    expiresAt: now + 60_000,
    staleUntil: now + 600_000,
    size: 8,
    ...overrides,
  }
}

beforeEach(async () => {
  resetRowCountCache()
  await env.DB.prepare('DELETE FROM cache').run()
  await env.DB.prepare('DELETE FROM settings').run()
  clearSettingsMemo()
  for (let i = 0; i < 100; i++) await t1Delete(`v1:hackernews:item:${i}:q`)
})

describe('文本编解码', () => {
  it('encode/decode 是无损往返', () => {
    const text = '{"title":"中文 with emoji 🎯"}'
    expect(decodeText(encodeText(text))).toBe(text)
  })

  it('gzip 能压缩并且能还原', async () => {
    const raw = encodeText('a'.repeat(4096))
    const packed = await gzip(raw)
    expect(packed.byteLength).toBeLessThan(raw.byteLength)
    expect(decodeText(await gunzip(packed))).toBe('a'.repeat(4096))
  })
})

describe('T2（D1）缓存', () => {
  beforeEach(async () => {
    await putSettings(env, { 'cache.t1': 'off' })
    clearSettingsMemo()
  })

  it('写入后能命中，body 原样返回', async () => {
    expect(await store(env, record())).toBe(true)
    const found = await lookup(env, 'v1:hackernews:item:1:q')
    expect(found?.state).toBe('HIT')
    expect(found?.layer).toBe('T2')
    expect(found?.text).toBe('{"id":1}')
  })

  it('超过 1KB 的 body 走 gzip 列', async () => {
    const big = 'x'.repeat(2048)
    expect(await store(env, record({ body: encodeText(big), size: big.length }))).toBe(true)
    const row = await env.DB
      .prepare('SELECT encoding, size FROM cache WHERE k = ?')
      .bind('v1:hackernews:item:1:q')
      .first<{ encoding: string; size: number }>()
    expect(row?.encoding).toBe('gzip')
    const found = await lookup(env, 'v1:hackernews:item:1:q')
    expect(found?.text).toBe(big)
  })

  it('过期但仍在 stale 窗口内返回 STALE', async () => {
    const now = Date.now()
    await store(env, record({ expiresAt: now - 1_000, staleUntil: now + 60_000 }))
    const found = await lookup(env, 'v1:hackernews:item:1:q')
    expect(found?.state).toBe('STALE')
  })

  it('超出 stale 窗口返回 MISS，但保留旧值供回源失败兜底', async () => {
    const now = Date.now()
    await store(env, record({ expiresAt: now - 120_000, staleUntil: now - 60_000 }))
    const found = await lookup(env, 'v1:hackernews:item:1:q')
    expect(found?.state).toBe('MISS')
    expect(found?.text).toBe('{"id":1}')
    expect(await cacheRowCount(env)).toBe(1)
  })

  it('remove 同时删 T1 与 T2', async () => {
    await putSettings(env, { 'cache.t1': 'on' })
    clearSettingsMemo()
    await store(env, record())
    await remove(env, 'v1:hackernews:item:1:q')
    expect(await cacheRowCount(env)).toBe(0)
    expect(await lookup(env, 'v1:hackernews:item:1:q')).toBeNull()
  })

  it('软上限触发后拒绝写入新 key，但允许更新已有 key', async () => {
    resetRowCountCache()
    await putSettings(env, { 'cache.rows': '2', 'cache.soft_rows': '2' })
    clearSettingsMemo()

    expect(await store(env, record({ key: 'v1:hackernews:item:1:q' }))).toBe(true)
    expect(await store(env, record({ key: 'v1:hackernews:item:2:q' }))).toBe(true)
    expect(await store(env, record({ key: 'v1:hackernews:item:3:q' }))).toBe(false)
    // 覆盖已有 key 不受软上限影响
    expect(await store(env, record({ key: 'v1:hackernews:item:2:q', body: encodeText('{}') }))).toBe(
      true,
    )
    expect(await cacheRowCount(env)).toBe(2)
  })

  it('pruneExpired 只删过期行并受 limit 约束', async () => {
    const now = Date.now()
    for (let i = 0; i < 3; i++) {
      await store(
        env,
        record({
          key: `v1:hackernews:item:${i}:q`,
          expiresAt: now - 1_000,
          staleUntil: now - 1_000,
        }),
      )
    }
    await store(env, record({ key: 'v1:hackernews:item:99:q' }))

    expect(await pruneExpired(env, 2)).toBe(2)
    expect(await pruneExpired(env, 100)).toBe(1)
    expect(await cacheRowCount(env)).toBe(1)
  })
})

describe('T1（Cache API）缓存', () => {
  it('T1 命中优先于 T2', async () => {
    await putSettings(env, { 'cache.t1': 'on' })
    clearSettingsMemo()
    await store(env, record())
    await t1Put(
      env,
      'v1:hackernews:item:1:q',
      encodeText('from-t1'),
      'application/json',
      Date.now() + 60_000,
    )
    const found = await lookup(env, 'v1:hackernews:item:1:q')
    expect(found?.layer).toBe('T1')
    expect(found?.text).toBe('from-t1')
  })

  it('关闭 T1 后只走 T2', async () => {
    await putSettings(env, { 'cache.t1': 'on' })
    clearSettingsMemo()
    await t1Put(
      env,
      'v1:hackernews:item:1:q',
      encodeText('from-t1'),
      'application/json',
      Date.now() + 60_000,
    )
    await putSettings(env, { 'cache.t1': 'off' })
    clearSettingsMemo()
    await store(env, record())

    const found = await lookup(env, 'v1:hackernews:item:1:q')
    expect(found?.layer).toBe('T2')
    expect(found?.text).toBe('{"id":1}')
  })

  it('T1 命中不写 D1，避免吃掉每日写额度', async () => {
    await putSettings(env, { 'cache.t1': 'on' })
    clearSettingsMemo()
    await t1Put(
      env,
      'v1:hackernews:item:1:q',
      encodeText('from-t1'),
      'application/json',
      Date.now() + 60_000,
    )
    const found = await lookup(env, 'v1:hackernews:item:1:q')
    expect(found?.layer).toBe('T1')
    expect(await cacheRowCount(env)).toBe(0)
  })
})
