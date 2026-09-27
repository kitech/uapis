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

## tier C 永不内联

**决策**：走付费代理通道的端点一律 `inline: false`，`validateRegistry()` 强制检查。

**理由**：内联回源发生在同步请求路径上，那里没有额度节流——一次突发（或一个爬虫）
就能把当天的 ZenRows credits 打光，而且没有任何地方能事后统计是谁打的。
改成入队后，消费侧有闸门和 `quota.proxy.*` 双重保护，
miss 请求本身几乎不花钱。代价是首次请求拿不到数据（`503 REBUILDING`），对墙内容可以接受。

## 目标 host 与出口 host 分开声明

**决策**：`ProviderDef.hosts` 是"这个 provider 允许接触的目标 host"（用来校验 `proxy.host`），
`egressHosts` 是"真正出网的 host"，`validateRegistry()` 按后者查白名单。

**理由**：tier C 的目标 host（如 `www.economist.com`）我们从不直连，
把目标 host 放进 `upstream.allowlist` 等于给了一条"万一哪天有个 bug 就能直连"的路。
按出口校验之后，白名单里只有代理服务自己，SSRF 面反而更小。

## 多段路径参数显式声明

**决策**：`ParamDef.multiSegment` 为真时，路由生成为 Hono 的 `:name{.+}`。

**理由**：Hono 的 `:name` 只吃一段，`economist/article/finance/2026/01/01/slug` 会 404。
与其在路由里写特例，不如让参数自己声明形态；代价是这类参数要自己校验
（`.`、`..`、query 注入），路由层只保证非空。

## 额度类错误不重试

**决策**：队列消费只对 503/504 重试，且 `QUOTA_EXHAUSTED`、`PROVIDER_UNCONFIGURED`
即使状态码是 503 也直接丢弃。

**理由**：这两个错误重试不会变好——额度不会随时间自己长回来，通道也不会自己被配好。
在 tier C 上尤其明显：重试 3 次等于把当天的 credits 白烧两次。

## 缓存键要带 op，且 id 不许小写化

**决策**：`buildCacheKey()` 的键形态是 `v3:<provider>:<resource>:<op>:<id>:<queryHash>`，
`sanitizeId()` 不再 `toLowerCase()`。

**理由**：P4 接 lobsters 时踩到两个真实的键冲突。
一是既无路径参数又无 query 的端点 `id` 都是空串（落到 `root`），
`lobsters/hot` 与 `lobsters/newest` 于是共用一个条目——请求 `newest` 直接吐 `hot` 的内容，
`X-Cache: HIT` 看起来一切正常，只有比对响应体才发现。
二是 `sanitizeId` 顺手小写化，而 `target.ts` 明确写着 id 保留大小写（有的站点 handle 大小写敏感），
于是 `tag/Rust` 命中了 `tag/rust` 的条目。
两次修复合起来就是加 `op` 段 + 保留大小写，键版本一次性从 v1 跳到 v3，
旧条目自然过期、不会和新键混用。
教训：缓存键必须由「provider + 端点 + 参数」三者唯一确定，
少一段都会在端点变多之后才炸。

## 上游 URL 的 4xx 要在上游之前就拒

**决策**：路径与枚举类参数在 `buildPlan()` 里用正则/枚举校验，
不合法直接 400，不发请求。

**理由**：白名单化不是为了省流量，是为了不让调用方用参数拼出别的 URL
（`term=a=b`、`filter=a&b`、DOI 里的 `..` 都能拼出意料之外的请求或路径）。
校验放在 `buildPlan()` 里还有个好处：额度扣减发生在它之后，
非法参数永远不消耗 credits。

## 超过 512KB 的上游响应要 transform，不是照搬

**决策**：单响应超过 512KB 上限的端点做裁剪 transform（PyPI `project`），
或者干脆不提供（npm packument、PyPI simple index、PubMed efetch）。

**理由**：P5 接入前逐个 curl 量过体积，结论很直接——
`numpy` 的 `/json` 1.6MB、npm abbreviated packument 的 `react` 2.9MB、
PyPI simple index 单个包 100KB+ HTML。这类响应有三重伤害：
一是超上限直接 413，等于端点不可用；
二是就算放开上限，一个热门包的完整文档就会把 D1 行写和免费额度打满，
而调用方真正要的往往只是"当前版本 + 文件列表"；
三是 HTML/MEDLINE 文本要引正则解析器，解析器的 bug 会直接变成脏数据。
所以 `pypi/project` 只保留选定 `info` 字段，把 `releases` 折叠成 `versions` 数组
（历史版本仍有 `pypi/release/{package}/{version}` 可查），README 全文不存。
packument 和 simple index 这类"整包元数据"则直接不提供：
`react` 2.9MB 的 abbreviated 文档不是"稍微裁一下"能解决的。

