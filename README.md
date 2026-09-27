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
- 已接入：Hacker News（零 key）、Stack Exchange（需 `se.key`）；registry 化接入，更多源见路线图

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
npm test                            # vitest-pool-workers + MSW 出站拦截，全离线（72 个用例）
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

1. `npm run db:migrate`：把 `wrangler.jsonc` 中 `database_id` 换成真实 D1 ID 后执行。
2. `npx wrangler secret put ADMIN_TOKEN`
3. `npm run deploy`
4. 在 Cloudflare 控制台给 Worker 绑定自定义域名，然后设置 `vars.SITE_URL` 为该域名并重新部署
   （`SITE_URL` 决定 UA 尾串与 CORS 白名单，必须与真实域名一致）。
5. 自定义域名生效后执行 T1 冒烟：`curl -i https://<域名>/api/v1/hackernews/search?q=cloudflare`
   连打两次，第二次必须带 `X-Cache: HIT`。

## 文档

| 路径 | 内容 |
| --- | --- |
| [docs/index.md](docs/index.md) | 快速上手 |
| [docs/guide/quickstart.md](docs/guide/quickstart.md) | 第一个请求 |
| [docs/guide/providers.md](docs/guide/providers.md) | 数据源与凭据 |
| [docs/guide/rate-limits.md](docs/guide/rate-limits.md) | 限流与免费额度 |
| [docs/guide/errors.md](docs/guide/errors.md) | 错误码表与排障 |
| [docs/guide/compliance.md](docs/guide/compliance.md) | 合规红线 |
| [docs/reference/related-projects.md](docs/reference/related-projects.md) | 同类项目对照（含 `vikiboss/60s`） |
| [docs/reference/design-decisions.md](docs/reference/design-decisions.md) | v1→v6 决策与预算 |
| [docs/reference/provider-audit.md](docs/reference/provider-audit.md) | provider 上线审计 |

## 路线

P0 骨架（已完成）→ P1 Stack Overflow/HN 完善与分页 → P2 零 key 源批量接入 →
P3 付费墙源（ZenRows + Jina 双通道）→ P4 管理与可观测 → P5 打磨发布。

## License

[MIT](LICENSE)
