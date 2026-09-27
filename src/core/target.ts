/**
 * 刷新任务描述符。
 *
 * 缓存键 `k` 是 id 与 query 的单向哈希，无法反推请求，因此队列消息的 `t`
 * 字段保存可解码的描述符：`{op}:{encodeURIComponent(id)}?{k}={v}&...`
 * 消息结构仍为 {v,k,p,t}，只是 `t` 承担了 target 的职责。
 */
export interface Target {
  /** provider 内的 endpoint.op */
  op: string
  /** 原始 id，保留大小写（部分站点的 handle 大小写敏感） */
  id: string
  /** 已按白名单过滤的 query */
  query: [string, string][]
}

export function encodeTarget(target: Target): string {
  const query = target.query
    .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
    .join('&')
  const head = `${target.op}:${encodeURIComponent(target.id)}`
  return query.length > 0 ? `${head}?${query}` : head
}

export function decodeTarget(raw: string): Target | null {
  const separator = raw.indexOf(':')
  if (separator <= 0) return null
  const op = raw.slice(0, separator)
  const rest = raw.slice(separator + 1)
  const [idPart, queryPart] = rest.split('?')
  let id = ''
  try {
    id = decodeURIComponent(idPart ?? '')
  } catch {
    return null
  }
  const query: [string, string][] = []
  if (queryPart !== undefined && queryPart.length > 0) {
    for (const pair of queryPart.split('&')) {
      const eq = pair.indexOf('=')
      if (eq <= 0) continue
      const key = pair.slice(0, eq)
      let value = ''
      try {
        value = decodeURIComponent(pair.slice(eq + 1))
      } catch {
        continue
      }
      query.push([key, value])
    }
  }
  return { op, id, query }
}

export function queryValue(target: Target, name: string): string | undefined {
  return target.query.find(([key]) => key === name)?.[1]
}
