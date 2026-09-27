# 设计决策

记录 v1→v6 演进过程中定下来的取舍，以及为什么。
P2 之后新增的两条（transform 钩子、archive 档）单列在文末。

## v1：单 Worker，禁止绑定膨胀

**决策**：一个 Worker 同时承担 API、静态文档、Queue 消费、Cron。
绑定只允许 D1(`DB`)、Queues(`REFRESH`)、`caches.default`、secret(`ADMIN_TOKEN`)。

**理由**：免费额度的 CPU（10ms/次）和请求数（10万/天）都很紧，多一个跳转就多一份延迟和额度。
文档用 Static Assets 直出，连 Worker 都不经过。

**否决**：KV（读次数另算、D1 已经有）、R2（没必要存小 JSON）、
Durable Objects（免费额度限制严格）、Service Bindings、Vectorize、Containers、`nodejs_compat`。

## v2：成功不带信封

**决策**：成功响应是裸业务对象，失败才是 `{code, message, details?}`。

**理由**：对齐 uapis 规范。调用方 `res.hits` 直接可用，不用先解一层 `data`。
失败路径需要可诊断，所以保留 `details`；成功路径不需要额外信息。

## v3：T1 + T2 双层缓存

**决策**：T1 = Cache API（边缘，免费），T2 = D1（一次行读）。
命中不写 D1，T1 命中不回填 T2。

**理由**：D1 免费额度是 500万行读/天 + 10万行写/天。热门 key 走 T1 就不占 D1 读；
命中不写是为了把 10万行写全部留给"回源成功"和"Cron 清理"。

**代价**：T1 命中不加速 T2 预热，某个 key 第一次请求仍然要付一次上游成本。可接受。

## v4：passthrough 端点零解析

**决策**：上游 JSON 原样透传，只改 `content-type`，不 `JSON.parse` 再 `stringify`。

**理由**：10ms CPU 是硬边界。透传端点的 CPU 接近 0，把额度留给错误处理、队列和管理面。
代价是无法统一重塑字段——这是有意的克制。

**实现**：D1 里 `encoding` 列，`>1024B` 才 gzip；小于 1KB 存原文，压缩的 CPU/空间不划算。

## v5：三层限速

**决策**：入口固定窗口（内存）→ provider 最小间隔（D1 `gate`）→ 每日额度（D1 `quota`）。

**理由**：三种约束互不重叠。入口限流防单点滥用，provider 闸门保护上游，
每日额度保证"一天最多打上游 N 次"。分开之后每层都能单独调，
`gate.min_ms` 一个设置就能整体放宽或收紧。

**注意**：入口限流用 `cf-connecting-ip` 存在隔离实例内存里，不落 D1（省写额度，也避免成为追踪标识）。

## v6：可观测 + 可干预

**决策**：元数据端点（`/status`、`/openapi.json`、`/llms.txt`、`/healthz`）+ 管理面（`/admin/*`）。

**理由**：
- `/status` 把免费额度边界和当前用量都写出来，可以直接挂监控。
- `/openapi.json` 从 registry 生成，代码改了文档就跟着改，不会漂移。
- `/admin/rebuild`、`/admin/kill`、`/admin/maintenance`、`/admin/prune` 让线上出问题能立刻处置，
  而不是改代码重新部署。
- 管理接口用 Bearer secret、常量时间比较，读取设置时凭据脱敏。

## transform 钩子：非透传源的出口（P2）

**决策**：`ProviderRuntime.transform(raw, target)` 可选实现，只对 `passthrough: false`
的端点调用，且在**落库之前**执行。

**理由**：v4 的零解析是默认，不是教条。arXiv 只给 Atom XML，调用方要 JSON。
把转换点放在 `refreshTarget` 里、写库之前，缓存里存的就已经是本项目的输出形态——
读路径（`pipeline.serveResource`）因此完全不需要知道转换这回事，
T1/T2 命中都是零解析，和透传源走同一条路。

