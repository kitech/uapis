# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 风格，版本号遵循语义化版本。

## [Unreleased]

### Added

- **表结构改由 Worker 代码自举**（`src/core/bootstrap.ts` 的 `ensureSchema`）：
  挂在请求中间件、cron 和 `/healthz` 三个触发点上，检测到缺表就把 schema 装好。
  部署后第一个请求即建表，不再需要任何手工迁移步骤
- 自举只自动应用**幂等**迁移：`0001_init.sql` 全是 `CREATE ... IF NOT EXISTS`
  可以自动跑；`ALTER TABLE ADD COLUMN` 之类标 `idempotent: false` 后**一律**拒绝
  自动执行（条件不是「没记账」而是「永不自动跑」），仍走 `npm run db:migrate`
- 自举冷路径做完整契约比对（表 + 列 + 索引），缺表/缺索引就重跑幂等 DDL 补上并
  **复测**；只缺列时明确拒绝硬补并指路 `npm run db:migrate`——`CREATE TABLE IF NOT EXISTS`
  对已存在的表是空操作，唯一的补法又是非幂等的
- 稳态下自举每个 isolate 只查一次 D1（模块级记忆）。没有这层记忆的话中间件会给
  每个请求加一次查询，一天 10 万请求就是额外 10 万次 D1 查询
- 自举的 DDL 与迁移记账放在同一个 `DB.batch()` 里（D1 的 batch 是 SQL 事务），
  中途失败整批回滚，不会留下「表建好了但没记账」的中间态；
  记账表与 wrangler 共用 `d1_migrations`，`wrangler.jsonc` 显式声明
  `migrations_table`，两边互相认账
- `/healthz` 从「表名五连探测」升级为五段串行探针，公开返回完整诊断（无需凭据）：
  `connect` / `schema`（逐表逐列逐索引比对契约）/ `migrations`（记账与待应用）
  / `write`（真实插入+删除一行）/ `queue`（producer 绑定 + 消费者 ack 往返），
  外加 `warnings` 和每段耗时。顶层 `d1` / `schema` 保留，旧监控脚本不用改
- 队列探针用 `gate` 表的哨兵行做往返：`next_at` 正数 = 本轮已发待确认，
  负数 = 消费者已确认。消费端用 CAS 回写，迟到的消息不会盖掉更新一轮的标记；
  回写失败时 retry 而不是 ack，避免残留状态误报「消费者没工作」。
  写探针用独立的键，否则它会在队列探针读 ack 状态之前把记录抹掉
- `/status` 增加 `schema` 区块：补上 `gate`/`stats`/`settings` 只进 Workers Logs
  的盲区，直接列出缺哪张表、哪一列、哪个索引、哪些迁移待应用。
  该区块不跑队列探针——那页面是给人排障打开看的，每看一次就发一条队列消息
- 部署文档：说明代码自举的三个触发点、幂等守卫、记账表一致性，
  Workers Builds 的 Deploy command 因此可以简化为 `npx wrangler deploy`
- 错误码 `STORAGE_UNAVAILABLE`（503）：D1 失败时沿 `cause` 链透传原始错误文本，
  典型形如 `D1_ERROR: no such table: cache`（顶层 `message` 在生产环境只有 `D1_ERROR`，
  真正原因都在 cause 上）
- `/status` 增加 `degraded` 数组：各 D1 区块独立降级，缺表时整页不再 500
- `/status` 的 `providers[].credits_error` / `channels[].credits_error`：
  读不到额度时给出原始错误，而不是回落成 `used: 0`
- `INTERNAL_ERROR` 响应体补 `details.request_id`，与 `X-Request-ID` 一致

### Fixed

- `consumeCredits` / `consumeQueueSlot` / `readRow` 不再吞掉 D1 异常：
  以前分别返回 `false` / `false` / `0`，前两个被报成 `QUOTA_EXHAUSTED`
  （"今日额度用尽"，还带 `Retry-After: 3600`），原因完全错误
- `checkGate` 不再在 D1 故障时返回 `allowed: true`：那会让跨实例限速静默失效、
  对上游无限回源，直接烧穿付费通道额度
