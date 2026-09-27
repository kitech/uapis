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
}

export interface ProxySpec {
  /** 固定的目标 host，仍然要过白名单 */
  host: string
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
  /** 白名单 host，必须与 settings.upstream.allowlist 一致 */
  hosts: string[]
  minIntervalMs: number
  /** 需要覆盖默认 UA 的场景说明；实际 UA 由 fetcher 强制注入 */
  uaNote?: string
  parseCostMs: number
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

/** 上线前的自检：operationId 唯一、host 已进白名单、路径参数与声明一致 */
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
      if (endpoint.proxy !== undefined && !provider.hosts.includes(endpoint.proxy.host)) {
        problems.push(`${id}: proxy.host 未包含在 provider.hosts 中`)
      }
    }
    for (const host of provider.hosts) {
      if (!allowlist.includes(host)) problems.push(`${provider.name}: host ${host} 不在白名单中`)
    }
  }

  return { ok: problems.length === 0, problems }
}
