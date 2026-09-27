# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 风格，版本号遵循语义化版本。

## [0.1.0] - 2026-09-27

P0 骨架 + P1 端点完善 + P2 零 key 源批量接入 + P3 付费代理通道 + P4 再加三个零 key 源。

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
- 离线测试：`vitest-pool-workers` + `@msw/cloudflare` 出站拦截，146 个用例全离线
- VitePress 文档站（首页/快速上手/数据源/限流/错误/合规 + 参考页），部署到同一 Worker 的 `/docs`

### Fixed

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
