import type { ProxyChannel, ProxyMode } from './fetcher'
import type { Resource } from './ttl'

export type Tier = 'A' | 'A-' | 'B' | 'C'
export type HttpMethod = 'GET' | 'POST'

export interface ParamDef {
  name: string
  in: 'path' | 'query'
  type: 'string' | 'integer' | 'number' | 'boolean'
  required: boolean
  description: string
  default?: string
  maxLength?: number
  minimum?: number
  maximum?: number
  /**
   * 仅 path 参数：值允许包含 `/`（如付费墙文章的 `finance/2026/01/01/slug`）。
   * 路由生成时对应 Hono 的 `:name{.+}`，单段参数默认不跨 `/`。
   */
  multiSegment?: boolean
}

export interface ProxySpec {
  /** 固定的目标 host，仍然要过白名单 */
  host: string
  /**
   * 通道偏好（可选）。留空表示"按可用性自动选"：ZenRows 有额度就用 ZenRows，
   * 否则退到 Jina。写死某条通道会关掉这个 fallback。
   * 注意：真正计费的是 `runtime.buildPlan()` 返回的 `UpstreamPlan.proxy.channel`，
   * 这个字段只做声明与自检。
   */
  channel?: ProxyChannel
  mode?: ProxyMode
}

export interface EndpointDef {
  /** provider 内唯一的操作名，同时是缓存目标描述符的 op */
  op: string
  resource: Resource
  method: HttpMethod
  /** Hono 风格路径，`{id}` 会转成 `:id` */
  path: string
  summary: string
  params: ParamDef[]
  /** true = 上游 JSON 原样透传，零解析 */
  passthrough: boolean
  /** 允许 miss 时内联回源（passthrough 且非代理源） */
  inline: boolean
  /** 解析/生成响应的预估 CPU 毫秒 */
  costMs: number
  proxy?: ProxySpec
  /**
   * provider 级凭据要求。`optional` 表示该端点匿名也能用（如 SE 的 /sites），
   * 配了 key 会自动带上以提额，没配也不报错。
   */
  auth?: 'required' | 'optional'
}

export interface AuthDef {
  settingKey: string
  label: string
  signupUrl?: string
}

export interface ProviderDef {
  name: string
  displayName: string
  tier: Tier
  auth?: AuthDef
  /** 本 provider 允许接触的目标 host；proxy.host 必须是其中之一 */
  hosts: string[]
  /**
   * 真正走网络的那几个 host，必须与 settings.upstream.allowlist 一致。
   * 只走付费通道的 provider 用它：目标 host（如 medium.com）我们并不直连，
   * 出口只有代理服务自己，校验白名单时必须按出口算而不是按目标算。
   */
  egressHosts?: string[]
  minIntervalMs: number
  /** 需要覆盖默认 UA 的场景说明；实际 UA 由 fetcher 强制注入 */
  uaNote?: string
  parseCostMs: number
  /**
   * "配了任意一个 setting 才算可用"。tier C 走付费通道时用：ZenRows / Jina
   * 两条通道任一可用即可，全空说明这个 provider 现在根本没法回源。
   */
  requiredAnyOf?: string[]
  attribution?: string
  tos?: string
  limits?: string
  endpoints: EndpointDef[]
}

import { providers } from '../providers'

export const REGISTRY: readonly ProviderDef[] = providers

export function providerByName(name: string): ProviderDef | undefined {
  return REGISTRY.find((provider) => provider.name === name)
}

export function endpointByOp(provider: ProviderDef, op: string): EndpointDef | undefined {
  return provider.endpoints.find((endpoint) => endpoint.op === op)
}

export function operationIdOf(provider: string, endpoint: EndpointDef): string {
  const verb = endpoint.method.toLowerCase()
  return `${verb}-${provider}-${endpoint.op}`
}

/** 路由注册顺序：provider → endpoint，路径在运行时从 endpoint.path 生成 */
export function allEndpoints(): { provider: ProviderDef; endpoint: EndpointDef }[] {
  const flat: { provider: ProviderDef; endpoint: EndpointDef }[] = []
  for (const provider of REGISTRY) {
    for (const endpoint of provider.endpoints) flat.push({ provider, endpoint })
  }
  return flat
}

