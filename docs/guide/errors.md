# 错误与排障

## 错误信封

失败时统一返回：

```json
{
  "code": "UPSTREAM_ERROR",
  "message": "upstream hackernews responded 503",
  "details": { "provider": "hackernews", "upstream_status": 503 }
}
```

`details` 始终是可读的诊断信息，不含任何凭据。上游 4xx/5xx 会被映射成统一语义，
响应体是重新生成的（不直接回放上游原文），只有负缓存命中时才原样回放。

## 错误码表

| code | HTTP | 含义 | 客户端动作 |
| --- | --- | --- | --- |
| `INVALID_ARGUMENT` | 400 | 请求整体不合法 | 修请求 |
| `INVALID_PARAMETER` | 400 | 参数名未声明 / 类型错 / 越界 | 看 `details.allowed` / `details.maximum` |
| `UNAUTHORIZED` | 401 | 管理接口缺 token 或 token 错 | 补 `Authorization: Bearer` |
| `FORBIDDEN` | 403 | 已知身份但不允许 | 检查 scope |
| `NOT_FOUND` | 404 | 路由不存在或上游 404 | 检查路径 |
| `NO_MATCH` | 404 | 预留码，当前没有任何路径返回它（无结果一律 `NOT_FOUND`） | — |
| `FILE_TOO_LARGE` | 413 | 上游响应超过 512KB 上限（`MAX_UPSTREAM_BYTES`） | 用更精确的查询 |
| `RATE_LIMITED` | 429 / 503 | 入口限流（429）或 provider 闸门冷却（503） | 看 `Retry-After` / `details.retry_in` |
| `INTERNAL_ERROR` | 500 | Worker 内部异常，`details.request_id` 与响应头一致 | 带上 `request_id` 反馈 |
| `UPSTREAM_ERROR` | 502 | 上游 5xx | 稍后重试，会命中负缓存 |
| `PROVIDER_UNCONFIGURED` | 503 | 缺 key，或付费通道一个都没配 | 配 `details.setting` 指定的设置项；tier C 看 `details.any_of`，配其中任意一个 |
| `QUOTA_EXHAUSTED` | 503 | 今日队列/上游额度用尽（`quota.<provider>.default` 或 `quota.proxy.*`） | 等 UTC 日切或调大额度；`details.provider` / `details.channel` 说明是哪个桶 |
| `REBUILDING` | 503 | 已入队但还没有数据 | 按 `Retry-After` 重试 |
| `SERVICE_UNAVAILABLE` | 503 | 只读/维护模式且无缓存可返回；也用于队列 send 失败（`X-Queue: unavailable`） | 看 `details.mode`；只读模式下**已有缓存照常返回**，503 只出现在完全没有缓存时 |
| `STORAGE_UNAVAILABLE` | 503 | D1 读写失败，`message` 是 D1 原始错误（沿 cause 链拼出，通常形如 `D1_ERROR: no such table: cache`） | 不返回 `Retry-After`；`no such table` 就是漏了 `npm run db:migrate` |
| `UPSTREAM_TIMEOUT` | 504 | 上游超时（含"连上了但正文没到"） | 缩小查询范围 |
| `ACCEPTED` | 202 | 配合 `Prefer: respond-async`，已入队 | 轮询同一路径 |

> `STORAGE_UNAVAILABLE` 会把 D1 的原始错误文本（含表名/列名）透传给客户端。
> 这是自建实例下的有意取舍：报错可定位性优先于隐藏内部结构。

## 排障顺序

1. 看 `X-Request-ID`，把同一个值带进日志搜索。
2. 看 `X-Cache`：
   - `HIT`/`HIT-T1` → 不是缓存问题
   - `STALE` → 返回的是旧值，后台正在刷新
   - `STALE-FALLBACK` → 旧值已超出 stale 窗口，只在回源失败时当兜底
   - `NEGATIVE` → 上游之前失败过，6 小时内不再回源，等 TTL 或 `POST /admin/rebuild`
   - `QUEUED` → 内联回源关着，或者在队列额度里
3. `/status` 看 `gate`（哪个 provider 冷却中）、`queue.used`、`cache.rows`、
   `providers[].configured`，以及 `schema` 区块（缺表/缺列直接列名字）。
4. `X-RateLimit-Remaining: 0` 就是入口限流，不是上游问题。

## 常见问题

