import { allEndpoints, operationIdOf, type EndpointDef, type ParamDef } from './registry'
import { TTL_POLICIES } from './ttl'

const ERROR_REF = { $ref: '#/components/schemas/UApiError' } as const
const RATE_REF = { $ref: '#/components/schemas/RateLimited' } as const

/** 手写生成 OpenAPI 3.1：registry 是唯一数据源，不引入生成库 */
export function buildOpenApi(siteUrl: string): Record<string, unknown> {
  const paths: Record<string, Record<string, unknown>> = {}

  for (const { provider, endpoint } of allEndpoints()) {
    const policy = TTL_POLICIES[endpoint.resource] ?? TTL_POLICIES.passthrough
    const operation: Record<string, unknown> = {
      operationId: operationIdOf(provider.name, endpoint),
      summary: endpoint.summary,
      tags: [provider.name],
      security: [{ BearerAuth: [] }, {}],
      parameters: endpoint.params.map(paramSchema),
      responses: {
        200: {
          description: '上游数据，成功响应为裸业务对象（无信封）',
          headers: cacheHeaders(),
          content: { 'application/json': { schema: { type: 'object' } } },
        },
        202: {
          description: '已入队，等待回源；需带 `Prefer: respond-async`',
          content: { 'application/json': { schema: ERROR_REF } },
        },
        400: { description: 'INVALID_ARGUMENT / INVALID_PARAMETER', content: jsonContent(ERROR_REF) },
        401: { description: 'UNAUTHORIZED', content: jsonContent(ERROR_REF) },
        403: { description: 'FORBIDDEN', content: jsonContent(ERROR_REF) },
        404: { description: 'NOT_FOUND / NO_MATCH', content: jsonContent(ERROR_REF) },
        413: { description: 'FILE_TOO_LARGE', content: jsonContent(ERROR_REF) },
        429: {
          description: 'RATE_LIMITED',
          content: jsonContent(RATE_REF),
          headers: {
            'Retry-After': { schema: { type: 'integer' }, description: '秒' },
          },
        },
        502: { description: 'UPSTREAM_ERROR', content: jsonContent(ERROR_REF) },
        503: {
          description: 'PROVIDER_UNCONFIGURED / QUOTA_EXHAUSTED / REBUILDING / SERVICE_UNAVAILABLE',
          content: jsonContent(ERROR_REF),
        },
        504: { description: 'UPSTREAM_TIMEOUT', content: jsonContent(ERROR_REF) },
      },
      'x-free-tier-cost': {
        cpu_ms: endpoint.costMs,
        passthrough: endpoint.passthrough,
        inline: endpoint.inline,
        ttl_seconds: policy.ttlSeconds,
        stale_seconds: policy.staleSeconds,
      },
      'x-provider': {
        name: provider.name,
        tier: provider.tier,
        auth: provider.auth === undefined ? null : provider.auth.settingKey,
        min_interval_ms: provider.minIntervalMs,
        attribution: provider.attribution ?? null,
        tos: provider.tos ?? null,
        limits: provider.limits ?? null,
        ua_note: provider.uaNote ?? null,
      },
    }

    const method = endpoint.method.toLowerCase()
    paths[endpoint.path] = { ...(paths[endpoint.path] ?? {}), [method]: operation }
  }

  return {
    openapi: '3.1.0',
    info: {
      title: 'uapis',
      version: '0.1.0',
      summary: '部署在单个 Cloudflare Worker 上的国外站点聚合 API',
      description: [
        '本项目与 uapis.cn 无任何关联。',
        '',
        '- 成功响应为裸业务对象；错误响应为 `{code, message, details?}`',
        '- 所有响应带 `X-Request-ID`，限流相关响应带 `RateLimit` / `RateLimit-Policy`',
        '- 缓存命中会在 `X-Cache` 上标注 `HIT` / `HIT-T1` / `STALE` / `REFRESH` / `NEGATIVE`',
        '- 固定上游白名单，非开放代理；公开接口允许匿名，携带 Bearer 头可提高上游额度',
      ].join('\n'),
      license: { name: 'MIT', identifier: 'MIT' },
    },
    servers: [{ url: `${siteUrl.replace(/\/+$/, '')}/api/v1`, description: 'v1' }],
    tags: allEndpoints().map(({ provider }) => ({
      name: provider.name,
      description: `${provider.displayName}（tier ${provider.tier}）${provider.tos === undefined ? '' : ` · ToS ${provider.tos}`}`,
      'x-tier': provider.tier,
      'x-hosts': provider.hosts,
    })),
    security: [{ BearerAuth: [] }, {}],
    paths,
    components: {
      securitySchemes: {
        BearerAuth: {
          type: 'http',
          scheme: 'bearer',
          description:
            '可选。公开接口不校验；携带合法凭据可获得更高上游额度。`/admin/*` 必须携带 ADMIN_TOKEN。',
        },
      },
      schemas: {
        UApiError: {
          type: 'object',
          required: ['code', 'message'],
          additionalProperties: false,
          properties: {
            code: { type: 'string', examples: ['NOT_FOUND'] },
            message: { type: 'string' },
            details: { type: 'object', additionalProperties: true },
          },
        },
        RateLimited: {
          allOf: [
            ERROR_REF,
            {
              type: 'object',
              properties: {
                details: {
                  type: 'object',
                  properties: {
                    limit: { type: 'integer' },
                    window_seconds: { type: 'integer' },
                  },
                },
              },
            },
          ],
        },
      },
    },
  }
}

function paramSchema(param: ParamDef): Record<string, unknown> {
  const schema: Record<string, unknown> = { type: param.type }
  if (param.default !== undefined) schema.default = param.type === 'integer' ? Number(param.default) : param.default
  if (param.maxLength !== undefined) schema.maxLength = param.maxLength
  if (param.minimum !== undefined) schema.minimum = param.minimum
  if (param.maximum !== undefined) schema.maximum = param.maximum
  return {
    name: param.name,
    in: param.in,
    required: param.in === 'path' ? true : param.required,
    description: param.description,
    schema,
  }
}

function cacheHeaders(): Record<string, unknown> {
  return {
    'X-Cache': {
      schema: { type: 'string', enum: ['HIT', 'HIT-T1', 'STALE', 'STALE-FALLBACK', 'REFRESH', 'QUEUED', 'NEGATIVE', 'MISS'] },
      description: 'HIT-T1 表示命中 Cache API 快路径；STALE 表示返回的是 stale 窗口内的旧值',
    },
    'X-Cache-Age': { schema: { type: 'integer' }, description: '秒' },
  }
}

function jsonContent(schema: unknown): Record<string, unknown> {
  return { 'application/json': { schema } }
}
