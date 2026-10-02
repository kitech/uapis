import { ErrorCode, fail } from '../core/errors'
import { FORMAT_PARAM } from '../core/uapis'
import type { ParamDef, ProviderDef } from '../core/registry'
import type { UpstreamPlan, ProviderRuntime } from './runtime'

/**
 * Discourse 论坛：不是接一个站，而是接一整类软件的分发面。Discourse 自带 JSON API
 * 与内建 RSS，`hot` / `top` 就是字面意义上的热榜（`top` 带 period 窗口），
 * 话题对象自带 `views` / `like_count` / `posts_count`，正好对上 hotboard 结构。
 *
 * 每台论坛的条款与内容版权各自独立，所以**只放实测通过的站点**，每加一个都要重新
 * 过一遍该站的条款——枚举就是白名单，不做通配。
 *
 * 两个实测出来的坑：
 *
 * 1. **体积由 `per_page` 决定，且默认 50 太大。** 同一台站 `per_page` 10/30/50
 *    分别约 28KB / 80KB / 103KB，而多出来的大头是 `topic_list` 旁边那个跟热榜
 *    无关的 `users` 数组。默认给 10、上限 30。
 * 2. **分类路径的 slug 必须准确**，猜错不会 404 而是 301 到别处
 *    （`/c/meta/17/...` 被纠正成 `/c/uncategorized/17/...`）。所以首版不接分类端点，
 *    等拿到各站真实 slug 再说。
 *
 * 论坛之间可换、可关端点、可自己加 WAF，所以按 fourchan 的先例逐站探测后再写进这里。
 */
const FORUMS = [
  'meta.discourse.org',
  'discuss.python.org',
  'discourse.nixos.org',
  'forums.swift.org',
  'community.crowdin.com',
] as const

/**
 * `forum` 路径参数直接取论坛主机名，而不是给主机名编一套短 key。
 * 这么设计是有原因的：提取器要靠 `target.id` 拼话题的绝对地址
 * （Discourse 的话题对象只给 `slug` 与数字 `id`，不给完整 URL），
 * 而把 key→host 的映射表放进 core 的话，它与 `FORMAT_PARAM` 会构成
 * `core/uapis` ↔ `providers/discourse` 的循环导入——`params` 里在模块顶层就引用了
 * `FORMAT_PARAM`，循环下会撞 TDZ。直接用主机名就没有这张映射表，
 * `hosts` 与 `enum` 也共用同一个常量，不存在两处不同步。
 */
export type Forum = (typeof FORUMS)[number]

export const params: Record<string, ParamDef[]> = {
  hot: [
    {
      name: 'forum',
      in: 'path',
      type: 'string',
      required: true,
      description: '论坛主机名，如 discuss.python.org（只列实测通过的站点）',
      enum: [...FORUMS],
      maxLength: 60,
    },
    {
      name: 'per_page',
      in: 'query',
      type: 'integer',
      required: false,
      description: '每页条数，1-30。上游默认 50 且响应里含大量无关的 users 数组，这里压小',
      default: '10',
      minimum: 1,
      maximum: 30,
    },
    FORMAT_PARAM,
  ],
  top: [
    {
      name: 'forum',
      in: 'path',
      type: 'string',
      required: true,
      description: '论坛主机名，如 discuss.python.org（只列实测通过的站点）',
      enum: [...FORUMS],
      maxLength: 60,
    },
    {
      name: 'period',
      in: 'query',
      type: 'string',
      required: false,
      description: '统计窗口',
      default: 'weekly',
      enum: ['daily', 'weekly', 'monthly', 'yearly', 'all'],
    },
    {
      name: 'per_page',
      in: 'query',
      type: 'integer',
      required: false,
      description: '每页条数，1-30。上游默认 50 且响应里含大量无关的 users 数组，这里压小',
      default: '10',
      minimum: 1,
      maximum: 30,
    },
    FORMAT_PARAM,
  ],
  latest: [
    {
      name: 'forum',
      in: 'path',
      type: 'string',
      required: true,
      description: '论坛主机名，如 discuss.python.org（只列实测通过的站点）',
      enum: [...FORUMS],
      maxLength: 60,
    },
    {
      name: 'order',
      in: 'query',
      type: 'string',
      required: false,
      description: 'activity=最近活动 / created=最新发布',
      default: 'activity',
      enum: ['activity', 'created'],
    },
    {
      name: 'per_page',
      in: 'query',
      type: 'integer',
      required: false,
      description: '每页条数，1-30。上游默认 50 且响应里含大量无关的 users 数组，这里压小',
      default: '10',
      minimum: 1,
      maximum: 30,
    },
    FORMAT_PARAM,
  ],
}

const FORUM_PARAM: ParamDef = params.hot?.[0] as ParamDef

export const def: ProviderDef = {
  name: 'discourse',
  displayName: 'Discourse 论坛',
  tier: 'A-',
  hosts: [...FORUMS],
  minIntervalMs: 1000,
  uaNote: 'Discourse 自带的公开 JSON 端点，各站零 key',
  parseCostMs: 0,
  attribution: '论坛内容是 UGC，版权归各话题作者；本项目只取标题、计数与落地链接',
  tos: '各站条款各自独立，见 /status 的 hosts 列表',
  limits: '各站自定，未公布统一限流；本项目 1 秒最小间隔自我约束',
  endpoints: [
    {
      op: 'hot',
      resource: 'feed',
      method: 'GET',
      path: '/api/v1/discourse/{forum}/hot',
      summary: '热门话题（上游 /hot.json）',
      params: params.hot ?? [],
      passthrough: true,
      inline: true,
      costMs: 0,
    },
    {
      op: 'top',
      resource: 'feed',
      method: 'GET',
      path: '/api/v1/discourse/{forum}/top',
      summary: '周期热榜（上游 /top.json，period 可选 daily/weekly/monthly/yearly/all）',
      params: params.top ?? [],
      passthrough: true,
      inline: true,
      costMs: 0,
    },
    {
      op: 'latest',
      resource: 'feed',
      method: 'GET',
      path: '/api/v1/discourse/{forum}/latest',
      summary: '最新话题（上游 /latest.json，order 可选 activity/created）',
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
    const forum = requireForum(target.id)
    const perPage = read(target.query, 'per_page') ?? '10'
    switch (target.op) {
      case 'hot':
        return { url: `https://${forum}/hot.json?per_page=${perPage}`, resource: 'feed' }
      case 'top': {
        const period = read(target.query, 'period') ?? 'weekly'
        return { url: `https://${forum}/top.json?period=${period}&per_page=${perPage}`, resource: 'feed' }
      }
      case 'latest': {
        const order = read(target.query, 'order') ?? 'activity'
        return { url: `https://${forum}/latest.json?order=${order}&per_page=${perPage}`, resource: 'feed' }
      }
      default:
        throw fail(ErrorCode.NotFound, `unknown discourse op: ${target.op}`, 404)
    }
  },
}

function requireForum(id: string): Forum {
  if (!(FORUMS as readonly string[]).includes(id)) {
    // 枚举之外一律 400：Discourse 是可自建软件，不能让调用方拿本服务去打任意主机
    throw fail(ErrorCode.InvalidParameter, `unknown forum: ${id}`, 400, {
      field: FORUM_PARAM.name,
      value: id,
      allowed: [...FORUMS],
    })
  }
  return id as Forum
}

function read(query: Array<[string, string]>, name: string): string | undefined {
  return query.find(([key]) => key === name)?.[1]
}