- 队列 send 失败不再被报成 `QUOTA_EXHAUSTED`：现在返回 `SERVICE_UNAVAILABLE` +
  `X-Queue: unavailable`
- `mapUpstreamStatus(504)` 不再被 `>= 500` 吃掉，`UPSTREAM_TIMEOUT` 首次真正可达
- `onError` 的非 `ApiError` 分支补 `error:INTERNAL_ERROR` 计数
- `logError` 加序列化兜底，避免 `JSON.stringify` 二次抛错把原始错误吃掉
- `getSetting` / `allSettings` / `readStats` / `noteProviderFailure` 的静默兜底
  补 `setting_fallback` / `settings_read_failed` / `stats_read_failed` /
  `gate_note_failed` 计数器，故障不再无声
- `NO_MATCH` 标注为预留码，不再在文档里宣传一个不会返回的错误码
- 部署文档：核对自动开通链路（4.45.0 起默认开启；4.102.0 / PR #14275 修好按名寻址）
  并修正三处——补上「本地 `wrangler deploy` 会把真实 `database_id` 写回 `wrangler.jsonc`」
  及项目约定（首次部署后 `git checkout -- wrangler.jsonc` 退回，保持不写 ID）；解释本项目
  「先部署后迁移」与官方 deploy-button 示例相反的原因；速查表 `missing a database_id`
  一行从「升级 wrangler」改成真实成因「远端还没建库」

### Changed

- `STORAGE_UNAVAILABLE` 刻意不返回 `Retry-After`（不给客户端重试指令）
- `getSetting` 保留代码默认值兜底（不随其它 D1 读取一起改成上抛）：
  它被限流中间件和 T1 命中路径调用，上抛会把存储故障放大成全站不可用。
  故障本身由 `setting_fallback` 计数器和 `/status` 暴露
- 队列探针**不**走 `enqueueRefresh`：那条路开头就扣队列额度、且会被软上限挡掉，
  健康探针不该消耗生产额度。改为直接调 `REFRESH.send`

## [0.1.0] - 2026-09-27

P0 骨架 + P1 端点完善 + P2 零 key 源批量接入 + P3 付费代理通道 + P4 再加三个零 key 源
+ P5 包管理与文献检索三个零 key 源 + P6 开放数据与代码托管三个零 key 源 + P7 音乐元数据零 key 源
+ P8 天气与空气质量零 key 源 + P9 github Android 新星榜（并修 github search 的超时与 `per_page` 缺陷）。

### Added

- 单 Cloudflare Worker 骨架：Hono 入口同时分发 `fetch` / `scheduled` / `queue`
- 三级缓存链：Cache API(T1) → D1(T2，gzip BLOB) → Queue 回源
- stale-while-revalidate：过期数据立即返回并 `waitUntil` 入队刷新
- D1 五张表 `cache` / `settings` / `quota` / `stats` / `gate` 与首个 migration
- provider 速率闸 `gate`（按 provider 最小间隔，可被 `gate.min_ms` 覆盖）与每日额度记账 `quota`
- 统一错误体 `{code, message, details?}`、`X-Request-ID`、CORS 白名单、内存令牌桶限流
- 采样日志：仅错误全量 + 2xx 1% 采样，受 20 万 events/天约束
- 固定上游 host 白名单 `assertAllowedUpstream` 与不可覆盖 UA
- 由 provider registry 手写生成的 OpenAPI 3.1（`/openapi.json`）
- 元数据端点 `/status` `/healthz` `/llms.txt`
- 管理端点 `/admin/settings` `/admin/quota` `/admin/quota/reset` `/admin/providers` `/admin/rebuild`
  `/admin/maintenance` `/admin/kill` `/admin/gate` `/admin/prune` `/admin/cache/policies`
- 样板 provider：`stackexchange`（passthrough）与 `hackernews`（passthrough）
- P1 端点：HN `front` / `latest` / `user/{id}/posts`（feed 档，2min 新鲜期），
  SE `question/{id}/answers` / `question/{id}/comments` / `sites`