**`503 STORAGE_UNAVAILABLE`，message 里是 `no such table: xxx`？**
数据库存在但表没建。`wrangler deploy` 只自动开通 D1，**不建表**。
本项目的 Worker 会自己补：请求中间件、cron 和 `/healthz` 三处都会在检测到缺表时
跑 `ensureSchema()`（`src/core/bootstrap.ts`），所以多数情况下重试一次就恢复。
仍然报错说明自举失败，去 Workers Logs 找 `schema_bootstrap_failed`
（D1 不可用，或结构探测连三级全挂）或 `schema_bootstrap_refused`
（有迁移被标为非幂等拒绝自动执行，或 `column verification unavailable`）。
后者要手工走 `npm run db:migrate`。

> **`schema_bootstrap_failed` 里出现过 `SQLITE_AUTH`？** D1 的 authorizer 拒绝了
> `pragma_table_info(m.name)`——`m.name` 是列引用即动态表名，authorizer 解析不出
> 要授权哪张表。现在探测会自动降到 `pragma_table_info('字面量')`，
> `/healthz` 的 `checks.schema.tier` 会告诉你实际生效的是哪一级。
> 如果连降级也失败（`probe_tier` 是 `master_only`），说明表和索引可信但
> **列没能校验**，此时 `columnsChecked: false`、自举不记记忆、每次都重查 ——
> 这是设计如此，宁可多查也不能把「没验证过」记成「验证过」。

**`/healthz` 的五段探针怎么读？**
`/healthz` 公开返回完整诊断，不需要任何凭据：

| 字段 | 含义 | 影响 503？ |
| --- | --- | --- |
| `d1` | 能不能执行查询 | 是 |
| `schema` | 表、列、索引是否与契约一致 | 是 |
| `checks.connect` | D1 连通性 | 是 |
| `checks.schema.diff` | 缺哪张表 / 哪一列 / 哪个索引。**探测失败时为 `null`** | 是 |
| `checks.schema.tier` | 实际生效的结构探测层级：`join` / `per_table` / `master_only` | — |
| `checks.schema.diff.columnsChecked` | 列到底校验了没有。`false` = 查不到，不等于「没缺」 | 是 |
| `checks.migrations.pending` | 有迁移没记账 | 是 |
| `checks.write` | 真实写权限（插入+删除一行） | 是 |
| `checks.queue` | producer 绑定 + 消费者是否确认过探针 | **否** |
| `warnings` | 非致命降级 | 否 |

五点值得单独记：

- **只看表名不够。** `0001_init.sql` 全是 `CREATE ... IF NOT EXISTS`，改过已应用的
  迁移再重跑，wrangler 认为「无待应用迁移」，表名齐全但列对不上。所以探针逐列比对
  `src/core/schema-contract.ts` 里的契约。
- **D1 不可用不会被误报成 schema 不全。** 连接探针和 schema 探针分开判定：
  前者失败时后者标 `skipped: connect failed`，且 **`diff` 是 `null` 而不是空对象**。
  空 diff 在 JSON 里和「什么都没缺」完全一样，按 `missingTables.length === 0`
  判绿的看板会把空库显示成正常 —— 这就是踩过的坑。
- **列查不到时不会假装查过。** D1 的 authorizer 不放行
  `pragma_table_info(m.name)`（动态表名引用），所以探测分三级降级，详见
  `docs/guide/deployment.md` 的「结构探测是三级的」。落到 `master_only` 时
  `columnsChecked: false`，`missingColumns` 虽是空对象但**不作数**，
  自举也不会把这个状态记进 isolate 记忆。
- **migrations 段只把「表不存在」当作未迁移。** 超时、鉴权、限额都是故障，
  会如实报出来 —— 之前它们被吞成 `applied: []`，于是 D1 故障被说成
  「你忘了跑 `db:migrate`」，运维会去跑一条根本没用的命令。
- **队列坏了不会让 `/healthz` 503。** 绑定缺失或消费者停摆只进 `warnings`
  （分别是 `queue` 和 `queue-consumer`），因为站点其余功能仍完全可用，而外部平台
  常拿 `/healthz` 当存活探针。消费者真停摆时，第一次真实入队会以
  `503 SERVICE_UNAVAILABLE` + `X-Queue: unavailable` 立刻暴露。

**`/healthz` 会写行，而且是无鉴权的。** 每次调用 4 行写入（write 探针 2 行 +
queue 探针 2 行）。基线 6.4 万 + 上限 10 万 ⇒ 每天只剩约 9000 次调用余量，
超过 10 秒一轮的轮询就会打穿当天额度，届时站点写不了缓存直到 UTC 00:00。
公开部署前请先加服务端节流，预算推导见 `docs/guide/deployment.md`。

