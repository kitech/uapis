import { isMissingTableError, rawErrorText } from './errors'
import { PROBE_PROVIDER, WRITE_PROBE_KEY } from './queue'
import { readFoundSchema } from './bootstrap'
import {
  diffSchema,
  schemaOk,
  EXPECTED_MIGRATIONS,
  type ProbeTier,
  type SchemaDiff,
} from './schema-contract'

const PROBE_TIMEOUT_MS = 3000

/** 超过这个间隔没探测，就不算「consumer 没工作」——可能只是没人调 healthz */
const ACK_STALE_MS = 10 * 60_000
const MIGRATIONS_TABLE = 'd1_migrations'

/** 探针挂起时必须自己超时返回，否则监控拿到的是连接错误而不是 503 JSON */
async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`probe timeout after ${ms}ms`)), ms)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

export type CheckResult = { ok: boolean; ms: number; error?: string }

export type HealthReport = {
  status: 'ok' | 'degraded'
  /** 顶层旧字段保留，监控脚本不用改 */
  d1: boolean
  schema: boolean
  /** 非致命降级：不影响 200/503 判定 */
  warnings: string[]
  checks: {
    connect: CheckResult
    /**
     * diff 为 null = 结构探测没跑成，和「什么都没缺」是两件不同的事。
     * 线上就是在这上面出的事：ok:false 配一个空 diff，
     * 任何按 missingTables.length === 0 判绿的看板都会显示正常。
     * tier = 实际生效的探测层级，下次再撞上 authorizer 差异看它就行
     */
    schema: CheckResult & { diff: SchemaDiff | null; tier: ProbeTier | null }
    migrations: CheckResult & { table: string; applied: string[]; pending: string[] }
    write: CheckResult & { skipped?: string }
    queue: CheckResult & {
      binding: string
      sent: boolean
      /** null = 从未探测，或最近没人探测（超过 10 分钟） */
      acked: boolean | null
      /** 本轮探针发出的时间戳；消费端拿它做 CAS 回写 */
      probeSentAt: number | null
    }
  }
  ms: number
  ts: string
}

type ProbeOk<T extends object> = { ok: true; ms: number } & T
type ProbeFail = CheckResult & Record<string, unknown>

/**
 * 单段探针。
 *
 * 失败时把 error 上挂的自定义字段原样带出来（schema 段的 diff、
 * migrations 段的 applied/pending）——探针内部是「查到了但不满足」，
 * 只丢一句 error 会让 healthz 退化成「有问题但看不出是什么问题」。
 * ok/ms/error 放在展开之后，保证不会被 error 上的同名键覆盖。
 */
async function probe<T extends object>(
  fn: () => Promise<T | null | undefined>,
): Promise<ProbeOk<T> | ProbeFail> {
  const t0 = Date.now()
  try {
    const extra = (await fn()) ?? ({} as T)
    return { ok: true, ms: Date.now() - t0, ...extra }
  } catch (error) {
    // 剥掉 Error 自带的三个字段，剩下的是探针挂上去的诊断数据
    const rest: Record<string, unknown> = { ...(error as object) }
    delete rest.message
    delete rest.name
    delete rest.stack
    return {
      ...rest,
      ok: false,
      ms: Date.now() - t0,
      error: rawErrorText(error),
    }
  }
}

const fail = (reason: string): CheckResult & { skipped: string } => ({
  ok: false,
  ms: 0,
  skipped: reason,
  error: `skipped: ${reason}`,
})

export type HealthOptions = {
  /**
   * 是否跑队列探针。/healthz 用 true（它就是给监控看的）；
   * /status 用 false——那个页面是给人排障时打开看的，
   * 每看一次就发一条队列消息 + 写一行，属于纯浪费。
   */
  probeQueue?: boolean
}

/**
 * 五段探针：connect / schema / migrations / write / queue。
 *
 * 必须串行，不得改成 Promise.all：Free 计划 50 查询/调用、6 并发连接
 * （D1 limits）。串行峰值并发 1；并发会让 7 条同打而静默排队，探针变慢。
 *
 * 行写入预算：gate 是 WITHOUT ROWID，一次写 1 行。write 探针 2 行
 * （INSERT + DELETE）+ queue 探针 2 行（写正数 + 消费端回写负数）= 每次 4 行。
 * 30s 轮询 = 2880 次/天 = 11520 行/天。
 *
 * 提醒：/healthz 无鉴权，而 0001_init.sql 记的基线已经 6.4 万行/天、
 * 上限 10 万——余量只剩 9000 次调用。也就是说任何超过 10 秒一轮的
 * 轮询（或多地多份监控）都会把当天写额度打穿，届时站点当天无法写缓存。
 * 限流中间件是 isolate 内内存计数，挡不住多 isolate / 多 IP。
 * 要公开暴露就得先加服务端节流，见 CHANGELOG。
 */
