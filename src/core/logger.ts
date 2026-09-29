import { rawErrorText } from './errors'

/**
 * Workers Logs 免费额度为 20 万 events/天（保留 3 天），因此：
 *   * 错误全量记录（带 request_id 便于排障）
 *   * 2xx 只做 1% 采样，并设 4000 条/天硬上限
 *   * 正常流量只在内存里按分钟聚合，由 /status 暴露，不写日志
 */
const DAILY_SAMPLE_CAP = 4_000
const SAMPLE_RATE = 0.01

const minuteCounters = new Map<string, number>()
let sampleDay = ''
let samplesToday = 0

function currentDay(now: number): string {
  return new Date(now).toISOString().slice(0, 10)
}

function minuteKey(now: number): string {
  return new Date(now).toISOString().slice(0, 16)
}

/** 内存聚合计数，`/status` 读取 */
export function bumpCounter(bucket: string): void {
  const now = Date.now()
  const key = `${minuteKey(now)}|${bucket}`
  minuteCounters.set(key, (minuteCounters.get(key) ?? 0) + 1)
  if (minuteCounters.size > 2_000) {
    for (const [k, v] of minuteCounters) {
      if (v === 0 || k.slice(0, 16) < minuteKey(now - 10 * 60_000)) minuteCounters.delete(k)
    }
  }
}

export function countersSnapshot(now = Date.now()): { minute: string; buckets: Record<string, number> } {
  const prefix = minuteKey(now)
  const buckets: Record<string, number> = {}
  for (const [key, count] of minuteCounters) {
    if (key.startsWith(`${prefix}|`)) buckets[key.slice(prefix.length + 1)] = count
  }
  return { minute: prefix, buckets }
}

export function logError(fields: Record<string, unknown>): void {
  // fields 里可能混进 Error、循环引用或 BigInt，JSON.stringify 自己会抛。
  // 日志器一旦抛异常，最需要记录的那个错误就被吃掉了，所以这里必须兜住。
  try {
    console.error(JSON.stringify({ level: 'error', ...fields }))
  } catch {
    const safe: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(fields)) {
      safe[key] =
        value instanceof Error
          ? rawErrorText(value)
          : typeof value === 'string'
            ? value
            : undefined
    }
    console.error(JSON.stringify({ level: 'error', serialize_failed: true, ...safe }))
  }
}

export function logSampled(fields: Record<string, unknown>): void {
  const now = Date.now()
  const day = currentDay(now)
  if (day !== sampleDay) {
    sampleDay = day
    samplesToday = 0
  }
  if (samplesToday >= DAILY_SAMPLE_CAP) return
  if (Math.random() > SAMPLE_RATE) return
  samplesToday += 1
  console.log(JSON.stringify({ level: 'sample', ...fields }))
}

export function loggerState(): { day: string; samples: number; cap: number } {
  return { day: sampleDay, samples: samplesToday, cap: DAILY_SAMPLE_CAP }
}

export function resetLoggerState(): void {
  minuteCounters.clear()
  sampleDay = ''
  samplesToday = 0
}
