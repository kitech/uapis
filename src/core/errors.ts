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

/** 上游 HTTP 状态 → 本项目对外状态与错误码 */
export function mapUpstreamStatus(
  upstreamStatus: number,
): { status: number; code: ErrorCodeName } {
  if (upstreamStatus === 400) return { status: 400, code: ErrorCode.InvalidArgument }
  if (upstreamStatus === 401) return { status: 502, code: ErrorCode.UpstreamError }
  if (upstreamStatus === 403) return { status: 403, code: ErrorCode.Forbidden }
  if (upstreamStatus === 404) return { status: 404, code: ErrorCode.NotFound }
  if (upstreamStatus === 429) return { status: 429, code: ErrorCode.RateLimited }
  if (upstreamStatus >= 500) return { status: 502, code: ErrorCode.UpstreamError }
  if (upstreamStatus >= 400) return { status: 400, code: ErrorCode.InvalidParameter }
  return { status: 502, code: ErrorCode.UpstreamError }
}