export async function runHealthChecks(env: Env, options: HealthOptions = {}): Promise<HealthReport> {
  const started = Date.now()
  const db = env.DB

  // connect 与 schema 分开 try：D1 限额/故障会让查询整体失败，但那是
  // 「连上了用不了」而不是「连不上」，混在一起报 d1:false 会误导排障。
  // 丢弃查询结果，只关心它成不成功。
  const connect = await probe(async () => {
    await db.prepare('SELECT 1 AS ok').first()
    return {}
  })

  if (!connect.ok) {
    return {
      status: 'degraded',
      d1: false,
      schema: false,
      warnings: [],
      checks: {
        connect,
        schema: { ok: false, ms: 0, error: 'skipped: connect failed', diff: null, tier: null },
        migrations: {
          ok: false,
          ms: 0,
          table: MIGRATIONS_TABLE,
          applied: [],
          pending: [],
          error: 'skipped: connect failed',
        },
        write: fail('connect failed'),
        queue: {
          ok: false,
          ms: 0,
          binding: 'REFRESH',
          sent: false,
          acked: null,
          probeSentAt: null,
          error: 'skipped: connect failed',
        },
      },
      ms: Date.now() - started,
      ts: new Date().toISOString(),
    }
  }

  // 与自举的快路径共用同一个结构读取，避免两处各写一份 SQL 走偏
  const schema = await probe(async () => {
    const found = await withTimeout(readFoundSchema(db), PROBE_TIMEOUT_MS)
    const diff = diffSchema(found)
    if (!schemaOk(diff)) throw Object.assign(new Error('schema incomplete'), { diff, tier: found.tier })
    return { diff, tier: found.tier }
  })
  const schemaCheck: HealthReport['checks']['schema'] = schema.ok
    ? schema
    : {
        ...schema,
        diff: (schema.diff as SchemaDiff | undefined) ?? null,
        tier: (schema.tier as ProbeTier | undefined) ?? null,
      }

  const migrations = await probe(async () => {
    // 读不到记账表 = 迁移压根没跑过。这不是异常，是结论。
    // 但**只有** "no such table" 能这么解释：超时、鉴权、限额都是故障，
    // 一并吞成 applied=[] 会把 D1 故障说成「你忘了跑 db:migrate」。
    // 线上就是被这条掩盖的：d1_migrations 根本不存在，报告却给出一句
    // 干净的 "1 migration(s) pending"，看起来像成功读到了记账表。
    let applied: string[] = []
    try {
      const rows = await withTimeout(
        db.prepare(`SELECT name FROM ${MIGRATIONS_TABLE} ORDER BY id`).all<{ name: string }>(),
        PROBE_TIMEOUT_MS,
      )
      applied = (rows.results ?? [])
        .map((row) => row.name)
        .filter((name): name is string => typeof name === 'string')
    } catch (error) {
      if (!isMissingTableError(error)) throw error
      applied = []
    }
    const pending = EXPECTED_MIGRATIONS.filter((name) => !applied.includes(name))
    if (pending.length > 0) {
      throw Object.assign(new Error(`${pending.length} migration(s) pending`), { applied, pending })
    }
    return { table: MIGRATIONS_TABLE, applied, pending }
  })
  // 探针内部是「查到了但不满足」：diff / applied / pending 挂在 throw 的 error
  // 上，probe() 会把它们搬进返回值，这里只补默认值兜住「D1 不可用」那种
  // 压根没查到的情况。
  const migrationsCheck: HealthReport['checks']['migrations'] = migrations.ok
    ? migrations
    : {
        ...migrations,
        table: MIGRATIONS_TABLE,
        applied: (migrations.applied as string[] | undefined) ?? [],
        pending: (migrations.pending as string[] | undefined) ?? [],
      }

  // 写探针用 gate 表：settings 会被 allSettings() 全表枚举，塞探针键会
  // 污染 /admin/settings；gate 无此问题。
  // 用独立的键，不能和队列哨兵共用——写探针会删掉自己那行，
  // 共用就会在队列探针读 ack 状态之前把记录抹掉。
  const write = schemaCheck.ok
    ? await probe(async () => {
        await withTimeout(
          db
            .prepare(
              `INSERT INTO gate (provider, next_at, fails) VALUES (?, 0, 0)
               ON CONFLICT(provider) DO UPDATE SET fails = fails`,
            )
            .bind(WRITE_PROBE_KEY)
            .run(),
          PROBE_TIMEOUT_MS,
        )
        // 撞到已存在的行时上面是空写，不改动任何真实数据，只验证写权限
        await withTimeout(
          db.prepare('DELETE FROM gate WHERE provider = ?').bind(WRITE_PROBE_KEY).run(),
          PROBE_TIMEOUT_MS,
        )
        return {}
      })
    : fail('schema incomplete')

  const queueDisabled: HealthReport['checks']['queue'] = {
    ok: false,
    ms: 0,
    binding: 'REFRESH',
    sent: false,
    acked: null,
    probeSentAt: null,
    error: 'skipped: queue probe disabled',
  }

  const queue = options.probeQueue === false
    ? queueDisabled
    : await probe(async () => {
        // 生成类型里 REFRESH 是必有的，但 wrangler.jsonc 改坏后 types 可能
        // 是陈旧的，所以运行时仍然显式判一次
        const producer = env.REFRESH as Queue | undefined
        if (producer === undefined || producer === null) {
          throw new Error('REFRESH producer binding missing (wrangler.jsonc queues.producers)')
        }
        if (typeof producer.send !== 'function') {
          throw new Error('REFRESH binding present but send is not callable')
        }

        const sentAt = Date.now()

        // 单行状态机，靠 next_at 的正负号区分「已发」与「已 ack」：
        //   行不存在    → 从未探测过          → acked: null
        //   next_at > 0 → 发出后没人确认      → acked: false
        //   next_at < 0 → consumer 已回写确认 → acked: true
        // 消费端用负号而不是删行，是因为「行不存在」同时表达了「从没发过」和
        // 「已 ack」，两者无法区分，acked 就永远是 null。
        //
        // 长时间没人轮询时（observedAt 超过 10 分钟）一律回落 null：
        // 那是「没人在看」，不是「consumer 死了」，不该报警。
        const prior = await withTimeout(
          db
            .prepare('SELECT next_at FROM gate WHERE provider = ?')
            .bind(PROBE_PROVIDER)
            .first<{ next_at: number }>(),
          PROBE_TIMEOUT_MS,
        )
        const acked = prior == null ? null : prior.next_at < 0
        const observedAt = prior == null ? null : Math.abs(prior.next_at)
        const stale = observedAt !== null && Date.now() - observedAt > ACK_STALE_MS

        // 刻意不走 enqueueRefresh：它开头会 consumeQueueSlot 扣 D1 额度、
        // 并被队列软上限（默认 2700）挡掉，健康探针不该消耗生产额度。
        // 写正数 = 「本轮已发，等确认」
        await withTimeout(
          db
            .prepare(
              `INSERT INTO gate (provider, next_at, fails) VALUES (?, ?, 0)
               ON CONFLICT(provider) DO UPDATE SET next_at = excluded.next_at`,
            )
            .bind(PROBE_PROVIDER, sentAt)
            .run(),
          PROBE_TIMEOUT_MS,
        )
        // 时间戳进消息体，消费端拿它做 CAS 回写，不会把更新的一轮的标记盖掉
        await withTimeout(
          producer.send({ v: 1, k: PROBE_PROVIDER, p: PROBE_PROVIDER, t: `probe:${sentAt}` }),
          PROBE_TIMEOUT_MS,
        )

        return {
          binding: 'REFRESH',
          sent: true,
          acked: stale ? null : acked,
          probeSentAt: sentAt,
        }
      })
  const queueCheck: HealthReport['checks']['queue'] = queue.ok
    ? queue
    : {
        ...queue,
        binding: 'REFRESH',
        sent: false,
        acked: null,
        probeSentAt: null,
      }

  // queue 只告警不报 503：绑定缺失/consumer 停摆时站点其余功能仍完全可用，
  // 外部平台也拿 /healthz 当存活探针，让非致命依赖决定 503 会双重告警。
  // consumer 真停摆时，首次真实入队会以 503 + X-Queue: unavailable 立刻暴露。
  const warnings: string[] = []
  if (options.probeQueue !== false) {
    if (!queueCheck.ok) warnings.push('queue')
    else if (queueCheck.acked === false) warnings.push('queue-consumer')
  }

  const ok = connect.ok && schemaCheck.ok && migrationsCheck.ok && write.ok
  return {
    status: ok ? 'ok' : 'degraded',
    d1: true,
    schema: schemaCheck.ok,
    warnings,
    checks: {
      connect,
      schema: schemaCheck,
      migrations: migrationsCheck,
      write,
      queue: queueCheck,
    },
    ms: Date.now() - started,
    ts: new Date().toISOString(),
  }
}
