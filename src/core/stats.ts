import { today } from './credits'
import { bumpCounter, logError } from './logger'
import { rawErrorText } from './errors'

/** `stats` 表只由 cron / queue 低频写入（<100 行/天），不参与请求热路径 */
export async function bumpStat(env: Env, path: string, delta = 1): Promise<void> {
  if (delta === 0) return
  try {
    await env.DB.prepare(
      'INSERT INTO stats (day, path, n) VALUES (?, ?, ?) ON CONFLICT(day, path) DO UPDATE SET n = n + excluded.n',
    )
      .bind(today(), path, delta)
      .run()
  } catch {
    // 统计失败不影响主流程
  }
}

export async function readStats(env: Env): Promise<{ day: string; path: string; n: number }[]> {
  try {
    const result = await env.DB.prepare(
      'SELECT day, path, n FROM stats WHERE day = ? ORDER BY n DESC LIMIT 50',
    )
      .bind(today())
      .all<{ day: string; path: string; n: number }>()
    return result.results ?? []
  } catch (error) {
    bumpCounter('stats_read_failed')
    logError({ event: 'stats_read_failed', message: rawErrorText(error) })
    return []
  }
}
