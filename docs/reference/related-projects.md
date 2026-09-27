# 同类项目对照

本项目不是第一个做"国外站点聚合 API"的仓库。下面是对照与差异，方便你判断该用哪个。

## vikiboss/60s（60s API）

仓库：<https://github.com/vikiboss/60s>　文档：<https://docs.60s-api.viki.moe/>

**它是什么**

`vikiboss/60s` 是一个高质量、开源、全球 CDN 加速的**开放 API 集合**，最初构建在 Deno 上，
托管在 Deno Deploy，现在主线已经迁到 Cloudflare Workers。官方说明里明确写了原因：
Deno Deploy Classic 预计终止服务，且免费额度已被大量请求耗尽，公共实例的额度与兼容性都可能受影响。
因此官方现在鼓励自建，仓库同时提供 Docker / Cloudflare Workers / Bun / Node.js 多种部署方式。

**覆盖范围**

以"每天 60 秒看世界"起家，逐步扩展到奥运奖牌榜、各平台热搜（金价、油价、天气、翻译、壁纸、
Epic 游戏、二维码、猫眼票房、IT 资讯榜、每日 60s 简报等）。数据源以国内/公开数据为主，
单个端点大多直接对应一个数据源，文档托管在 Apifox。

**接口风格**

```bash
curl "https://60s.viki.moe/v2/60s"                    # JSON
curl "https://60s.viki.moe/v2/60s?encoding=text"       # 纯文本
curl "https://60s.viki.moe/v2/60s?encoding=image"      # 302 到原图直链
curl "https://60s.viki.moe/v2/60s?encoding=image-proxy" # 代理请求，直接返回图片二进制
```

一个端点一个源，参数极简，还提供 `encoding` 切换输出形态。完整 API 列表在 Apifox 上持续更新。

**社区生态**

维护了 `60s-static-host`：把每日简报 JSON 与图片推到 GitHub 仓库，
再用 jsDelivr / jsDelivr 镜像等 CDN 分发，浏览器直接画图。也就是"抓一次 + CDN 分发"的思路，
API 服务只负责产出，流量交给 CDN。

**与本项目的差异**

| 维度 | vikiboss/60s | uapis（本项目） |
| --- | --- | --- |
| 平台重心 | 从 Deno Deploy 迁到 Cloudflare Workers | 只做 Cloudflare Workers，绑定固定为 D1/Queues/Cache API |
| 端点粒度 | 端点 = 数据源（`/v2/60s`、`/v2/maoyan/...`） | 端点 = provider 内的 operation（`/api/v1/hackernews/search`），多源同构 |
| 响应约定 | 各端点自定义，`encoding` 切换 JSON/文本/图片 | 成功一律裸业务对象，错误一律 `{code, message, details?}` |
| 缓存 | 智能缓存策略，"毫秒级响应" | 显式 T1(Cache API) → T2(D1) → Queue 三层，`X-Cache` 公开命中状态 |
| 刷新 | 以缓存为主 | 内联回源 + Queue 异步刷新 + Cron 预热，可观测可干预 |
| 管理面 | 无 | `/admin/*`：设置、额度、provider、rebuild、闸门、只读模式 |
| 机器可读文档 | Apifox | `/openapi.json`（registry 生成）、`/llms.txt` |
| 免费额度意识 | 经历过 Deno Deploy 额度耗尽并迁移 | 把额度写进 `/status.free_tier_budget`，队列/缓存都有硬预算 |
| 数据源合规 | 以公开数据聚合为主 | 每个 provider 强制声明 `tos`/`limits`/`attribution`，固定 host 白名单 + 诚实 UA |

**可以借鉴的**

- `60s-static-host` 那种"产出 + CDN 分发"的思路：如果某个源可以静态化，
  用 GitHub 仓库 + CDN 分发比在 Worker 里回源更省额度。
- `encoding` 参数把"同一份数据、多种输出形态"显式暴露给调用方，
  这对"图片类/文本类"端点很实用。

**本项目明确不做的**

- 不提供 `encoding=image-proxy` 这种任意 URL 代理。只有 registry 里声明过的固定 host 能被抓。
- 不做 Apifox 之类的外部文档托管，OpenAPI 直接由代码生成，不会和实现漂移。

## 其他参考

- **Cloudflare Workers 官方模板**：`cloudflare/templates` 里的 Hono + D1 示例，
  本项目的绑定与 `wrangler.jsonc` 结构与之保持一致，方便对照官方文档。
- **Hono 文档**：路由、中间件、`c.header()` 语义都来自 Hono v4。
  注意 handler 直接 `return new Response()` 时必须先物化 `c.res`，
  否则中间件写入的 header 会丢——`src/core/envelope.ts` 的 `finalize()` 就是干这个的。
- **OpenAPI 3.1 规范**：`/openapi.json` 里用了 `RateLimited` 头定义和 `x-` 扩展字段。