- 端点级凭据要求 `EndpointDef.auth`：`sites` 标为 `optional`，匿名可用且不注入 key
- 统一分页约定：`page`（0 起，≤10）与 `pagesize`/`hitsPerPage`（默认 20，≤100）；
  1 起计数的上游（devto、github search）保持上游习惯并在文档标注
- P2 新增 provider（tier A-，共 9 个端点）：
  - `github`：`repo/{owner}/{repo}`、`search/repositories`、`user/{login}`，
    token 走 `Authorization` 头，闸门 6000ms（search 10 次/分钟）
  - `devto`：`articles`、`article/{id}`、`user/{username}`，零 key
  - `arxiv`：`search`、`paper/{id}`，闸门 3000ms，缓存用新增的 `archive` 档
    （15min 新鲜期，满足 arXiv「结果至少缓存 15 分钟」的要求）
- 基础设施：
  - `ProviderRuntime.transform` 钩子 + `refreshTarget` 落库前转换，
    arXiv 的 Atom XML 由此转成 JSON（缓存里存的也是 JSON），零新依赖
  - 新增 `archive` 缓存档（900s/86400s）
  - 路由支持多路径参数（`owner`/`repo` 用 `/` 连接进 target.id）
  - query 参数支持 `required`，缺失直接 400
  - `/status` 新增 `auth_required` / `auth_optional`，
    端点级 optional 的 provider（如 github）不再误报 `unconfigured`
- P3 付费代理通道（tier C 机制 + 首个实现）：
  - `ProviderDef.egressHosts`：目标 host（`hosts`，只用于校验 `proxy.host`）与真正出网的
    出口 host 分开声明，白名单按出口校验，tier C 源不会把付费墙域名放进出网名单
  - `ProviderDef.requiredAnyOf`：tier C 用"任一通道可用即可"表达可配性；
    两条都空时 read 路径直接 `503 PROVIDER_UNCONFIGURED` 并在 `details.any_of` 列出该配哪个键
  - `/status` 新增 `providers[].channels`，给出每条通道的 `configured` 与 credits
  - 付费通道额度 `quota.proxy.zenrows`(33) / `quota.proxy.jina`(50)，
    取代原先无人读取的 `proxy.zenrows.daily_credits` / `proxy.logical_daily_keys`
  - credits 记账移到 `buildPlan` 之后：按 `pickChannel` 实际选中的通道扣费，
    修掉 auto 模式走 Jina 却记到 ZenRows 头上的问题
  - 队列只重试 503/504；`QUOTA_EXHAUSTED` / `PROVIDER_UNCONFIGURED` 与 buildPlan 抛出的
    4xx（如 slug 非法）直接丢弃，不白占 3 次 attempt
  - `ParamDef.multiSegment` + Hono `:name{.+}`：支持含 `/` 的路径参数
  - 新增 provider `economist`（tier C）：`article/{slug}`，wall 档（24h/7d）、
    `inline: false`（miss 只入队）、只提取标题与摘要等元数据
- P4 新增 provider（全部零 key，先 curl 实测过响应结构才写）：
  - `lobsters`（tier A）：`hot`、`newest`、`tag/{tag}`（feed 档）、`story/{id}`（item 档）；
    官方路径是 `hottest.json` / `newest.json` / `t/{tag}.json` / `s/{id}.json`，
    上游无分页（多余分页参数被忽略），故不暴露分页
  - `itunes`（tier A-）：`search`、`lookup`；`limit` 卡 200（上游上限），
    分页用 `offset` 而非 `page`，`term` 字符白名单，`media` 枚举在 runtime 校验
  - `crossref`（tier A-）：`search`（`rows` ≤ 30）、`work/{doi}`；
    DOI 走 `multiSegment`，可选 `crossref.mailto` 进 polite pool（填错当没配）
- 每日额度对直连源也生效：每次真正回源（含内联与队列）扣 `quota.<provider>.default`，
  打满即 `503 QUOTA_EXHAUSTED` + `Retry-After: 3600`；命中缓存不扣，
  非法参数（`buildPlan` 之前）不扣，额度耗尽不写负缓存
