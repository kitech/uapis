/**
 * 对齐 uapis 的错误码全集与 `UApiError` 结构。
 * 成功响应不使用信封，直接返回裸业务对象。
 */
export const ErrorCode = {
  InvalidArgument: 'INVALID_ARGUMENT',
  InvalidParameter: 'INVALID_PARAMETER',
  Unauthorized: 'UNAUTHORIZED',
  Forbidden: 'FORBIDDEN',
  NotFound: 'NOT_FOUND',
  NoMatch: 'NO_MATCH',
  FileTooLarge: 'FILE_TOO_LARGE',
  RateLimited: 'RATE_LIMITED',
  InternalError: 'INTERNAL_ERROR',
  UpstreamError: 'UPSTREAM_ERROR',
  ProviderUnconfigured: 'PROVIDER_UNCONFIGURED',
  QuotaExhausted: 'QUOTA_EXHAUSTED',
  Rebuilding: 'REBUILDING',
  ServiceUnavailable: 'SERVICE_UNAVAILABLE',
  StorageUnavailable: 'STORAGE_UNAVAILABLE',
  UpstreamTimeout: 'UPSTREAM_TIMEOUT',
} as const

export type ErrorCodeName = (typeof ErrorCode)[keyof typeof ErrorCode]

export interface ErrorBody {
  code: string
  message: string
  details?: Record<string, unknown>
}

export class ApiError extends Error {
  readonly code: string
  readonly status: number
  readonly details?: Record<string, unknown>
  /** 可选的 Retry-After 秒数 */
  readonly retryAfter?: number

  constructor(
    code: string,
    message: string,
    status: number,
    details?: Record<string, unknown>,
    retryAfter?: number,
  ) {
    super(message)
    this.name = 'ApiError'
    this.code = code
    this.status = status
    this.details = details
    this.retryAfter = retryAfter
  }

  toBody(): ErrorBody {
    return this.details === undefined
      ? { code: this.code, message: this.message }
      : { code: this.code, message: this.message, details: this.details }
  }
}

export function fail(
  code: ErrorCodeName,
  message: string,
  status: number,
  details?: Record<string, unknown>,
  retryAfter?: number,
): ApiError {
  return new ApiError(code, message, status, details, retryAfter)
}

/**
 * D1 抛出的错误在生产环境顶层 message 往往只有一个 `D1_ERROR`，真正的原因
 * （表名、列名、约束名）在 cause 链上。不走 cause 就只能把一个毫无信息量的
 * "D1_ERROR" 抛给客户端，等于没报错。
 */
export function rawErrorText(error: unknown): string {
  const parts: string[] = []
  const seen = new Set<unknown>()
  let current: unknown = error
  while (current !== null && current !== undefined && !seen.has(current) && parts.length < 8) {
    seen.add(current)
    const text =
      current instanceof Error
        ? current.message === ''
          ? current.name
          : current.message
        : String(current)
    if (text !== '' && !parts.includes(text)) parts.push(text)
    current = (current as { cause?: unknown }).cause
  }
  return parts.length > 0 ? parts.join(': ') : 'unknown error'
}

const STORAGE_MARKER = /D1_ERROR|SQLITE_[A-Z_]+|no such (table|column)|D1 (database|error)/i

/** 只在错误确实来自 D1 时才归类为存储故障，上游错误和业务 ApiError 不受影响 */
export function isStorageError(error: unknown): boolean {
  if (error instanceof ApiError) return false
  return STORAGE_MARKER.test(rawErrorText(error))
}

/**
 * D1 故障的统一出口：503 + 原始错误文本。
 * 刻意不传 retryAfter——不给客户端任何"多久后重试"的指令。
 */
export function storageFail(error: unknown, details?: Record<string, unknown>): ApiError {
  return new ApiError(ErrorCode.StorageUnavailable, rawErrorText(error), 503, details)
}

/** 上游 HTTP 状态 → 本项目对外状态与错误码 */
export function mapUpstreamStatus(
  upstreamStatus: number,
): { status: number; code: ErrorCodeName } {
  if (upstreamStatus === 400) return { status: 400, code: ErrorCode.InvalidArgument }
  if (upstreamStatus === 401) return { status: 502, code: ErrorCode.UpstreamError }
  if (upstreamStatus === 403) return { status: 403, code: ErrorCode.Forbidden }
  if (upstreamStatus === 404) return { status: 404, code: ErrorCode.NotFound }
  if (upstreamStatus === 429) return { status: 429, code: ErrorCode.RateLimited }
  // 504 要在 >= 500 之前拦：UPSTREAM_TIMEOUT 一直在 errors.md 和 openapi 里
  // 写着，却因为被下面这行吃掉而永远不可能返回
  if (upstreamStatus === 504) return { status: 504, code: ErrorCode.UpstreamTimeout }
  if (upstreamStatus >= 500) return { status: 502, code: ErrorCode.UpstreamError }
  if (upstreamStatus >= 400) return { status: 400, code: ErrorCode.InvalidParameter }
  return { status: 502, code: ErrorCode.UpstreamError }
}
