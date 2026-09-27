/**
 * provider 速率闸：把上游最小间隔固化到 D1，跨实例生效。
 * 被限速时不 sleep，而是把刷新任务用 `delaySeconds` 重投队列。
 */
export interface GateDecision {
  allowed: boolean
  waitSeconds: number
}

export async function checkGate(
  env: Env,
  provider: string,
  minIntervalMs: number,
): Promise<GateDecision> {
  const now = Date.now()
  try {
    const row = await env.DB.prepare('SELECT next_at FROM gate WHERE provider = ?')
      .bind(provider)
      .first<{ next_at: number }>()

    const nextAt = row?.next_at ?? 0
    if (nextAt > now) {
      return { allowed: false, waitSeconds: Math.max(1, Math.ceil((nextAt - now) / 1000)) }
    }

    const next = now + Math.max(0, minIntervalMs)
    await env.DB.prepare(
      'INSERT INTO gate (provider, next_at, fails) VALUES (?, ?, 0) ON CONFLICT(provider) DO UPDATE SET next_at = excluded.next_at',
    )
      .bind(provider, next)
      .run()
    return { allowed: true, waitSeconds: 0 }
  } catch {
    return { allowed: true, waitSeconds: 0 }
  }
}

export async function noteProviderFailure(env: Env, provider: string): Promise<void> {
  try {
    await env.DB.prepare(
      'INSERT INTO gate (provider, next_at, fails) VALUES (?, ?, 1) ON CONFLICT(provider) DO UPDATE SET fails = fails + 1',
    )
      .bind(provider, Date.now())
      .run()
  } catch {
    // ignore
  }
}

/** 管理端 kill switch：临时冻结某个 provider */
export async function holdProvider(env: Env, provider: string, minutes: number): Promise<number> {
  const until = Date.now() + Math.max(1, minutes) * 60_000
  await env.DB.prepare(
    'INSERT INTO gate (provider, next_at, fails) VALUES (?, ?, 0) ON CONFLICT(provider) DO UPDATE SET next_at = excluded.next_at',
  )
    .bind(provider, until)
    .run()
  return until
}

export async function readGate(env: Env): Promise<{ provider: string; next_at: number; fails: number }[]> {
  const result = await env.DB.prepare('SELECT provider, next_at, fails FROM gate').all<{
    provider: string
    next_at: number
    fails: number
  }>()
  return result.results ?? []
}