- `missingQuotaDefaults()` 自检：每个非 tier C provider 必须有正的
  `quota.<name>.default`，`0`（不限）与"忘了配"同样算漏配，单元测试会红
- `/status` 的 `providers[].credits` 现在对所有直连源给出 `used/limit/remaining`；
  tier C 仍为 `null`，真实用量看 `channels[].credits`
- P5 新增 provider（全部零 key，接入前先 curl 实测过体积与错误形态）：
  - `pypi`（tier A）：`project/{package}`（**transform**）、`release/{package}/{version}`（透传）；
    实测 `numpy` 的 `/json` 有 1.6MB 且 96% 是 `releases`，所以项目端点裁掉
    `releases`（折叠成 `versions` 数组）与 README 全文 `description`；
    包名按 PEP 503 归一化；不做 simple index
  - `npm`（tier A-）：`latest/{name}`、`version/{name}/{version}`、`search`（均透传）；
    `name` 走 `multiSegment`（scoped 包 `@types/node`），版本端点按 `@scope/` 边界切分；
    **不做 packument**（abbreviated `react` 2.9MB、`@types/node` 2.3MB，超 512KB 上限）
  - `pubmed`（tier A-）：`search`（esearch）、`summary`（esummary `version=2.0`），均透传；
    空 `term` 与非法 PMID 上游都返回 **200 + 错误体**，一律在回源前 400；
    可选 `pubmed.api_key`（3 → 10 次/秒，填错当没配，不进缓存键）；不做 efetch XML
- P6 新增 provider（全部零 key，接入前逐个 curl 实测过可达性、体积与错误形态）：
  - `usgs`（tier A，公有领域）：`earthquakes`（FDSN `/query`）、`earthquakes/{id}`，均透传 GeoJSON；
    **不用 `feed/v1.0/summary/*.geojson`**（all_hour 4.6KB → all_month 7.5MB，
    且拼错路径上游回 200 + `404 File Not Found` 纯文本），`/query` 反而可控（limit=200 → 145KB）；
    `limit` 硬卡 200；超时放宽到 8s 并关掉重试（实测 limit=200 需 4.8s）；
    `minmagnitude` 是小数而框架只校验 `integer`，格式与 0-10 区间在 runtime 兜住
  - `gitlab`（tier A-）：`projects`（搜索）、`project/{id}`、`commits`，均透传；
    只接只读公开端点；`project/{id}` 走 `multiSegment`（子组可多层），
    runtime 编成上游要的单段 `group%2Fsub%2Fproject`；`commits` 的 `project` 放 query
    避免与贪婪多段参数抢路由；匿名配额实测 500 次/分钟/IP
  - `crates`（tier A-）：`crate/{name}`（**transform**）、`crate/{name}/{version}`、`search`；
    上游要求可识别 UA（项目本就发 `uapis/1.0 (+SITE_URL)`）；
    `crate` 折叠 `versions` 的原因同 PyPI：**99% 体积在 `versions`**
    （serde 441KB / 316 版，windows-sys 上游 506KB 已贴着 512KB 上限），
    折叠后 windows-sys 506KB → 6.5KB、serde 441KB → 77KB、rand 139KB → 24KB
- P7 新增 provider（零 key，接入前逐个 curl 实测）：
  - `musicbrainz`（tier A-）：`search`（artist/release-group/release，Lucene 语法透传）、
    `artist/{mbid}`、`release-group/{mbid}`、`release/{mbid}`，均透传；
    限流是官方写在响应头里的（search 400/分钟、实体 1900/分钟），闸门 1000ms；
    **必须写死 `fmt=json`**（漏掉上游回 200 + XML）；搜索体积随查询宽度爆炸
    （`radiohead`/25 → 15KB，`a`/10 → 146KB，`a`/100 → 296KB 且 22.8s），
    所以 `limit` 硬卡 25、超时 6s、关闭重试；`inc` 只给单值枚举（逗号组合上游一律 400）；
    MBID 只收规范小写（大写回 400，理由见 design-decisions）
