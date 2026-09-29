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
   `providers[].configured`。
4. `X-RateLimit-Remaining: 0` 就是入口限流，不是上游问题。

## 常见问题

**`503 STORAGE_UNAVAILABLE`，message 里是 `no such table: xxx`？**
数据库存在但表没建。最常见的原因是首次部署漏了迁移——`wrangler deploy` 会自动开通
D1，但不会自动建表。跑 `npm run db:migrate`（`npm run deploy` 现在已经自动带上这一步，
只在「部署成功但迁移没跟上」时才需要手工补）。
`/healthz` 的 `schema` 字段会提前告诉你这件事：`schema: false` 就是没建齐。

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
某个区块读 D1 失败了（`quota` / `gate` / `queue` / `cache` / `credits:<provider>`），
对应字段已回落中性值，`/status` 本身不会因为它 500。`settings` 和 `stats` 的降级
不写进 `degraded`，它们分别由 `setting_fallback` / `stats_read_failed` 计数器暴露。

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
