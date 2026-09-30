import { ErrorCode, fail } from '../core/errors'
import { FORMAT_PARAM } from '../core/uapis'
import { queryValue } from '../core/target'
import type { ParamDef, ProviderDef } from '../core/registry'
import type { UpstreamPlan, ProviderRuntime } from './runtime'

/**
 * USGS 地震目录（FDSN event web service），零 key、公有领域。
 * <https://earthquake.usgs.gov/fdsnws/event/1/>
 *
 * 只走 `/query?format=geojson`，不碰 `feed/v1.0/summary/*.geojson`：
 * 那条路的固定 feed 体积跨度太大（all_hour 4.6KB、all_day 134KB、2.5_week 234KB、
 * all_month **7.5MB**），而且实测 `summary/all_min.geojson` 这种拼错的路径上游会
 * **回 200 + "404 File Not Found" 纯文本**。`/query` 反而更可控：limit=20 → 14KB，
 * limit=200 → 145KB，所以 limit 硬卡 200。
 *
 * USGS 生成的 GeoJSON 本来就小（单个 feature 约 700B），passthrough 即可。
 */
const FDSN = 'https://earthquake.usgs.gov/fdsnws/event/1/query'
/**
 * 事件 id：网络代码 + 序列号，如 ci41339847 / us7000d1v / ak7000abcd。
 * 下限 5 是形态下限不是真实性校验：形态合法但不存在的 id 会由上游回 404，
 * 那是诚实的答案，不该在我们这层猜成 400。
 */
const EVENT_ID_PATTERN = /^[a-z0-9]{5,20}$/
const ORDERS = ['time', 'magnitude'] as const

export const params: Record<string, ParamDef[]> = {
  search: [
    { name: 'minmagnitude', in: 'query', type: 'number', required: false, description: '最小震级，0-10（可含小数）', default: '2.5', minimum: 0, maximum: 10 },
    { name: 'limit', in: 'query', type: 'integer', required: false, description: '最多返回多少条，1-200', default: '20', minimum: 1, maximum: 200 },
    { name: 'orderby', in: 'query', type: 'string', required: false, description: 'time/magnitude', default: 'time' },
    FORMAT_PARAM,
  ],
  event: [
    { name: 'id', in: 'path', type: 'string', required: true, description: '事件 id，如 ci41339847', maxLength: 20 },
  ],
}

export const def: ProviderDef = {
  name: 'usgs',
  displayName: 'USGS 地震目录',
  tier: 'A',
  hosts: ['earthquake.usgs.gov'],
  minIntervalMs: 1000,
  uaNote: '美国地质调查局官方 FDSN 服务，公有领域数据，零 key',
  parseCostMs: 0,
  attribution: '数据属美国联邦政府公有领域；请注明 USGS / NEIC',
  tos: 'https://www.usgs.gov/information-policies-and-instructions/copyrights-and-credits',
  limits: '官方未公布硬性限流；本项目 1000ms 最小间隔自我约束',
  endpoints: [
    {
      op: 'search',
      resource: 'feed',
      method: 'GET',
      path: '/api/v1/usgs/earthquakes',
      summary: '按震级查询地震事件（GeoJSON FeatureCollection，limit≤200 约 145KB）',
      params: params.search ?? [],
      passthrough: true,
      inline: true,
      costMs: 0,
    },
    {
      op: 'event',
      resource: 'item',
      method: 'GET',
      path: '/api/v1/usgs/earthquakes/{id}',
      summary: '单个地震事件（GeoJSON Feature，约 6KB）',
      params: params.event ?? [],
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
      case 'search': {
        // minmagnitude 是小数（4.5 这种），框架只对 integer 做范围校验，
        // 所以格式和区间都在这里兜住，别把脏值透给上游
        const magnitude = queryValue(target, 'minmagnitude') ?? '2.5'
        const parsed = Number(magnitude)
        if (!/^\d{1,2}(?:\.\d{1,2})?$/.test(magnitude) || !Number.isFinite(parsed) || parsed < 0 || parsed > 10) {
          throw fail(ErrorCode.InvalidParameter, `invalid minmagnitude: ${magnitude}`, 400, {
            parameter: 'minmagnitude',
            value: magnitude,
          })
        }
        const order = queryValue(target, 'orderby') ?? 'time'
        if (!(ORDERS as readonly string[]).includes(order)) {
          throw fail(ErrorCode.InvalidParameter, `invalid orderby: ${order}`, 400, {
            parameter: 'orderby',
            allowed: [...ORDERS],
          })
        }
        const query: [string, string][] = [
          ['format', 'geojson'],
          ['minmagnitude', magnitude],
          ['limit', queryValue(target, 'limit') ?? '20'],
          ['orderby', order],
        ]
        // 实测 limit=200 要 4.8s，3s 默认超时不够；关掉重试，
        // 免得慢上游把内联请求拖成 2× 超时
        return {
          url: `${FDSN}?${toQuery(query)}`,
          resource: 'feed',
          timeoutMs: 8000,
          retries: 0,
        }
      }
      case 'event': {
        const id = target.id
        if (!EVENT_ID_PATTERN.test(id)) {
          throw fail(ErrorCode.InvalidParameter, `invalid event id: ${id}`, 400, {
            field: 'id',
            value: id,
            hint: '事件 id 形如 ci41339847、us7000d1v（小写字母数字，5-20 位）',
          })
        }
        return { url: `${FDSN}?eventid=${id}&format=geojson`, resource: 'item', timeoutMs: 8000, retries: 0 }
      }
      default:
        throw fail(ErrorCode.NotFound, `unknown usgs op: ${target.op}`, 404)
    }
  },
}

function toQuery(pairs: [string, string][]): string {
  return pairs.map(([key, value]) => `${key}=${encodeURIComponent(value)}`).join('&')
}
