import { ErrorCode, fail } from '../core/errors'
import { FORMAT_PARAM } from '../core/uapis'
import type { ParamDef, ProviderDef } from '../core/registry'
import type { UpstreamPlan, ProviderRuntime } from './runtime'

/**
 * lobste.rs：Hacker News 的同类站，官方自己提供 JSON 接口，零 key。
 * 官方文档：https://lobste.rs/api （注意路径是 hottest/newest/active，
 * 不是 hot/new/recent——那几个 404，踩过）
 */
const API = 'https://lobste.rs'
const TAG_PATTERN = /^[a-z0-9][a-z0-9-]{0,30}$/
const SHORT_ID_PATTERN = /^[0-9a-z]{4,10}$/

export const params: Record<string, ParamDef[]> = {
  hot: [FORMAT_PARAM],
  newest: [FORMAT_PARAM],
  tag: [
    { name: 'tag', in: 'path', type: 'string', required: true, description: '标签，如 programming / rust' },
    FORMAT_PARAM,
  ],
  story: [
    { name: 'id', in: 'path', type: 'string', required: true, description: '故事的 short_id（站点用的短 base36 id）' },
  ],
}

export const def: ProviderDef = {
  name: 'lobsters',
  displayName: 'Lobsters',
  tier: 'A',
  hosts: ['lobste.rs'],
  // 小站，没有公布限流；1 秒一条已经远低于任何合理阈值，纯自我约束
  minIntervalMs: 1000,
  uaNote: '官方公开 JSON 接口，零 key',
  parseCostMs: 0,
  attribution: '故事版权归各提交者，Lobsters 依 CC BY-SA 3.0',
  tos: 'https://lobste.rs/about',
  limits: '官方未公布硬性限流；本项目 1 秒最小间隔自我约束',
  endpoints: [
    {
      op: 'hot',
      resource: 'feed',
      method: 'GET',
      path: '/api/v1/lobsters/hot',
      summary: '热门故事（上游 /hottest.json，固定 25 条）',
      params: params.hot ?? [],
      passthrough: true,
      inline: true,
      costMs: 0,
    },
    {
      op: 'newest',
      resource: 'feed',
      method: 'GET',
      path: '/api/v1/lobsters/newest',
      summary: '最新故事（上游 /newest.json，固定 25 条）',
      params: params.newest ?? [],
      passthrough: true,
      inline: true,
      costMs: 0,
    },
    {
      op: 'tag',
      resource: 'feed',
      method: 'GET',
      path: '/api/v1/lobsters/tag/{tag}',
      summary: '按标签取故事（上游 /t/{tag}.json，固定 25 条）',
      params: params.tag ?? [],
      passthrough: true,
      inline: true,
      costMs: 0,
    },
    {
      op: 'story',
      resource: 'item',
      method: 'GET',
      path: '/api/v1/lobsters/story/{id}',
      summary: '单个故事（含评论）',
      params: params.story ?? [],
      passthrough: true,
      inline: true,
      costMs: 0,
    },
  ],
}

export const runtime: ProviderRuntime = {
  name: def.name,
  async buildPlan(env, target): Promise<UpstreamPlan> {
    switch (target.op) {
      case 'hot':
        return { url: `${API}/hottest.json`, resource: 'feed' }
      case 'newest':
        return { url: `${API}/newest.json`, resource: 'feed' }
      case 'tag': {
        const tag = requirePattern(target.id, TAG_PATTERN, 'tag')
        return { url: `${API}/t/${tag}.json`, resource: 'feed' }
      }
      case 'story': {
        const id = requirePattern(target.id, SHORT_ID_PATTERN, 'id')
        return { url: `${API}/s/${id}.json`, resource: 'item' }
      }
      default:
        throw fail(ErrorCode.NotFound, `unknown lobsters op: ${target.op}`, 404)
    }
  },
}

function requirePattern(value: string, pattern: RegExp, field: string): string {
  if (!pattern.test(value)) {
    throw fail(ErrorCode.InvalidParameter, `invalid ${field}: ${value}`, 400, { field, value })
  }
  return value
}