- P8 新增 provider（零 key，⚠️ 条款限非商业用途）：
  - `openmeteo`（tier A-）：`current`、`hourly`、`geocode`、`air-quality`，全部透传；
    实测体积最坏 20,595B（8 变量 × 16 天），离 512KB 上限差两个数量级，所以**不做 transform**
    （与 PyPI/crates 的理由正好相反）；限流只存在于条款里、响应头一个都没有
    （600/分钟、5,000/小时、10,000/天、300,000/月），绑定约束是每日 10,000 → 额度取 4000；
    本地挡掉三个"200 但零数据"的坑（不给变量、geocoding 空名；geocoding 查无此城则照常透传）；
    变量表本地校验，挡住上游把 Scala 内部类名漏进 reason 的行为；
    空气质量实测 3.3s 超过默认超时 → 该端点放宽到 8s；全部端点 `retries: 0`（重试要花日预算）
- 框架：补上 `type: 'number'` 的范围校验（`minimum`/`maximum` 曾经只对 `integer` 生效，
  而 OpenAPI 无条件把范围写进 schema，文档与运行时不一致）；不收指数记法与前导 `+`
- 修 `X-Cache-Age` 在 T1 命中时报 Unix epoch 的问题（`cache.ts` 里 T1 命中的 `fetchedAt`
  写死为 0，Cache API 不返回写入时间所以此前无从取值）：写入时多存一个 `x-uapis-fat`，
  部署前写入的老条目从 `cache-control: max-age` + `x-uapis-exp` 反推（误差在 TTL 取整内），
  两者都取不到就宁可少报也不报假年龄
- P7 收尾：musicbrainz 的 `release-group`/`release` 改用 `item` 缓存档（原来与 artist 共用 profile），
  修正无效的 ToS URL
- P9 新增 github 端点 `androidRising` → `/api/v1/github/android/rising`（"Android 新星榜"）：
  时间窗内新建、star 最高的 Android 仓库；`topic:android` 与 `sort=stars&order=desc`
  服务端写死（放开 topic 就退化成通用搜索器），调用方只给 `since`（`YYYY-MM-DD`）定时间窗
  - **为什么不用 GitHub Trending**：Trending 只有 HTML 页、没有官方 API，解析 HTML 违反本项目原则；
    用官方 search 的 `created:>+sort=stars` 构造同等语义
  - **transform 而非透传**：上游每项 82 字段、30 项 164,439B，输出只留 8 字段降到 15,246B（省 92%），
    与 pypi 丢掉 README 全文、crates 丢掉 versions 同理
  - `since` 由调用方传而非 `days`：缓存键只对请求侧白名单 query 做哈希、不含上游 URL
    （`refresh.ts` 的 `cacheKeyFor` → `ttl.ts` 的 `buildCacheKey`），服务端算的日期会漏出缓存键
  - `since` 校验形状 + 真实日期：`2026-13-45` / `2026-08-32` 本地挡住（上游一律回 422）
- **修 github search 端点的既存缺陷**：`fetcher.ts` 的 `DEFAULT_TIMEOUT_MS = 3000` 被 github
  完整继承（该 provider 此前一处 `timeoutMs` 都没设），而上游 30 条实测 4.7/1.9/3.0s（偶发 9s）
  → 现有 `/api/v1/github/search/repositories` 在默认页大小下经常超时。
  现在 search 与新端点都 `timeoutMs: 12000` + `retries: 0`
- **github search 的 `per_page` 从 100 封顶到 30**：实测 `per_page=100` 能返回 200，但体积
  557,300B 超过 `MAX_UPSTREAM_BYTES`（512KB）会被直接判超限——**理由是体积，不是超时**
- **github search 的 `sort` 补齐 `help-wanted-issues`**：官方 OpenAPI 与 `cli/cli` 都是
  stars/forks/help-wanted-issues/updated 四项，此前漏了它，调用方传该项会 400
- XDA（`xdaforums.com`）热榜**确认不接入**，证据链存入 `provider-audit.md`：
  Valnet ToS §7/§5/§3/§15 四层条款（§7 认可 RSS、§15 禁爬且明文含 User Submissions）、
  XenForo 内核无 hot 排序、域已迁 BunnyCDN、四个同类项目先例（含一个公开选择"不爬"的连接器）