**`checks.queue.acked` 的三态**：行不存在 = 从未探测过（`null`）；`next_at` 为正 =
发出后没人确认（`false`，进 warnings）；为负 = 消费者已确认（`true`）。
消费端用 CAS 回写（`WHERE next_at = 本轮时间戳`），所以迟到的消息不会把更新一轮的
标记盖掉。超过 10 分钟没人轮询一律回落 `null`——那是「没人在看」，不是「消费者死了」。

`/status` 里也有一个 `schema` 区块，给出同样的结论，但**不跑队列探针**
（那会每看一次页面就发一条队列消息）。它补的是 `gate`/`stats`/`settings` 的盲区：
这三者的原始错误只进 Workers Logs，不经过响应体。

**额度看起来一直在涨，但 D1 明明挂了？**
不会了。`consumeCredits` / `consumeQueueSlot` / `readRow` 以前在 D1 故障时分别返回
`false` / `false` / `0`——前两个被报成 `QUOTA_EXHAUSTED`（原因完全错），
第三个让额度统计永远显示「今天没用过」。现在这些情况都会抛错并计入
`error:STORAGE_UNAVAILABLE`，队列消费侧按可重试处理。

**D1 挂了会不会无限回源烧掉付费通道的额度？**
不会。`refreshTarget` 里 `consumeCredits` 在真正 fetch 之前（`refresh.ts`），
记账失败直接抛错，请求根本走不到上游。速率闸 `checkGate` 也不再在 D1 故障时
静默 `allowed: true`——那正是以前会烧穿额度的地方。

**`/status` 顶部 `degraded` 非空说明什么？**
某个区块读 D1 失败了（`quota` / `gate` / `queue` / `cache` / `schema` /
`credits:<provider>`），对应字段已回落中性值，`/status` 本身不会因为它 500。
`settings` 和 `stats` 的降级不写进 `degraded`，它们分别由 `setting_fallback` /
`stats_read_failed` 计数器暴露——现在 `schema` 区块补上了这个盲区，
缺哪张表会直接列出来。

**为什么队列坏了是 `SERVICE_UNAVAILABLE` 而不是 `QUOTA_EXHAUSTED`？**
两者是完全不同的故障：前者是队列 send 失败（`X-Queue: unavailable`），
后者是今日额度真的用尽。早期版本把两者混在一起报，还带 `Retry-After: 3600`，
会让客户端白等一整天。

**为什么第一次是 `REFRESH` 第二次才是 `HIT`？**
`REFRESH` 表示本次同步回源并写了缓存，这是设计行为。

**`503 RATE_LIMITED` 但我只有一个请求？**
provider 闸门是按 provider 全局的最小间隔（registry 里 200–6000ms：GitHub 6000ms 对齐
search 的 10 次/分钟，arXiv 3000ms，MusicBrainz / Open-Meteo 1000ms，其余 200–500ms）。
别的请求刚刷新过同一个 provider，你的请求就进冷却了。可以在测试/自用场景把
`gate.min_ms` 调小（空值 = 用 registry 里的值）。

**tier C 源报 `PROVIDER_UNCONFIGURED`，`details` 里没有 `setting` 只有 `any_of`？**
对，tier C 没有单一 key：ZenRows / Jina 任一可用即可。
`any_of: ["zenrows.key","jina.key"]` 是"配其中任意一个"的意思，配好之后
`/status` 的 `providers[].channels` 会显示哪条通道生效、还剩多少 credits。

**付费墙源第一次请求是 `503 REBUILDING`？**
tier C 端点不内联回源（`inline: false`）：同步路径没有额度节流，
一次突发就能把当天的付费 credits 打光。请求只入队，
加 `Prefer: respond-async` 会返回 `202 ACCEPTED`，队列消费完再读就是 `HIT`。

**`INVALID_PARAMETER` 里 `allowed` 是什么？**
当前端点声明的白名单参数名。白名单之外的参数一律 400，不做静默忽略——
静默忽略会让用户误以为参数生效了。

**改了 `/admin/settings` 但行为没变？**
设置在隔离实例内记忆化 30 秒，跨实例最长 30 秒生效。

**`502` 之后一直 `502`？**
负缓存。看 `POST /admin/rebuild` 手动重建，或把 `cache.negative_ttl` 调小。

**Cron 会不会把热数据删掉？**
不会。Cron 只删 `expires_at < now` 的行，每批 300 行；stale 窗口内的数据不会被删，
回源失败时还能作为兜底返回。
