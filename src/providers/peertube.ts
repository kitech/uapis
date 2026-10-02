import { ErrorCode, fail } from '../core/errors'
import { FORMAT_PARAM } from '../core/uapis'
import type { ParamDef, ProviderDef } from '../core/registry'
import type { UpstreamPlan, ProviderRuntime } from './runtime'

/**
 * PeerTube：联邦式的自托管视频平台，实例之间用 ActivityPub 互联，各实例独立运营、
 * 独立条款。官方 API 匿名可用，视频列表自带真实播放页地址与 `views` / `likes`。
 *
 * 两个实测出来的坑：
 *
 * 1. **热榜不在 `/api/v1/videos/trending`。** 那条路径不存在，请求会被
 *    `/api/v1/videos/{id}` 接住、把 `trending` 当成视频 id 解析，回
 *    `Should have a valid video id`。热榜是列表端点的排序参数：
 *    `GET /api/v1/videos?sort=-trending`。
 * 2. **没有全局 RSS。** `/api/v1/videos/rss` 同样被 `{id}` 吃掉。本项目的
 *    RSS/Atom 由 `?format=rss` 从同一份 JSON 序列化，不需要上游有 feed。
 *
 * 和 Discourse 一样，`instance` 路径参数直接取主机名：列表项自带绝对 URL，
 * 提取器不需要 host，而省掉 key→host 映射表也避开了与 `FORMAT_PARAM` 的循环导入。
 * 枚举只列实测通过的实例；联邦实例可以随时下线或改配置，加新实例前先探测。
 */
const INSTANCES = [
  'framatube.org',
  'peertube.tv',
  'video.blender.org',
  'peertube.opencloud.lu',
  'tube.tchncs.de',
  'tilvids.com',
] as const

export type Instance = (typeof INSTANCES)[number]

/** 每个 op 钉死一个上游排序：不给调用者自由传 sort，避免拼出上游不认的值 */
const OP_SORT: Record<string, string> = {
  trending: '-trending',
  views: '-views',
  likes: '-likes',
  latest: '-publishedAt',
}

function instanceParam(): ParamDef {
  return {
    name: 'instance',
    in: 'path',
    type: 'string',
    required: true,
    description: '实例主机名，如 framatube.org（只列实测通过的实例）',
    enum: [...INSTANCES],
    maxLength: 60,
  }
}

function countParam(): ParamDef {
  return {
    name: 'count',
    in: 'query',
    type: 'integer',
    required: false,
    description: '每页条数，1-20。上游单条约 4KB，20 条接近 90KB',
    default: '10',
    minimum: 1,
    maximum: 20,
  }
}

export const params: Record<string, ParamDef[]> = {
  trending: [instanceParam(), countParam(), FORMAT_PARAM],
  views: [instanceParam(), countParam(), FORMAT_PARAM],
  likes: [instanceParam(), countParam(), FORMAT_PARAM],
  latest: [instanceParam(), countParam(), FORMAT_PARAM],
}

export const def: ProviderDef = {
  name: 'peertube',
  displayName: 'PeerTube',
  tier: 'A-',
  hosts: [...INSTANCES],
  minIntervalMs: 1000,
  uaNote: '各 PeerTube 实例自带的公开 API，零 key',
  parseCostMs: 0,
  attribution: '视频版权归各作者，按各实例声明的许可发布',
  tos: '各实例条款各自独立，见 /status 的 hosts 列表',
  limits: '各实例自定，未公布统一限流；本项目 1 秒最小间隔自我约束',
  endpoints: [
    {
      op: 'trending',
      resource: 'feed',
      method: 'GET',
      path: '/api/v1/peertube/{instance}/trending',
      summary: '实例热门视频（上游 /api/v1/videos?sort=-trending）',
      params: params.trending ?? [],
      passthrough: true,
      inline: true,
      costMs: 0,
    },
    {
      op: 'views',
      resource: 'feed',
      method: 'GET',
      path: '/api/v1/peertube/{instance}/views',
      summary: '按播放量排序（上游 sort=-views）',
      params: params.views ?? [],
      passthrough: true,
      inline: true,
      costMs: 0,
    },
    {
      op: 'likes',
      resource: 'feed',
      method: 'GET',
      path: '/api/v1/peertube/{instance}/likes',
      summary: '按点赞数排序（上游 sort=-likes）',
      params: params.likes ?? [],
      passthrough: true,
      inline: true,
      costMs: 0,
    },
    {
      op: 'latest',
      resource: 'feed',
      method: 'GET',
      path: '/api/v1/peertube/{instance}/latest',
      summary: '最新视频（上游 sort=-publishedAt）',
      params: params.latest ?? [],
      passthrough: true,
      inline: true,
      costMs: 0,
    },
  ],
}

export const runtime: ProviderRuntime = {
  name: def.name,
  async buildPlan(env, target): Promise<UpstreamPlan> {
    if (!(INSTANCES as readonly string[]).includes(target.id)) {
      throw fail(ErrorCode.InvalidParameter, `unknown instance: ${target.id}`, 400, {
        field: 'instance',
        value: target.id,
        allowed: [...INSTANCES],
      })
    }
    const sort = OP_SORT[target.op]
    if (sort === undefined) {
      throw fail(ErrorCode.NotFound, `unknown peertube op: ${target.op}`, 404)
    }
    const count = target.query.find(([key]) => key === 'count')?.[1] ?? '10'
    return {
      url: `https://${target.id}/api/v1/videos?sort=${sort}&count=${count}&isLive=false`,
      resource: 'feed',
    }
  },
}