- 新增 [部署上线](docs/guide/deployment.md) 文档：自架 8 步（建 D1 / 建队列 / 迁移 / 部署 /
  设 secret / 绑域名 / 配凭据 / 冒烟清单）+ 运维手册（回滚范围、Time Travel、只读模式、
  额度监控、Cron 语义、部署失败速查）。README 与 quickstart 的部署段改为链接，不再三处维护
- **`db:migrate` / `db:migrate:local` / `db:seed:local` 改用 binding `DB` 引用 D1**
  （`wrangler d1 migrations apply DB`）而不是库名 `uapis`——wrangler 的 `<database>`
  位置参数本来就同时接受 name 和 binding，改 `database_name` 或换 `database_id` 不用动脚本
- 修正文档漂移：`errors.md` 的上游体积上限 2MB → **512KB**（对齐 `MAX_UPSTREAM_BYTES`）、
  闸门"当前 300ms" → **200–6000ms 分档**；`index.md` 的 provider 表补全到 17 个
  （此前只有 6 个，github 缺 `android/rising`）；README 路线从 P5 更新到 P10
- 文档口径按官方文档校准：Free 计划可建 10 个 D1 库（不是 1 个）、Queues 消息保留
  **24 小时**（不是 4 天）、**D1 免费额度触顶是硬失败**（查询报错直到 UTC 日切，
  不是计费超支）、Workers 请求触顶返回 **Error 1027**
- 离线测试：`vitest-pool-workers` + `@msw/cloudflare` 出站拦截，240 个用例全离线
- VitePress 文档站（首页/快速上手/数据源/限流/错误/合规 + 参考页），部署到同一 Worker 的 `/docs`

### Changed

- **UA 改为全局固定 `uapis/0.1.0 (+apple.com)`，并删除 `vars.SITE_URL`**。原先 UA 尾串
  和 `/openapi.json`、`/llms.txt` 的链接都从 `SITE_URL` 读，部署第二步"改 SITE_URL 再部署"
  是改域名后必踩的坑；现在 UA 是常量（cron 预热与用户请求一致），文档链接按当前 Host 自动取
- **D1 改由 wrangler 自动开通，不再往仓库里塞占位 `database_id`**。原先
  `wrangler.jsonc` 写的是 32 个 0，干净 checkout + CI 每次都会撞上
  `[code: 10181] D1 binding 'DB' references database '000…' which was not found`。
  根因是 wrangler 判定「有没有 UUID」的实现是 `!!db?.uuid`——**非空就算有**，
  于是占位符短路掉自动开通分支，被当作一个合法 ID 直接送去 API。
  现在删掉该键，首次 `deploy` 自动建出名为 `uapis` 的库。副作用是仓库里不再有
  账号专属值，fork 不用手改；`database_id` 本身是公开标识符不是凭据，仍可随时手填
- **`migrations_pattern: "migrations/[0-9]*.sql"`**：`migrations/seed.sql` 与真正的迁移
  同住一个目录，而 `migrations apply` 默认发现规则是 `migrations/*.sql`——seed 会被
  当成一次迁移应用到生产。它是 `INSERT OR REPLACE`，一旦重跑就会把
  `maintenance.mode` 覆盖回 `active`、`cors.origins` 覆盖回 `*`，
  正好抵消只读模式。加 pattern 后生产只建表、设置回落到代码默认值，
  `db:seed:local` 保持手工可用

### Fixed

- **`/llms.txt` 泄漏硬编码示例域名**：`meta.ts` 读 `SITE_URL` 时的默认值就是示例域名，
  没配过 `SITE_URL` 的部署会对外自报它；现在改为从当前请求 Host 取
