import { ErrorCode, fail } from '../core/errors'
import { FORMAT_PARAM } from '../core/uapis'
import type { ParamDef, ProviderDef } from '../core/registry'
import type { UpstreamPlan, ProviderRuntime } from './runtime'

/**
 * HAL：法国国家科研与高等教育机构开放的学术档案库，覆盖法国全部高校与 CNRS 等
 * 机构的研究产出。官方 Solr 接口，匿名可用，无订阅分级。
 *
 * 文档入口：https://api.hal.science/
 *
 * 两个实测出来的坑：
 *
 * 1. **`sort` 是空格分隔，不是逗号。** `sort=producedDate_s,desc` 回 44 字节的
 *    错误体；`sort=producedDate_s%20desc` 才正常。这里手动拼 `%20`。
 * 2. **没有 `/doc/{id}` 这条 REST 路径**（会 302）。单篇取回就是一次
 *    `q=halId_s:<id>&rows=1` 的检索，所以 `detail` 端点复用了 search 的 URL 形态。
 *
 * 默认字段集刻意收窄：HAL 的 `fl=*` 会把 `filesMain_s`（全文 PDF 链接）、
 * `abstract_s`、`keyword_s` 全带回来，体积能翻几倍。要全文由调用方显式传 `fl`。
 */
const API = 'https://api.hal.science'
/** 默认字段：够拼出标题/作者/日期/落地页，且不含全文链接 */
const DEFAULT_FL = [
  'title_s',
  'uri_s',
  'docid',
  'halId_s',
  'producedDate_s',
  'authFullName_s',
  'docType_s',
  'structName_s',
  'doiId_s',
].join(',')
const DEFAULT_SORT = 'producedDate_s desc'
/** `hal-05597672`，允许带版本后缀 `v1` */
const HAL_ID_PATTERN = /^hal-\d{6,9}(v\d+)?$/

export const params: Record<string, ParamDef[]> = {
  search: [
    { name: 'q', in: 'query', type: 'string', required: true, description: '检索式，如 graph、deep learning', maxLength: 200 },
    { name: 'rows', in: 'query', type: 'integer', required: false, description: '每页条数，1-100', default: '10', minimum: 1, maximum: 100 },
    { name: 'start', in: 'query', type: 'integer', required: false, description: '起始偏移，0 起', default: '0', minimum: 0 },
    {
      name: 'sort',
      in: 'query',
      type: 'string',
      required: false,
      // 上游是空格分隔的 `field direction`，不是逗号——实测逗号会拿到错误体
      description: '排序，如 producedDate_s desc / score desc',
      default: DEFAULT_SORT,
      maxLength: 60,
    },
    {
      name: 'fl',
      in: 'query',
      type: 'string',
      required: false,
      description: '返回字段，逗号分隔。不给就用收窄的默认集；`fl=*` 会带上全文链接、体积显著变大',
      default: DEFAULT_FL,
      maxLength: 400,
    },
    FORMAT_PARAM,
  ],
  detail: [
    { name: 'id', in: 'path', type: 'string', required: true, description: 'HAL ID，如 hal-05597672', maxLength: 20 },
  ],
}

export const def: ProviderDef = {
  name: 'hal',
  displayName: 'HAL',
  tier: 'A-',
  hosts: ['api.hal.science'],
  minIntervalMs: 1000,
  // 实例偶发慢：实测 rows=50 有过一次 20s 超时。放宽单次超时但关掉重试，
  // 宁可一次等久点，也不要 2× 超时把内联请求拖成两倍时长
  uaNote: '官方公开 Solr 接口，无需注册、无需 key',
  parseCostMs: 0,
  attribution: 'HAL 内容以开放许可发布，机构与作者保留权利',
  tos: 'https://api.hal.science/',
  limits: '官方未公布硬性限流；本项目 1 秒最小间隔自我约束',
  endpoints: [
    {
      op: 'search',
      resource: 'feed',
      method: 'GET',
      path: '/api/v1/hal/search',
      summary: '检索 HAL 档案（上游 Solr /search/）',
      params: params.search ?? [],
      passthrough: true,
      inline: true,
      costMs: 0,
    },
    {
      op: 'detail',
      resource: 'item',
      method: 'GET',
      path: '/api/v1/hal/detail/{id}',
      summary: '单条 HAL 记录（上游等价于 q=halId_s:<id>&rows=1 的检索）',
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
      case 'search':
        return {
          url: `${API}/search/?${searchQuery(target.query)}`,
          resource: 'feed',
          timeoutMs: 8000,
          retries: 0,
        }
      case 'detail': {
        const id = target.id
        if (!HAL_ID_PATTERN.test(id)) {
          throw fail(ErrorCode.InvalidParameter, `invalid id: ${id}`, 400, { field: 'id', value: id })
        }
        const query = new URLSearchParams({
          q: `halId_s:${id}`,
          rows: '1',
          fl: DEFAULT_FL,
        })
        return { url: `${API}/search/?${query.toString()}`, resource: 'item', timeoutMs: 8000, retries: 0 }
      }
      default:
        throw fail(ErrorCode.NotFound, `unknown hal op: ${target.op}`, 404)
    }
  },
}

function searchQuery(query: Array<[string, string]>): string {
  const search = new URLSearchParams()
  search.set('q', read(query, 'q') ?? '')
  search.set('rows', read(query, 'rows') ?? '10')
  search.set('start', read(query, 'start') ?? '0')
  // URLSearchParams 会把空格编成 `+`；上游 Solr 认 `+`，但这里显式给默认值，
  // 避免调用方不传 sort 时落成无序结果
  search.set('sort', read(query, 'sort') ?? DEFAULT_SORT)
  search.set('fl', read(query, 'fl') ?? DEFAULT_FL)
  return search.toString()
}

function read(query: Array<[string, string]>, name: string): string | undefined {
  return query.find(([key]) => key === name)?.[1]
}