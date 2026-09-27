# 数据源与凭据

每个数据源在 `src/providers/` 下有一个 `def`（声明层）和 `runtime`（行为层），
`src/providers/index.ts` 把它们汇总成 registry，`/openapi.json`、`/llms.txt`、
`/status`、`/admin/providers` 全部由 registry 生成——加一个数据源不需要改任何其他文件。

## tier 分级

| tier | 含义 | 现状 |
| --- | --- | --- |
| A | 官方公开 API，无需凭据，宽松限流 | hackernews |
| A- | 官方 API 匿名可用，但限流严格或需要限速 | github（token 可选）、devto、arxiv |
| B | 官方 API 但要注册 key | stackexchange |
| C | 付费墙/非官方源，必须走付费代理通道 | economist |

`github` 的三个端点都标了 `auth: 'optional'`：配了 `gh.token` 自动提额，不配也能匿名调用。
`/status` 会把它报成 `active` 并给出 `auth_required=false`，不会误报成 `unconfigured`。

tier C 没有单一的 `auth.settingKey`，而是 `requiredAnyOf`：ZenRows / Jina 任一可用即可。
两条都空时 `serveResource()` 直接返回 `503 PROVIDER_UNCONFIGURED`，
`details.any_of` 会列出该配哪几个键——不排队，因为排了也回不了源。

## Hacker News（Algolia）· tier A

上游：`https://hn.algolia.com/api/v1`，无需 key。

| 方法 | 路径 | 参数 |
| --- | --- | --- |
| GET | `/api/v1/hackernews/search` | `q`、`tags`、`hitsPerPage`(1-100, 默认 20)、`page`(0-10, 默认 0) |
| GET | `/api/v1/hackernews/item/{id}` | 路径 `id`：`^[0-9]{1,12}$` |
| GET | `/api/v1/hackernews/user/{id}` | 路径 `id`：`^[A-Za-z0-9_-]{1,40}$` |
| GET | `/api/v1/hackernews/front` | `hitsPerPage`(1-100, 默认 20)、`page`(0-10, 默认 0)；映射 Algolia `tags=front_page` |
| GET | `/api/v1/hackernews/latest` | `tags`(默认 story)、`hitsPerPage`、`page`；映射 `/search_by_date` |
| GET | `/api/v1/hackernews/user/{id}/posts` | `query`、`hitsPerPage`、`page`；映射 `tags=author_<id>` |

- 最小上游间隔 300ms（可用 `gate.min_ms` 覆盖）
- 官方未公布硬性限流，本项目自我约束
- 缓存：search 60s、feed 2min、item 10min、profile 5min
- `front` / `latest` / `user/{id}/posts` 都是 `feed` 档：内容变动快但可容忍，
  2 分钟新鲜期 + 7 天 stale 兜底
- `user/{id}/posts` 用的是 Algolia 的 `author_<id>` 标签，而不是 `story_<id>`：
  后者是帖子主键标签，拿它过滤作者恒为 0 条（已实测 `tags=story_pg` → 0 hits）

## Stack Exchange · tier B

上游：`https://api.stackexchange.com/2.3`，**需要 `se.key`**。

| 方法 | 路径 | 参数 |
| --- | --- | --- |
| GET | `/api/v1/stackexchange/question/{id}` | `site`(默认 stackoverflow)、`filter` |
| GET | `/api/v1/stackexchange/search` | `site`、`q`、`tagged`、`sort`、`pagesize`(1-100, 默认 20)、`page`(0-10, 默认 0) |
| GET | `/api/v1/stackexchange/user/{id}` | `site` |
| GET | `/api/v1/stackexchange/tags` | `site`、`pagesize`、`sort` |
| GET | `/api/v1/stackexchange/question/{id}/answers` | `site`、`sort`(votes/creation/activity)、`filter`、`pagesize`(1-100, 默认 20)、`page`(0-10, 默认 0) |
| GET | `/api/v1/stackexchange/question/{id}/comments` | `site`、`filter`、`pagesize`、`page` |
| GET | `/api/v1/stackexchange/sites` | `pagesize`(1-500, 默认 100)、`page`(0-5, 默认 0)；**该端点匿名可用，无需 key** |

- key 在 <https://stackapps.com/apps/oauth/register> 注册；注册后约 10000 次/天，匿名约 300 次/天
- 未配置时返回 `503 PROVIDER_UNCONFIGURED`，`details.setting` 告诉你要配哪个键
- key 存 D1 `settings`（不是 secret），`/admin/settings` 读取时显示为 `***set***`
- 本项目只调用免登录的 2.3 API，不涉及用户 OAuth
- `/sites` 在 registry 里标了 `auth: 'optional'`，不配 key 也能调；
  OpenAPI 的 `x-provider.endpoint_auth` 会标成 `optional`。该端点故意不带 key，省额度