**否决**：引入 XML 库（+30KB 且要处理实体/DTD 的攻击面）。
只认 arXiv `api/query` 的固定结构，用有界正则抽字段，
`costMs = 2` 写进 registry，`/status` 与 OpenAPI 都能看到。
上游哪天改结构，这里才会失效——那时再换库不迟。

## archive 档：上游要求长缓存时（P2）

**决策**：新增 `archive` 资源档（新鲜期 900s、stale 1 天），只给上游明确要求长缓存的源。

**理由**：TTL 表是"按语义选档"，但有些源的语义之外还有硬性要求。
arXiv 官方要求调用方把结果缓存至少 15 分钟，这是 ToS 的一部分，
不是我们能自行放宽的。给它单独一档而不是把 `search` 整体调慢，
是为了不连累 HN/SE/GitHub 这些确实需要短缓存的端点。

## 负缓存：6 小时

**决策**：上游错误原样记 6 小时（`cache.negative_ttl`），命中时回放状态码和响应体。

**理由**：上游挂了的时候，每个 miss 都去重试只会让它更难恢复，也让 D1 行读爆掉。
6 小时是可调的，遇到"上游刚恢复"的场景用 `POST /admin/rebuild` 手动重建。

**注意**：回放的是**我们生成的**错误信封，不是上游原文，所以不会泄露上游内部信息。

## stale-while-revalidate

**决策**：超出新鲜期但在 stale 窗口内，先返回旧值，用 `waitUntil` 后台刷新。

**理由**：慢响应比稍微旧的数据更影响体验。`X-Cache: STALE` 明确告诉调用方这是旧值。
回源失败时返回 `STALE-FALLBACK`，仍然不返回错误。

## 白名单参数而非静默忽略

**决策**：未在 endpoint 声明的 query 参数直接 `400 INVALID_PARAMETER`，`details.allowed` 列出白名单。

**理由**：静默忽略会让调用方以为参数生效了，然后去 debug 一个不存在的 bug。
快速失败比假装成功友好。

## 队列而不是直接回源

**决策**：miss 时默认内联同步回源（`cache.inline=on`），也可以关掉改成纯队列。
内联成功返回 `REFRESH`，关掉后返回 `QUEUED` + `Retry-After`，加 `Prefer: respond-async` 则返回 `202`。

**理由**：内联回源对单用户场景体验最好（一次请求拿到数据）。但会同步消耗 CPU 和请求时长。
关掉之后 miss 请求几乎不耗 CPU，适合"扫全站"这类批量抓取。

**预算**：队列日限 3000、软限 2700，相对 10000 ops/天 留了 3 倍余量。
队列消费用 `batch_size=1`，一条消息一个 key，天然互不冲突，也不用处理同 key 竞争。

## 预热 Cron

**决策**：`*/30 * * * *` 刷 `warm.list` 里的 key，`7 */2 * * *` 清理过期行（每批 300 行）。

**理由**：分钟级偏移避免所有部署撞在整点；清理批量限制保护 D1 写额度。
预热让常用 key 在用户到达之前就已经在缓存里。

## compatibility_date 2026-08-01

**决策**：`compatibility_date` 固定在 `2026-08-01`，而不是最新的日期。

**理由**：本地测试用的 `@cloudflare/vitest-pool-workers` 内置 workerd 只支持到 2026-08-22。
选一个双方都支持的日期，测试和生产行为一致。升级测试依赖时可以一起往前推。

## 不用 `fetchMock`

**决策**：测试出站拦截用 `@msw/cloudflare` 的 `setupNetwork()`，配合
`exports.default.fetch()`（而不是 `SELF.fetch`）。

**理由**：`@cloudflare/vitest-pool-workers` 0.22 已经移除 `fetchMock`；
`SELF` 走辅助 worker，全局 mock 不一定生效。`exports.default.fetch` 在同一 isolate 里跑，
MSW 的 fetch 拦截直接生效，测试全离线。
