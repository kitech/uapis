import { ErrorCode, fail } from '../core/errors'
import { FORMAT_PARAM } from '../core/uapis'
import type { ParamDef, ProviderDef } from '../core/registry'
import type { UpstreamPlan, ProviderRuntime } from './runtime'

/**
 * bioRxiv / medRxiv：生物与医学预印本服务器，官方文档化的 REST API（`api.biorxiv.org`），
 * 无需 key、无订阅分级。预印本正文与元数据以 CC BY 4.0 授权，转载无授权障碍。
 *
 * 官方说明：https://www.biorxiv.org/content/about-brorxiv
 * API 形态：https://api.biorxiv.org/ 与 /details/help、/pubs/help
 *
 * 两个踩过的坑，写在这里免得后人再踩一遍：
 *
 * 1. **interval 只吃 `yyyy-mm-dd/yyyy-mm-dd`。** 文档里写了「近 N 篇」(`10`) 与
 *    「近 N 天」(`7d`) 两种写法，实测线上部署会把它们当日期区间解析并回
 *    `Both dates must be in yyyy-mm-dd format`，`collection` 给空数组。所以 `recent`
 *    这个端点是自己算出 `[today-days, today]` 区间再发过去的。
 * 2. **报错不是 HTTP 错误码。** 非法 interval 回的是 **200** +
 *    `{"messages":[{"status":"..."}],"collection":[]}`。当成"今天没有新预印本"就会把
 *    上游报错静默落库成空榜——提取器里必须先判 `messages`。
 */
const API = 'https://api.biorxiv.org'
const SERVERS = ['biorxiv', 'medrxiv'] as const
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/
const DAYS_PATTERN = /^\d{1,2}$/
/** DOI 形如 `10.1101/2020.09.09.20191205`，可能带 v1 之类版本后缀 */
const DOI_PATTERN = /^10\.1101\/\d{4}\.\d{2}\.\d{2}\.\w+$/
/** multiSegment 参数要自己拦路径穿越：路由层对 `:name{.+}` 只校验非空 */
const TRAVERSAL = /\.\./
/** 一个月的天数上限再多也没意义，且 `details` 单页固定 30 条 */
const MAX_DAYS = 30

/**
 * `server` 三个端点共用同一个声明。注意路由层对 path 参数只检查非空、不校验
 * enum，真正的白名单在 `buildPlan` 的 `requireServer` 里。
 */
const SERVER_PARAM: ParamDef = {
  name: 'server',
  in: 'path',
  type: 'string',
  required: true,
  description: '预印本服务器：biorxiv / medrxiv',
  enum: [...SERVERS],
  maxLength: 10,
}

export const params: Record<string, ParamDef[]> = {
  recent: [
    SERVER_PARAM,
    {
      name: 'days',
      in: 'query',
      type: 'integer',
      required: false,
      description: '回看天数，1-30（由本服务换算成 [今天-N, 今天] 日期区间再请求上游）',
      default: '7',
      minimum: 1,
      maximum: MAX_DAYS,
    },
    FORMAT_PARAM,
  ],
  range: [
    SERVER_PARAM,
    { name: 'from', in: 'query', type: 'string', required: true, description: '起始日期 yyyy-mm-dd', maxLength: 10 },
    { name: 'to', in: 'query', type: 'string', required: true, description: '结束日期 yyyy-mm-dd', maxLength: 10 },
    FORMAT_PARAM,
  ],
  detail: [
    SERVER_PARAM,
    {
      name: 'doi',
      in: 'path',
      type: 'string',
      required: true,
      description: 'DOI，如 10.1101/2020.09.09.20191205（含 `/`，故多段匹配）',
      maxLength: 64,
      multiSegment: true,
    },
  ],
}

