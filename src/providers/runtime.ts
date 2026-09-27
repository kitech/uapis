import type { ProxyTarget } from '../core/fetcher'
import type { Resource } from '../core/ttl'
import type { Target } from '../core/target'

export interface UpstreamPlan {
  url: string
  method?: 'GET' | 'POST'
  headers?: Record<string, string>
  resource: Resource
  /** 覆盖默认 3s 超时：给本身就慢的上游（如 arXiv）放宽 */
  timeoutMs?: number
  /** 覆盖默认 1 次重试：慢上游宁可一次等久点，也别 2× 超时把内联请求拖到十几秒 */
  retries?: number
  /** 走付费通道时的回源描述 */
  proxy?: ProxyTarget
}

export interface TransformResult {
  text: string
  contentType: string
}

export interface ProviderRuntime {
  name: string
  /** 把可解码的 target 还原成上游请求 */
  buildPlan(env: Env, target: Target): Promise<UpstreamPlan>
  /**
   * 非 passthrough 源在落库前把上游响应转成本项目的输出形态。
   * 只对 `endpoint.passthrough === false` 的端点调用；抛错即视为上游异常。
   */
  transform?(raw: string, target: Target): TransformResult
}
