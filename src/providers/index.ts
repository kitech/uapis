import type { ProviderDef } from '../core/registry'
import type { ProviderRuntime } from './runtime'
import { def as arxivDef, runtime as arxivRuntime } from './arxiv'
import { def as crossrefDef, runtime as crossrefRuntime } from './crossref'
import { def as devtoDef, runtime as devtoRuntime } from './devto'
import { def as economistDef, runtime as economistRuntime } from './economist'
import { def as githubDef, runtime as githubRuntime } from './github'
import { def as hackernewsDef, runtime as hackernewsRuntime } from './hackernews'
import { def as itunesDef, runtime as itunesRuntime } from './itunes'
import { def as lobstersDef, runtime as lobstersRuntime } from './lobsters'
import { def as stackexchangeDef, runtime as stackexchangeRuntime } from './stackexchange'

/** 路由、OpenAPI、/status 与文档的唯一数据源 */
export const providers: ProviderDef[] = [
  stackexchangeDef,
  hackernewsDef,
  githubDef,
  devtoDef,
  arxivDef,
  economistDef,
  lobstersDef,
  itunesDef,
  crossrefDef,
]

const runtimes = new Map<string, ProviderRuntime>(
  [
    stackexchangeRuntime,
    hackernewsRuntime,
    githubRuntime,
    devtoRuntime,
    arxivRuntime,
    economistRuntime,
    lobstersRuntime,
    itunesRuntime,
    crossrefRuntime,
  ].map(
    (runtime) => [runtime.name, runtime],
  ),
)

export function runtimeFor(provider: string): ProviderRuntime | undefined {
  return runtimes.get(provider)
}
