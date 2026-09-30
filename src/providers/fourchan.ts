import { ErrorCode, fail } from '../core/errors'
import { queryValue } from '../core/target'
import type { ParamDef, ProviderDef } from '../core/registry'
import type { TransformResult, UpstreamPlan, ProviderRuntime } from './runtime'

/**
 * 4chan 官方只读 JSON API，零 key。文档见 4chan/4chan-API 仓库。
 *
 * 1. **只有 catalog 端点**：需求只要"热贴"，而 `/{board}/catalog.json` 正好是
 *    网页版 catalog 页的数据源，含每个 OP 的 `replies` / `last_modified` /
 *    `last_replies`。thread / index / threadlist 一并留白。
 * 2. **必须 transform，原因是体积不是美观问题**：实测 `/g` 410KB、`/pol` 555KB，
 *    而 `fetcher.ts` 的 `MAX_UPSTREAM_BYTES` 是 512KB。注意 512KB 检查发生在
 *    transform **之前**（fetcher.ts:134），所以 transform 只能裁掉"体量以内的板块"；
 *    `/pol` 这类超限板块会在回源时就得到 413 FILE_TOO_LARGE（见 limits）。
 *    展平后取前 N 条，410KB → 约 15KB。
 * 3. **排序不动**：catalog 自带顺序是 bump 序（和 4chan 官网首页一致），
 *    不是回复数序。实测同一页的 `replies` 是 3/74/9/6/12/9/194/10 无规律，
 *    而 `last_modified` 严格递减。**重排等于我们自己定义了"热"**，
 *    且会和 4chan 用户认知里的"热贴"不一致，所以原样透传。
 * 4. **条款硬约束**：官方要求每至多 1 请求/秒、线程轮询 ≥10 秒。
 *    catalog 不是线程轮询，取 1000ms（= 官方上限），
 *    不再往下调——再低也没有额外收益，只会撞条款。
 * 5. `com` 是 HTML 片段（含 `<br>`、`<a href>`），不是纯文本，原样保留。
 *    另外 `com` 并不总存在：无附件的删除贴、纯附件帖都没有正文，解析不能假定它一定有。
 * 6. **Cloudflare Workers 出口实测 403（与 UA 无关）**：本机直连 `a.4cdn.org` 用本项目
 *    UA 和浏览器 UA 都是 200，但部署节点（Worker 出口）拉 catalog 一律 403。根因是 4chan
 *    的 Cloudflare WAF/Browser Integrity Check 拦"Worker 形态"请求（子请求带 `CF-Worker`
 *    头 + 共享数据中心出口，见 4chan/4chan-API#57）。此部署形态下该源不可用；要走代理需
 *    改目标 host/配额模型并受 MAX_UPSTREAM_BYTES 限制。
 */
const API = 'https://a.4cdn.org'
/**
 * 板块名：小写字母数字，1-8 位。实测合法值形如 `g` / `pol` / `3` / `4chan`。
 * 显式不收 `/`、`.`——这个值直接拼进上游 URL，挡掉路径穿越。
 */
const BOARD_PATTERN = /^[a-z0-9]{1,8}$/

export const params: Record<string, ParamDef[]> = {
  catalog: [
    { name: 'board', in: 'path', type: 'string', required: true, description: '板块名，如 g / pol / a', maxLength: 8 },
    { name: 'limit', in: 'query', type: 'integer', required: false, description: '返回前 N 个 OP，1-100', default: '25', minimum: 1, maximum: 100 },
  ],
}

export const def: ProviderDef = {
  name: 'fourchan',
  displayName: '4chan',
  tier: 'A',
  hosts: ['a.4cdn.org'],
  minIntervalMs: 1000,
  uaNote: '官方只读 JSON API，零 key',
  parseCostMs: 1,
  attribution: '各帖版权归发帖者所有',
  tos: 'https://github.com/4chan/4chan-API#api-terms-of-service',
  limits:
    '官方要求每至多 1 请求/秒；本项目取 1000ms 自我约束。' +
    'catalog.json 超过约 512KB 的大板块（如 /pol ≈555KB）会直接回源时 413 FILE_TOO_LARGE，' +
    'transform 只对体量以内的板块生效。' +
    '另实测本部署（Cloudflare Workers 出口）被 4chan 的 CF 风控拒绝（403，与 UA 无关），该源当前不可用',
  endpoints: [
    {
      op: 'catalog',
      resource: 'feed',
      method: 'GET',
      path: '/api/v1/fourchan/catalog/{board}',
      summary: '板块热贴（上游 catalog.json 展平后取前 N，bump 序）',
      params: params.catalog ?? [],
      // 上游 410KB+ 且分页包裹，必须 transform 裁剪
      passthrough: false,
      inline: true,
      costMs: 1,
    },
  ],
}