/** 出口白名单校验用哪组 host：只走代理的 provider 用 egressHosts */
export function egressHostsOf(provider: ProviderDef): string[] {
  return provider.egressHosts ?? provider.hosts
}

/** 上线前的自检：operationId 唯一、host 已进白名单、路径参数与声明一致 */
/**
 * 每日额度下限：`quota.<provider>.default` 必须在代码默认值里存在且大于 0。
 * 0 表示不限，而"忘了配"和"故意不限"在效果上一样——都是这个源没有任何硬上限，
 * 所以这里要求显式给出数字。tier C 记在通道维度（`quota.proxy.*`），不参与本检查。
 */
export function missingQuotaDefaults(
  settingsDefaults: Readonly<Record<string, string>>,
): string[] {
  const missing: string[] = []
  for (const provider of REGISTRY) {
    if (provider.tier === 'C') continue
    const raw = settingsDefaults[`quota.${provider.name}.default`]
    const limit = Number.parseInt(raw ?? '', 10)
    if (!Number.isFinite(limit) || limit <= 0) {
      missing.push(`${provider.name}: quota.${provider.name}.default 缺失或非正数（回源将不受限）`)
    }
  }
  return missing
}

export function validateRegistry(
  allowlist: string[],
): { ok: boolean; problems: string[] } {
  const problems: string[] = []
  const seen = new Set<string>()

  for (const provider of REGISTRY) {
    if (provider.endpoints.length === 0) problems.push(`${provider.name}: 没有 endpoint`)
    for (const endpoint of provider.endpoints) {
      const id = operationIdOf(provider.name, endpoint)
      if (seen.has(id)) problems.push(`operationId 重复: ${id}`)
      seen.add(id)

      const declared = new Set(
        endpoint.params.filter((param) => param.in === 'path').map((param) => param.name),
      )
      const inPath = new Set([...endpoint.path.matchAll(/\{(\w+)\}/g)].map((m) => m[1] ?? ''))
      for (const name of declared) {
        if (!inPath.has(name)) problems.push(`${id}: 声明的路径参数 ${name} 未出现在 path`)
      }
      for (const name of inPath) {
        if (!declared.has(name)) problems.push(`${id}: path 中的 ${name} 未声明`)
      }
      if (endpoint.proxy !== undefined) {
        if (!provider.hosts.includes(endpoint.proxy.host)) {
          problems.push(`${id}: proxy.host 未包含在 provider.hosts 中`)
        }
        // 代理端点不能内联回源：同步路径上烧 credits 没有闸门保护，
        // 一次突发就能把当天的付费额度打光
        if (endpoint.inline) {
          problems.push(`${id}: 走付费通道的端点不允许 inline（会绕过额度节流）`)
        }
        if (endpoint.passthrough && endpoint.resource === 'wall') {
          problems.push(`${id}: 付费墙源不应使用 passthrough（上游是 HTML/Markdown）`)
        }
      }
      if (provider.tier === 'C' && endpoint.proxy === undefined) {
        problems.push(`${id}: tier C 端点必须声明 proxy，不允许免费绕过`)
      }
      if (provider.tier === 'C' && (provider.requiredAnyOf ?? []).length === 0) {
        problems.push(`${provider.name}: tier C 必须声明 requiredAnyOf（可用通道的 setting）`)
      }
      // multiSegment 会让 `:name` 变成 `:name{.+}`，值里能带 `/`；
      // 这类参数必须自己校验（`..`、query 注入），路由层只管非空
      for (const param of endpoint.params) {
        if (param.multiSegment === true && param.in !== 'path') {
          problems.push(`${id}: multiSegment 只适用于 path 参数（${param.name}）`)
        }
      }
    }
    for (const host of egressHostsOf(provider)) {
      if (!allowlist.includes(host)) problems.push(`${provider.name}: host ${host} 不在白名单中`)
    }
  }

  return { ok: problems.length === 0, problems }
}