export const def: ProviderDef = {
  name: 'biorxiv',
  displayName: 'bioRxiv / medRxiv',
  tier: 'A-',
  hosts: ['api.biorxiv.org'],
  // 上游没公布硬性限流；1 秒一条已经远低于任何合理阈值，纯自我约束
  minIntervalMs: 1000,
  uaNote: '官方公开 REST API，无需注册、无需 key',
  parseCostMs: 0,
  attribution: '预印本正文与元数据以 CC BY 4.0 授权，作者保留著作权',
  tos: 'https://www.biorxiv.org/content/about-brorxiv',
  limits: '官方未公布硬性限流；details 端点单页固定 30 条；本项目 1 秒最小间隔自我约束',
  endpoints: [
    {
      op: 'recent',
      resource: 'feed',
      method: 'GET',
      path: '/api/v1/biorxiv/{server}/recent',
      summary: '最近 N 天的预印本（上游按 [today-N, today] 日期区间取，单页 30 条）',
      params: params.recent ?? [],
      passthrough: true,
      inline: true,
      costMs: 0,
    },
    {
      op: 'range',
      resource: 'feed',
      method: 'GET',
      path: '/api/v1/biorxiv/{server}/range',
      summary: '指定日期区间的预印本（上游 details，from/to 走 query，单页 30 条）',
      params: params.range ?? [],
      passthrough: true,
      inline: true,
      costMs: 0,
    },
    {
      op: 'detail',
      resource: 'item',
      method: 'GET',
      path: '/api/v1/biorxiv/detail/{server}/{doi}',
      summary: '单篇预印本元数据',
      params: params.detail ?? [],
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
      case 'recent': {
        requireServer(target.id)
        const days = read(target.query, 'days') ?? '7'
        if (!DAYS_PATTERN.test(days)) {
          throw fail(ErrorCode.InvalidParameter, `invalid days: ${days}`, 400, { field: 'days', value: days })
        }
        const to = new Date()
        const from = new Date(to.getTime() - Number.parseInt(days, 10) * 86_400_000)
        return {
          url: `${API}/details/${target.id}/${ymd(from)}/${ymd(to)}/0/json`,
          resource: 'feed',
        }
      }
      case 'range': {
        requireServer(target.id)
        const from = read(target.query, 'from')
        const to = read(target.query, 'to')
        requireDate(from, 'from')
        requireDate(to, 'to')
        if (from > to) {
          throw fail(ErrorCode.InvalidParameter, `from must not be after to: ${from} > ${to}`, 400, {
            field: 'from',
            value: from,
          })
        }
        return { url: `${API}/details/${target.id}/${from}/${to}/0/json`, resource: 'feed' }
      }
      case 'detail': {
        // DOI 自身含 `/`（`10.1101/2020.09.09.20191205`），只有首段是 server，
        // 其余段重新拼回去才是完整 DOI
        const [server, ...rest] = target.id.split('/')
        const doi = rest.join('/')
        requireServer(server)
        if (doi.length === 0 || !DOI_PATTERN.test(doi) || TRAVERSAL.test(doi)) {
          throw fail(ErrorCode.InvalidParameter, `invalid doi: ${doi}`, 400, { field: 'doi', value: doi })
        }
        return { url: `${API}/details/${server}/${doi}/na/json`, resource: 'item' }
      }
      default:
        throw fail(ErrorCode.NotFound, `unknown biorxiv op: ${target.op}`, 404)
    }
  },
}

function requireServer(server: string | undefined): asserts server is string {
  if (server === undefined || !(SERVERS as readonly string[]).includes(server)) {
    throw fail(ErrorCode.InvalidParameter, `invalid server: ${String(server)}`, 400, {
      field: 'server',
      value: String(server),
      allowed: [...SERVERS],
    })
  }
}

function requireDate(value: string | undefined, field: string): asserts value is string {
  if (value === undefined || !DATE_PATTERN.test(value)) {
    throw fail(ErrorCode.InvalidParameter, `invalid ${field}: ${String(value)}`, 400, {
      field,
      value: String(value),
      expected: 'yyyy-mm-dd',
    })
  }
}

function ymd(date: Date): string {
  return date.toISOString().slice(0, 10)
}

function read(query: Array<[string, string]>, name: string): string | undefined {
  return query.find(([key]) => key === name)?.[1]
}
