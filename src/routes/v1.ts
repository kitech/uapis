import type { Context } from 'hono'
import { Hono } from 'hono'
import type { AppEnv } from '../types'
import { ErrorCode, fail } from '../core/errors'
import { allEndpoints, providerByName, type EndpointDef, type ParamDef } from '../core/registry'
import { serveResource } from '../core/pipeline'
import type { Target } from '../core/target'

const v1 = new Hono<AppEnv>()

/** 路由表由 registry 生成：新增 provider 只需改 registry，不必再写路由 */
for (const { provider, endpoint } of allEndpoints()) {
  const path = endpoint.path.replace(/\{(\w+)\}/g, ':$1')
  const handler = (c: Context<AppEnv>): Promise<Response> =>
    handle(c, provider.name, endpoint)

  if (endpoint.method === 'GET') v1.get(path, handler)
  else v1.post(path, handler)
}

async function handle(
  c: Context<AppEnv>,
  providerName: string,
  endpoint: EndpointDef,
): Promise<Response> {
  const provider = providerByName(providerName)
  if (provider === undefined) {
    throw fail(ErrorCode.NotFound, `unknown provider: ${providerName}`, 404)
  }

  // 多个路径参数按声明顺序用 `/` 连接（GitHub 的 owner/repo），单参数时行为不变
  const pathParams = endpoint.params.filter((param) => param.in === 'path')
  const segments: string[] = []
  for (const param of pathParams) {
    const value = c.req.param(param.name) ?? ''
    if (value.length === 0) {
      throw fail(ErrorCode.InvalidParameter, `missing path parameter: ${param.name}`, 400)
    }
    segments.push(value)
  }
  const rawId = segments.join('/')

  const target: Target = { op: endpoint.op, id: rawId, query: collectQuery(endpoint, c) }
  return serveResource(c, provider, endpoint, target, { inline: true })
}

/** 只接受 endpoint 声明过的 query，其余一律 400，避免缓存键被无关参数污染 */
function collectQuery(endpoint: EndpointDef, c: Context<AppEnv>): [string, string][] {
  const declared = new Map<string, ParamDef>(
    endpoint.params.filter((param) => param.in === 'query').map((param) => [param.name, param]),
  )
  const pairs: [string, string][] = []

  for (const [name, values] of Object.entries(c.req.queries())) {
    const value = Array.isArray(values) ? (values[0] ?? '') : String(values)
    const param = declared.get(name)
    if (param === undefined) {
      throw fail(ErrorCode.InvalidParameter, `unknown query parameter: ${name}`, 400, {
        allowed: [...declared.keys()],
      })
    }
    validate(param, value)
    pairs.push([name, value])
  }

  for (const [name, param] of declared) {
    if (param.required && !pairs.some(([key]) => key === name)) {
      throw fail(ErrorCode.InvalidParameter, `missing required parameter: ${name}`, 400, {
        parameter: name,
      })
    }
    if (param.default === undefined) continue
    if (pairs.some(([key]) => key === name)) continue
    pairs.push([name, param.default])
  }

  return pairs
}

function validate(param: ParamDef, value: string): void {
  if (param.maxLength !== undefined && value.length > param.maxLength) {
    throw fail(ErrorCode.InvalidParameter, `${param.name} too long`, 400, {
      parameter: param.name,
      max_length: param.maxLength,
    })
  }
  if (param.type === 'integer') {
    if (!/^\d+$/.test(value)) {
      throw fail(ErrorCode.InvalidParameter, `${param.name} must be an integer`, 400, {
        parameter: param.name,
        value,
      })
    }
    const parsed = Number.parseInt(value, 10)
    if (param.minimum !== undefined && parsed < param.minimum) {
      throw fail(ErrorCode.InvalidParameter, `${param.name} below minimum`, 400, {
        parameter: param.name,
        minimum: param.minimum,
      })
    }
    if (param.maximum !== undefined && parsed > param.maximum) {
      throw fail(ErrorCode.InvalidParameter, `${param.name} above maximum`, 400, {
        parameter: param.name,
        maximum: param.maximum,
      })
    }
  }
  if (param.type === 'boolean' && !/^(true|false|0|1)$/.test(value)) {
    throw fail(ErrorCode.InvalidParameter, `${param.name} must be boolean`, 400, {
      parameter: param.name,
    })
  }
}

export default v1