## 上游用 200 报错时要在 runtime 里挡掉

**决策**：PubMed 的空 `term` 与非法 PMID 一律在 `buildPlan()` 里 400。

**理由**：NCBI 对这两种输入都返回 **HTTP 200** 加一个错误体
（`"Empty term and query_key - nothing todo"`、`{"error":"Invalid uid ..."}`）。
本项目的错误映射只看状态码，200 就当成功——于是错误体会被 transform、落库、缓存，
之后所有命中这个键的请求都拿到那句 "nothing todo"，而且因为带 `X-Cache: HIT` 看起来完全正常。
这和 P4 修的缓存键冲突是同一类问题：脏数据一旦落库就很难被发现。
教训：接入新源时要专门看"错误长什么样"，而不只是"成功长什么样"。

## 测试里队列消费者也会真的回源

**决策**：P5 补测时发现 `关闭内联回源后走队列` 那个用例会让队列消费者真的去回源
`hackernews/item/999`，而 MSW 没有 `/api/v1/items/:id` 的 handler，
于是这一次真实网络请求耗时约 5s（`max_batch_timeout: 5`），
把后续每一个用例都顶到 5s 超时。修法是补 handler，不是放宽超时。

**理由**：`vitest-pool-workers` 里 `REFRESH.send()` 会被测试环境自动投递给
worker 的 `queue()` 处理器，测试并没有"不下游"这个默认行为。
一个漏掉的 handler 就会让整套测试变慢 4 倍并随机变红，
而且慢的是和它无关的用例——排查成本很高。
教训：入队类用例要么显式 mock 掉消费者会碰的上游，要么用 `getQueueResult()` 把消息消费掉；
新增 provider 时，凡是被入队用例引用到的路径都要有 handler。

## 每个直连源也有硬额度

**决策**：每次真正回源都扣 `quota.<provider>.default`，打满即 503；
`missingQuotaDefaults()` 强制每个非 tier C provider 都有这个键。

**理由**：额度一开始只是"配额声明"——付费通道（`quota.proxy.*`）每次回源真扣，
零 key 源只有闸门 + 缓存命中率兜着。闸门管的是速率、管不住总量：
一个爬虫用 60 次/分钟的合法速率，7 小时就能把 arXiv 的 4000 次/天打光，
而上游是按 IP 计费的共享资源，打穿了是整个 IP 段一起被限。
既然免费额度边界本来就写在 `/status` 的 `free_tier_budget` 里，
就该有一个真的会响的闸门对应它。

代价是明确的：突发流量下会直接 503 而不是"尽力返回"。
这个取舍是故意的——本项目的定位是"可缓存的元数据快照"，
不是"任何时候都给你兜底的抓取服务"，所以宁可明确报错也不静默超额。

## 探测脚本自己把源挡在门外过一次

**决策**：探测新上游必须带**项目真实的 User-Agent**（`uapis/1.0 (+SITE_URL)`），
不写进凭据但也不许脚本偷懒用 curl 默认 UA。

**理由**：审计文档里长期记着一条"crates.io 403（UA 拦截）"，差点把这个源划掉。
带 UA 重测一次就通了——403 从来不是 crates.io 的策略，是 crates.io 对
"没有自我介绍的匿名脚本"的礼貌拒绝，而我们的项目本来就带着可识别 UA。
同一次探测还发现两个一直标着"网络不通"的 host（`gitlab.com`、
`earthquake.usgs.gov`）其实完全正常，**不通过的原因是没被列进探测清单**。

代价是探测结论只能当线索，不能当结论：写进审计文档的每条"能通/不通/多大"，
都得是带项目 UA 实测出来的具体数字（字节数、耗时、状态码），
不能是"印象里它是个 REST API"。

## 同一个 transform 结论要用最坏情况验证

**决策**：凡是"上游体积不可控所以做 transform"的端点，transform 完的体积要用
**体积最大的那个真实样本**验证，而不是随手挑一个常见样本。

**理由**：crates.io 的 `crate` 端点用 serde 验证是 441KB → 77KB，看着很安全；
但体积最大的其实是 `windows-sys`（上游 506KB，只剩 23 个版本——每个版本的
`features` 映射大得离谱），它已经**贴着 512KB 上限**。
换个样本才发现"版本多"不是体积的主因，"单个版本字段肥"才是。
同理 `rand`（139KB → 24KB）验证了折叠比例在 17% 左右是稳定的。

transform 的收益不来自"平均值好看"，来自**最坏情况不再破上限**，
所以验证样本必须选最坏的那个。
