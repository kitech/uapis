/** 从任意 URL 里取出 `协议://host`，剥掉路径/query/hash；非法输入返回空串 */
export function normalizeOrigin(url: string): string {
  try {
    const u = new URL(url)
    return `${u.protocol}//${u.host}`
  } catch {
    return ''
  }
}

/** 当前请求的站点地址；无合法请求时返回空串 */
export function siteUrlOf(request: Request | undefined): string {
  return normalizeOrigin(request?.url ?? '')
}
