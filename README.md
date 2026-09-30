# uapis

在**单个 Cloudflare Worker** 上运行的国外站点聚合 API，整体跑在 Cloudflare 免费额度内。

- API：`https://<你的域名>/api/v1/...`
- 文档：`https://<你的域名>/docs/`
- 元数据：`/openapi.json`、`/status`、`/healthz`、`/llms.txt`

> 本项目与 uapis.cn 无任何关联，是从零实现的同类项目。

## 能力与边界

- 单 Worker 同时提供 API、静态文档（VitePress）与后台任务（Queue / Cron）
- 绑定仅 4 个：D1(`DB`)、Queues(`REFRESH`)、`caches.default`、secret(`ADMIN_TOKEN`)
- 不使用 KV / R2 / Durable Objects / Browser Run / Service Bindings / Vectorize / Containers
- 成功响应沿用 uapis 规范：**裸业务对象**；错误体统一 `{code, message, details?}`
- 免费额度硬边界：10ms CPU、10 万请求/天、D1 500MB + 500 万行读/天 + 10 万行写/天、
  Queues 1 万 operations/天、Workers Logs 20 万 events/天。设计目标见
  [docs/reference/design-decisions.md](docs/reference/design-decisions.md)
- 固定上游 host 白名单 + 不可覆盖的诚实 UA，**不是**开放代理
- 付费墙源（tier C）只走 ZenRows / Jina 付费通道，不提供免费绕过路径，也不内联回源
- 已接入 60 个端点 / 20 个数据源：Stack Exchange 7、Hacker News 6、GitHub 4、GitLab 3、
  DEV.to 3、Medium 4、Lobsters 4、iTunes Search 2、Crossref 2、PyPI 2、
  PubMed 2、arXiv 2、USGS 地震目录 2、crates.io 3、MusicBrainz 4、npm registry 3、
  Open-Meteo 4（⚠️ 条款限非商业用途）、Telegram 1、4chan 1（⚠️ 4chan 风控拒绝
  Workers 出口，当前不可用）、The Economist 1（tier C，付费通道）
- 16 个 feed 端点支持 `format` 参数，可在 `uapis`（默认）、`original`、`rss`、`atom`
  四种响应形态间选择，详见[输出格式](docs/guide/providers.md#输出格式)

## 本地开发

```bash
npm install
cp .dev.vars.example .dev.vars      # 填入 ADMIN_TOKEN
npm run db:migrate:local            # 建 D1 五张表
npm run db:seed:local               # 可选：写入示例 settings
npm run dev                         # wrangler dev
```

## 验证

```bash
npm run typecheck
npm test                            # vitest-pool-workers + MSW 出站拦截，全离线（359 个用例）
npm run deploy:dry                  # 构建文档并 dry-run，产物需 < 64MiB
```

## 常用脚本

| 命令 | 作用 |
| --- | --- |
| `npm run dev` | 本地 Worker（含 D1/Queue 模拟） |
| `npm run typecheck` | `tsc --noEmit` |
| `npm test` | 离线单元与集成测试 |
| `npm run build:docs` | VitePress 构建并暂存到 `.assets/docs` |
| `npm run deploy` | 构建文档后部署 Worker 与静态资源 |
| `npm run deploy:dry` | 部署预演 + 体积检查 |
| `npm run cf:typegen` | 生成 `worker-configuration.d.ts` |
| `npm run db:migrate` | 远端 D1 migration |

## 部署

完整步骤见 **[docs/guide/deployment.md](docs/guide/deployment.md)**，最小顺序是：
建队列（`npx wrangler queues create uapis-refresh`，**不能跳，队列不会自动开通**）→
`npm run deploy`（D1 库在这一步自动开出来，所以迁移要排在它后面；
别裸跑 `wrangler deploy`：`.assets/` 是 gitignore 的构建产物，缺失时 wrangler 会直接
报错终止整个部署；用 Workers Builds 自动部署时 Build command 要填 `npm run build:docs`）→
`npm run db:migrate`（建 5 张表）→ `npx wrangler secret put ADMIN_TOKEN`
→ 绑自定义域名后重新 `npm run deploy` 一次。

日常运维（回滚范围、Time Travel、只读模式、额度监控、部署失败速查）也在同一页。

## 文档

| 路径 | 内容 |
| --- | --- |
| [docs/index.md](docs/index.md) | 快速上手 |
| [docs/guide/quickstart.md](docs/guide/quickstart.md) | 第一个请求 |
| [docs/guide/deployment.md](docs/guide/deployment.md) | 部署上线（自架步骤 + 运维手册） |
| [docs/guide/providers.md](docs/guide/providers.md) | 数据源与凭据 |
| [docs/guide/rate-limits.md](docs/guide/rate-limits.md) | 限流与免费额度 |
| [docs/guide/errors.md](docs/guide/errors.md) | 错误码表与排障 |
| [docs/guide/compliance.md](docs/guide/compliance.md) | 合规红线 |
| [docs/reference/related-projects.md](docs/reference/related-projects.md) | 同类项目对照（含 `vikiboss/60s`） |
| [docs/reference/design-decisions.md](docs/reference/design-decisions.md) | v1→v6 决策与预算 |
| [docs/reference/provider-audit.md](docs/reference/provider-audit.md) | provider 上线审计 |

## 路线

P0 骨架（已完成）→ P1 Stack Exchange/HN 完善与分页（已完成）→ P2 零 key 源批量接入（已完成：GitHub / DEV.to / arXiv）→
P3 付费墙源（ZenRows + Jina 双通道，已完成）→ P4 管理与可观测（`/admin/*`、`/status`、日志计数，已完成）→
P5 包管理与文献检索（crates / Crossref / PyPI / npm / PubMed / iTunes，已完成）→
P6 开放数据与代码托管（USGS / GitLab / Lobsters，已完成）→ P7 音乐元数据（MusicBrainz，已完成）→
P8 天气与空气质量（Open-Meteo，已完成）→ P9 GitHub Android 新星榜（已完成）→
P10 部署与运维文档（已完成：[docs/guide/deployment.md](docs/guide/deployment.md)）→ 发布。

## License

[MIT](LICENSE)