## GitHub · tier A-（token 可选）

| 方法 | 路径 | 参数 |
| --- | --- | --- |
| GET | `/api/v1/github/repo/{owner}/{repo}` | 路径 `owner` + `repo` |
| GET | `/api/v1/github/search/repositories` | `q`（必填）、`sort`(stars/forks/updated)、`order`、`per_page`(1-100, 默认 30)、`page`(1 起, 默认 1) |
| GET | `/api/v1/github/user/{login}` | 路径 `login`：`^[A-Za-z0-9-]{1,39}$` |

- host：`api.github.com`
- 匿名 60 次/小时（core）、10 次/分钟（search）；配 `gh.token` 后 5000 次/小时
- 闸门取最严的 6000ms：闸门是 provider 级的，宁可慢也不能撞上 search 的 10 次/分钟
- token 走 `Authorization: Bearer` 头，不进 query，因此不会进日志和缓存键
- 三个端点都标了 `auth: 'optional'`：不配 token 也能用，`/status` 里 `auth_required=false`
- 只取元数据。README 全文、源码这类大文件不走本项目，raw 域名也不在白名单里

## DEV Community（DEV.to）· tier A-

| 方法 | 路径 | 参数 |
| --- | --- | --- |
| GET | `/api/v1/devto/articles` | `tag`、`username`、`state`(fresh/rising/all/top, 默认 fresh)、`top`(1-999, 仅 state=top)、`page`(1 起, 默认 1, ≤30)、`per_page`(1-100, 默认 30) |
| GET | `/api/v1/devto/article/{id}` | 路径 `id`：文章 ID 或 slug |
| GET | `/api/v1/devto/user/{username}` | 路径 `username` |

- host：`dev.to`，公开 API 零 key，约 1000 次/5 分钟（按 IP）
- 闸门 500ms
- `state` 非法值在 runtime 就 400（上游也是 400，但我们能给出 `details.allowed`）

## arXiv · tier A-

| 方法 | 路径 | 参数 |
| --- | --- | --- |
| GET | `/api/v1/arxiv/search` | `search_query`（必填，如 `cat:cs.LG AND all:cloudflare`）、`start`(0-10000, 默认 0)、`max_results`(1-30, 默认 10)、`sortBy`(relevance/lastUpdatedDate/submittedDate)、`sortOrder` |
| GET | `/api/v1/arxiv/paper/{id}` | 路径 `id`：`^\d{4}\.\d{4,5}(v\d{1,2})?$` |

- host：`export.arxiv.org`，零 key
- **闸门 3000ms**：arXiv 官方要求最多 1 次/3 秒，这是硬要求不是自我约束
- **缓存档 `archive`（15min 新鲜期）**：官方要求调用方缓存结果至少 15 分钟
- 唯一非透传源：上游是 Atom XML，用零依赖的有界正则转成本项目的 JSON
  （`{provider,updated,total,count,entries[]}`，entry 含 id/abs/pdf/title/summary/
  published/updated/authors/primary/categories）。`costMs = 2`
- 不是通用 XML 解析器：只认 arXiv `api/query` 的固定结构，上游改结构才会失效
- `search_query` 白名单字符（`&`、`%` 等一律拒掉），防止拼出意料之外的 URL

## The Economist · tier C（付费通道）

| 方法 | 路径 | 参数 |
| --- | --- | --- |
| GET | `/api/v1/economist/article/{slug}` | 路径 `slug`：文章路径，**可含 `/`**，如 `finance/2026/01/01/some-article` |

- 目标 host `www.economist.com` **我们不直连**：只走 ZenRows（`api.zenrows.com`）
  或 Jina（`r.jina.ai`），出口由 `egressHosts` 声明并单独过白名单
- 两条通道都没配 → `503 PROVIDER_UNCONFIGURED`，`details.any_of = ["zenrows.key","jina.key"]`
- 通道选择顺序：`UpstreamPlan.proxy.channel` 显式声明 > `proxy.mode` 指定 >
  ZenRows（有 key 且有额度时）> Jina。`proxy.mode` 的 `off` / `auto` 都表示"没有偏好"，
  它只影响声明了 `proxy` 的端点，不会让任何源绕过付费通道直连
- 每日额度：`quota.proxy.zenrows`（默认 33）、`quota.proxy.jina`（默认 50），
  打到 0 就是 `503 QUOTA_EXHAUSTED`，队列消息直接丢弃而不是重试
