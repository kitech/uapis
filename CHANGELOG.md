# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 风格，版本号遵循语义化版本。

## [0.1.0] - 2026-09-27

P0 骨架 + P1 端点完善。

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
- 统一分页约定：`page`（0 起，≤10）与 `pagesize`/`hitsPerPage`（默认 20，≤100）
- 离线测试：`vitest-pool-workers` + `@msw/cloudflare` 出站拦截，88 个用例全离线
- VitePress 文档站（首页/快速上手/数据源/限流/错误/合规 + 参考页），部署到同一 Worker 的 `/docs`

### Fixed

- 管理子应用挂到 `/admin` 前缀，避免 `use('*')` 鉴权覆盖全部路由
- 响应封装统一走 `envelope.finalize()`，避免 handler 直接返回 `Response` 时丢失
  `X-Request-ID` / CORS / 限流头（Hono 的 preparedHeaders 不会被合并）
- 缓存行数软上限改为比较真实行数（隔离实例内估算 + 每 50 次写入或 Cron 后重算），
  移除只在写入时清零、从不累加的 `hits` 列
