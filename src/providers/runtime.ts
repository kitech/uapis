import type { ProxyTarget } from '../core/fetcher'
import type { Resource } from '../core/ttl'
import type { Target } from '../core/target'

export interface UpstreamPlan {
  url: string
  method?: 'GET' | 'POST'
  headers?: Record<string, string>
  resource: Resource
  /** 走付费通道时的回源描述 */
  proxy?: ProxyTarget
}

export interface ProviderRuntime {
  name: string
  /** 把可解码的 target 还原成上游请求 */
  buildPlan(env: Env, target: Target): Promise<UpstreamPlan>
}