- **不内联回源**（`inline: false`）：同步路径没有额度节流，一次突发就能把当天 credits 打光；
  首次请求返回 `503 REBUILDING` + `X-Cache: QUEUED`（带 `Prefer: respond-async` 则 202），
  队列消费后才落库
- 只提取 `og:title` / `og:description` / `article:section` / 发布时间，
  **不搬运正文**；付费墙正文既不进缓存也不进响应
- 缓存档 `wall`：24 小时新鲜期 + 7 天 stale
- slug 白名单 `^[A-Za-z0-9][A-Za-z0-9._/-]{0,180}$`，并额外拒掉 `..` 相对路径段；
  目标 host 写死在常量里，调用方塞不进自己的域名
- **合规前提**：只适合条款允许代理转发/引用的源。接任何 tier C 源之前，
  先自己读一遍它的 `tos`；只做标题与摘要这类元数据，不搬运正文

## 配 key

```bash
curl -X PUT https://<你的域名>/admin/settings \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"se.key":"YOUR_KEY","gh.token":"YOUR_TOKEN"}'
```

设置在隔离实例内记忆化 30 秒，`PUT` 之后立刻生效。

只有 `se.key` 是必需的（不配就是 `503 PROVIDER_UNCONFIGURED`）。
`gh.token` 配不配都能跑：配了走 `Authorization: Bearer`，不配就匿名。
`zenrows.key` / `jina.key` 任一即可让 tier C 源可用，两个都不配时该源报 `unconfigured`。
`reddit.*`、`youtube.key`、`ph.key`、`lastfm.key`、`telegram.token` 这些预留给后续阶段的 key
不要写进 `migrations/seed.sql`。

## 查看状态

```bash
curl -s https://<你的域名>/admin/providers -H "Authorization: Bearer $ADMIN_TOKEN"
```

返回每个 provider 的 tier、host 白名单、是否已配置、当天额度用量与上游条款链接。

```bash
curl -s https://<你的域名>/status | jq '.providers'
```

公开的 `/status` 不需要鉴权，适合挂监控。

## 分页约定

所有分页参数在两个 provider 上同名同义，避免调用方记两套：

| 参数 | 含义 | 默认 | 上界 |
| --- | --- | --- | --- |
| `page` | 页码，0 起 | `0` | 10 |
| `pagesize` / `hitsPerPage` / `per_page` / `max_results` | 每页条数 | `20` | 100（`sites` 为 500） |

**1 起计数的上游有三个例外**，各自保持上游习惯，不强行改成 0 起：

| 端点 | 参数 | 起点 |
| --- | --- | --- |
| `devto/articles` | `page` | 1 |
| `github/search/repositories` | `page` | 1 |
| `arxiv/search` | `start`（偏移量） | 0 |

必填参数缺失同样是 400（`details.parameter` 告诉你少了哪个）。
上界是硬限制：越界直接 `400 INVALID_PARAMETER`，`details.maximum` 告诉你真实上界。
把上界压到 10 页 / 100 条是因为 Algolia 自己的深翻页限制和免费额度，
而不是因为想给调用方设障。

翻页时把 `page` 带上即可，缓存键不同，不会互相污染。

## 加一个新数据源

1. 在 `src/providers/<name>.ts` 写 `def`（host、tier、最小间隔、endpoint 与参数声明）
   和 `runtime.buildPlan()`（把 Target 变成上游 URL）。
2. 在 `src/providers/index.ts` 注册。
3. 在 `settings.upstream.allowlist` 里加上 host——`validateRegistry()` 自检会拦住漏配。
   tier C 的源不直连目标 host，加的是 `egressHosts` 里的代理出口。
4. tier C 还必须写 `requiredAnyOf`（可用通道的 setting 列表），
   且每个端点都要有 `proxy`、`inline: false`。
5. 补 `test/unit.test.ts` 的 registry 断言和一条集成测试。
6. `/openapi.json`、`/llms.txt`、文档表格自动更新。

`src/core/registry.ts` 的 `validateRegistry()` 会在单元测试里检查：
operationId 唯一、path 参数与声明一致、host 已进白名单、tier C 必须有 `proxy`
与 `requiredAnyOf`、付费通道端点不允许 `inline`。漏一步就会红。

多段路径参数（如 `economist/article/{slug}` 的 slug 含 `/`）在 `ParamDef` 上标
`multiSegment: true`，路由生成时会变成 Hono 的 `:slug{.+}`；
这类参数必须自己校验，路由层只管非空。