export const runtime: ProviderRuntime = {
  name: def.name,
  async buildPlan(env, target): Promise<UpstreamPlan> {
    switch (target.op) {
      case 'catalog': {
        const board = requirePattern(target.id, BOARD_PATTERN, 'board')
        return { url: `${API}/${board}/catalog.json`, resource: 'feed', timeoutMs: 5000 }
      }
      default:
        throw fail(ErrorCode.NotFound, `unknown fourchan op: ${target.op}`, 404)
    }
  },

  transform(raw, target): TransformResult {
    const limit = readLimit(target, 25)
    return {
      text: JSON.stringify({ provider: 'fourchan', threads: flattenCatalog(raw, limit) }),
      contentType: 'application/json; charset=utf-8',
    }
  },
}

interface CatalogThread {
  no: number
  [key: string]: unknown
}

/**
 * 上游是 `[{page, threads: [...]}, ...]` 的分页数组，这里跨页展平后取前 N。
 *
 * 展平而不是"先按页取"：catalog 的分页只是网页版目录页的镜像，
 * 第 1 页通常就够了，但板块小的时候前几页可能都不足 N 条，
 * 一路取到凑满或取完为止。
 *
 * 判错是**多层信号叠加**，不是单一条件——任何一层命中都按上游异常 502 处理，
 * 而不是悄悄返回 `{"threads":[]}`（后者会被负缓存 6 小时，比一次 502 坏得多）：
 *   1. 响应不是合法 JSON（网关/Cloudflare 挑战页冒充 JSON 在第一层就被挡）；
 *   2. 顶层不是数组、页不是对象、`threads` 不是数组、`thread.no` 不是数字；
 *   3. catalog 数组本身为空（`[]`，绝大多数是网关故障而非真空板）；
 *   4. 页数正常但展平后 0 个 OP（全空板，4chan 实际不会出现，视为故障）。
 */
function flattenCatalog(raw: string, limit: number): CatalogThread[] {
  let pages: unknown
  try {
    pages = JSON.parse(raw)
  } catch {
    throw fail(ErrorCode.UpstreamError, 'fourchan catalog is not valid JSON', 502)
  }
  if (!Array.isArray(pages)) {
    throw fail(ErrorCode.UpstreamError, 'fourchan catalog is not an array', 502)
  }
  if (pages.length === 0) {
    throw fail(ErrorCode.UpstreamError, 'fourchan catalog array is empty', 502)
  }

  const out: CatalogThread[] = []
  for (const page of pages) {
    if (out.length >= limit) break
    if (page === null || typeof page !== 'object') {
      throw fail(ErrorCode.UpstreamError, 'fourchan catalog page is not an object', 502)
    }
    const threads = (page as { threads?: unknown }).threads
    if (!Array.isArray(threads)) {
      throw fail(ErrorCode.UpstreamError, 'fourchan catalog page has no threads array', 502)
    }
    for (const thread of threads) {
      if (out.length >= limit) break
      if (thread === null || typeof thread !== 'object' || typeof (thread as CatalogThread).no !== 'number') {
        throw fail(ErrorCode.UpstreamError, 'fourchan catalog thread is malformed', 502)
      }
      out.push(thread as CatalogThread)
    }
  }
  if (out.length === 0) {
    throw fail(ErrorCode.UpstreamError, 'fourchan catalog has zero threads', 502)
  }
  return out
}

function readLimit(target: { query: [string, string][] }, fallback: number): number {
  const raw = queryValue(target, 'limit')
  if (raw === undefined) return fallback
  const value = Number.parseInt(raw, 10)
  return Number.isFinite(value) && value > 0 ? Math.min(value, 100) : fallback
}

function requirePattern(value: string, pattern: RegExp, field: string): string {
  if (!pattern.test(value)) {
    throw fail(ErrorCode.InvalidParameter, `invalid ${field}: ${value}`, 400, { field, value })
  }
  return value
}
