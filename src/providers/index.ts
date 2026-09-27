import type { ProviderDef } from '../core/registry'
import type { ProviderRuntime } from './runtime'
import { def as hackernewsDef, runtime as hackernewsRuntime } from './hackernews'
import { def as stackexchangeDef, runtime as stackexchangeRuntime } from './stackexchange'

/** 路由、OpenAPI、/status 与文档的唯一数据源 */
export const providers: ProviderDef[] = [stackexchangeDef, hackernewsDef]

const runtimes = new Map<string, ProviderRuntime>(
  [stackexchangeRuntime, hackernewsRuntime].map((runtime) => [runtime.name, runtime]),
)

export function runtimeFor(provider: string): ProviderRuntime | undefined {
  return runtimes.get(provider)
}