- **凭据设置键统一成「provider 名 + 凭证类型」**：`se.key` → `stackexchange.api_key`、
  `ncbi.api_key` → `pubmed.api_key`、`gh.token` → `github.token`。原先三个键里两个用缩写
  （`se`/`gh`），第三个 `ncbi` 更是按**上游机构**命名，而全项目其余设置键（`crossref.*`、
  `zenrows.key`、`quota.*` 等）一律按 provider 名——同一个 settings 表里混着两套命名依据。
  改完前缀与 `/api/v1/<provider>/` 的路径段一致，凭据从 URL 就能推出来该配哪个键。
  后缀保留各上游官方叫法：SE 与 NCBI 官方称 API key，GitHub 官方称 token（fine-grained PAT）。
  0.1.0 尚未发布过（无 tag、未部署），因此直接改名、不写兼容层与数据迁移
- **`maintenance.mode=readonly` 之前挡不住自动回源**：维护模式判断被套在
  `if (fallback === null)` 里面，于是"缓存里有旧值"的几条路径全都绕过了它。
  具体表现是 stale 命中仍然无条件 `waitUntil(refreshInBackground)` 入队（`refreshInBackground`
  直接调 `enqueueRefresh`，不查维护模式），照常扣队列额度并异步回源；超出 stale 窗口的旧值
  在开启内联回源时更是直接同步打上游再写库。根因是判断位置，不是判断本身。
  现在 stale 分支与 `fallback !== null` 都各自查一次维护模式：
  `STALE` 照常返回但不再入队，超窗口的旧值返回 `STALE-FALLBACK`（旧值本来只在回源失败时
  兜底，只读模式下没有回源可言，返回它比 503 更有用），完全无缓存才 `503`。
  `HIT`/`NEGATIVE` 与 `active` 下的行为一行未动
- **cron 预热在只读模式下照样入队**：`warm()` 不查维护模式，每 30 分钟仍会把 `warm.list`
  里的条目丢进队列烧额度。现在非 `active` 时按 `warm.list` 长度记进 `__warm_skipped` 后返回
- 两处只读例外是有意保留的：`POST /admin/rebuild` 仍可入队（只读冻结的是自动流量，
  人工显式重建是排障手段）；切换瞬间已在队列里的消息仍会回源一次（消费者不查维护模式，
  `max_batch_size: 1`，窗口极短）
- `maintenance.mode` 原先没有任何行为测试。现补 8 个：stale 不入队、超窗口回 `STALE-FALLBACK`
  且不写库、无缓存 503 带 `details.mode`、HIT 不受影响、`/admin/rebuild` 不被误伤、
  cron 在 readonly 下不入队 / active 下正常入队、切回 active 后 stale 重新触发刷新
- **上游正文读失败不再冒成 500**：状态行到了但正文断流时，`await response.text()` 抛出的
  `TimeoutError` 会一路冒到 `onError` 变成 `500 INTERNAL_ERROR`，而且**不写负缓存**——
  同一个 key 每次都白等一个超时。P5 接 pypi / npm 时在 Fastly 前置的 CDN 上撞到
  （连得上、正文不落地）。现在按 504 重试并最终返回 504，走正常错误映射与负缓存；
  顺带把 `200 + 空正文` 也判成 502，不再把"成功但没内容"的条目写进缓存

- **缓存键加 `op` 段（v1 → v3）**：既无路径参数又无 query 的端点 `id` 都是空串落到 `root`，
  `lobsters/hot` 与 `lobsters/newest` 共用一个条目，请求 `newest` 会直接返回 `hot` 的内容
- **`sanitizeId()` 不再小写化**：`target.ts` 明确说 id 保留大小写，键里被 lower 导致
  `tag/Rust` 命中 `tag/rust` 的缓存
- `hackernews/latest` 的测试补上 MSW handler：原先靠真实网络才 200，CI 无外网就 502
- 管理子应用挂到 `/admin` 前缀，避免 `use('*')` 鉴权覆盖全部路由
- 响应封装统一走 `envelope.finalize()`，避免 handler 直接返回 `Response` 时丢失
  `X-Request-ID` / CORS / 限流头（Hono 的 preparedHeaders 不会被合并）
- 缓存行数软上限改为比较真实行数（隔离实例内估算 + 每 50 次写入或 Cron 后重算），
  移除只在写入时清零、从不累加的 `hits` 列
