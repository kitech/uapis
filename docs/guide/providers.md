# 数据源与凭据

每个数据源在 `src/providers/` 下有一个 `def`（声明层）和 `runtime`（行为层），
`src/providers/index.ts` 把它们汇总成 registry，`/openapi.json`、`/llms.txt`、
`/status`、`/admin/providers` 全部由 registry 生成——加一个数据源不需要改任何其他文件。

## tier 分级

| tier | 含义 | 现状 |
| --- | --- | --- |
| A | 官方公开 API，无需凭据，宽松限流 | hackernews、lobsters |
| A- | 官方 API 匿名可用，但限流严格或需要限速 | github（token 可选）、devto、arxiv、itunes、crossref |
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

## Lobsters · tier A

上游：`https://lobste.rs`，官方自带 JSON 接口，零 key。

| 方法 | 路径 | 参数 |
| --- | --- | --- |
| GET | `/api/v1/lobsters/hot` | 无；映射上游 `/hottest.json` |
| GET | `/api/v1/lobsters/newest` | 无；映射上游 `/newest.json` |
| GET | `/api/v1/lobsters/tag/{tag}` | 路径 `tag`：`^[a-z0-9][a-z0-9-]{0,30}$`；映射 `/t/{tag}.json` |
| GET | `/api/v1/lobsters/story/{id}` | 路径 `id`：short_id，`^[0-9a-z]{4,10}$`；映射 `/s/{id}.json` |

- **路径名和上游不一样**：`hot` → `hottest.json`、`newest` → `newest.json`。
  直觉上的 `/hot.json`、`/new.json`、`/recent.json` 全是 404（实测过）
- 列表固定约 25 条，上游没有分页参数（`?page=` 之类会被忽略），所以这四个端点不暴露分页
- 闸门 1000ms；官方未公布硬性限流，纯自我约束
- 归属：故事版权归各提交者，Lobsters 内容按 CC BY-SA 3.0

## iTunes Search · tier A-

上游：`https://itunes.apple.com`，Apple 公开 Search API，零 key。

| 方法 | 路径 | 参数 |
| --- | --- | --- |
| GET | `/api/v1/itunes/search` | `term`（必填）、`media`（12 种，默认 podcast）、`entity`、`country`（两位，默认 US）、`limit`(1-200, 默认 20)、`offset`(0-500, 默认 0) |
| GET | `/api/v1/itunes/lookup` | `id`（必填，纯数字）、`entity`、`country`、`limit`(1-200, 默认 20) |

- 闸门 500ms；官方未公布硬性限流
- **分页是 `offset` 不是 `page`**：与 Algolia / SE 的 `page` 约定不同，照上游习惯保留
- `limit` 上界 200：实测 201 也能返回，但体积过大（约 300KB+）且收益递减，直接卡在 200
- `term` 走字符白名单（Unicode 字母数字 + 空格与常见标点）：`&` 这类必须留给 `encodeURIComponent`，
  `=`、`<`、`/`、`%` 一律拒掉，防止拼出意料之外的 URL
- `media` 非法值在 runtime 就 400，`details.allowed` 列出全部合法值
- 归属：封面与简介版权归 Apple 及各自权利人，只做元数据转发

## Crossref · tier A-

上游：`https://api.crossref.org`，DOI 注册机构官方检索 API，零 key。

| 方法 | 路径 | 参数 |
| --- | --- | --- |
| GET | `/api/v1/crossref/search` | `query`（必填）、`rows`(1-30, 默认 10)、`offset`(0-1000, 默认 0)、`sort`（7 个字段）、`order`(asc/desc)、`filter`、`select` |
| GET | `/api/v1/crossref/work/{doi}` | 路径 `doi`：**含斜杠**，如 `10.2172/2407272` |

- 闸门 1000ms。Crossref 的 polite pool 官方给到约 50 次/秒，1 秒一条是自我约束
- **`rows` 上界 30**：实测 `rows=20` 响应约 59KB，再往上对本项目没有意义（免费 CPU/D1 额度优先给命中率）
- `doi` 走 `multiSegment`（`10.<registrant>/<suffix>` 天然多段），白名单 `^10\.[0-9]{4,9}/[A-Za-z0-9._()/:;+-]{1,180}$`
  并额外拒掉 `..` 相对路径段；老 DOI 里那些 `<` `>` 形态的字符不支持
- 响应是 `{"status":"ok","message":{...}}` 信封，原样透传（和 HN / SE 一致，不二次拆包）
- **polite pool**：可选设置 `crossref.mailto`，填了合法邮箱就带上 `mailto` 参数进 polite pool；
  填错（不像邮箱）当没配，不报错也不带参数
- `filter` / `select` 只放行字符集（`select` 还能省流量：`select=DOI,title,issued`）
- `mailto` 是服务端设置、**不进缓存键**：配与不配共用同一个缓存条目，
  先到先得（Crossref 两种池子返回的题录一致，不影响正确性）
- 归属：题录（标题/作者/期刊）版权归出版方与 Crossref

## PyPI · tier A-

上游：`https://pypi.org/pypi`，Python 官方索引，零 key。

| 方法 | 路径 | 参数 |
| --- | --- | --- |
| GET | `/api/v1/pypi/project/{package}` | 路径 `package`：PyPI 包名，按 PEP 503 归一化（`Django_REST` → `django_rest`） |
| GET | `/api/v1/pypi/release/{package}/{version}` | 路径 `package`、`version`：固定版本，如 `requests/2.34.2` |

- 闸门 500ms
- **项目端点做 transform，不透传**：实测 `numpy` 的 `/json` 有 1.6MB，
  其中 96% 是 `releases` 里全部历史版本（`requests` 也有约 195KB），
  再加 README 全文 `description`（可达 50KB+）
- 实测真实 `requests` 元数据：192,960B → 4,403B（2.3%），163 个历史版本折叠成 `versions` 数组
- transform 后只保留：`name`、`version`、`summary`、`requires_python`、`license`、
  `license_expression`、`classifiers`、`requires_dist`、`project_urls`、`yanked`、
  `versions`（`Object.keys(releases)`，保持上传顺序）、`files`（当前版本 `urls` 的
  `filename`/`packagetype`/`size`/`upload_time`/`yanked`/`requires_python`/`url`）、
  `last_serial`、`vulnerabilities`，以及 `provider`、`fetched_at`
- `releases` 的价值由 `versions` 数组 + 固定版本端点承接；README 全文改由
  `/api/v1/pypi/project/{package}` 之外的自建途径获取，本项目不存
- 固定版本端点实测 7KB（`requests`）到 97KB（`numpy` 52 个 wheel），直接透传
- 白名单：包名 `^[a-z0-9]([a-z0-9._-]{0,62}[a-z0-9])?$`（归一化后），
  版本号 `^[a-z0-9][a-z0-9.+!_-]{0,63}$`（PEP 440 常用形态，含 `1.0.0rc1` / `2.0.post1`）
- **不做 simple index**：`/simple/{pkg}/` 是 100KB+ 的 HTML 锚点列表，
  本项目只服务 JSON API，不解析 HTML
- 归属：包元数据与代码版权归各自作者/维护方，PyPI 只做分发

## npm registry · tier A-

上游：`https://registry.npmjs.org`，零 key。

| 方法 | 路径 | 参数 |
| --- | --- | --- |
| GET | `/api/v1/npm/latest/{name}` | 路径 `name`：包名，**scoped 包可多段**，如 `@types/node` |
| GET | `/api/v1/npm/version/{name}/{version}` | 路径 `name`（可多段）、`version`：固定版本 |
| GET | `/api/v1/npm/search` | `text`（必填）、`size`(1-250, 默认 10)、`from`(0 起, 默认 0)、`sort`（`-date`/`popularity`/`quality`） |

- 闸门 500ms。npm 官方对匿名请求没有明确的速率承诺，1/500ms 是自我约束
- `latest` / `version` 实测 1.6KB（lodash）到 3.5KB（`@types/node`），原样透传
- `name` 走 `multiSegment`（scoped 包天然含 `/`），白名单
  `^@?[a-z0-9][a-z0-9._~-]{0,213}$`；npm 包名规范就是小写，大写直接 400
- `version` 端点按 `@scope/` 边界切包名与版本：`@types/node/26.6.3` 切成
  `@types/node` + `26.6.3`，切错段会把包名和版本拼反，所以段数不是 2 直接 400
- **不做 packument**（`/{name}` 与 `/{name}/latest` 之外的全量文档）：
  abbreviated 文档对 `react` 有 2.9MB、`@types/node` 2.3MB，
  远超本项目 512KB 的单响应上限；完整文档 `lodash` 也有 248KB，
  热门包会立刻把缓存和免费额度打满
- `search` 只放行白名单参数（`text`/`size`/`from`/`sort`），其余 query 一律 400；
  `text` 允许 `@types/node`、`node/react` 这类含 `/` 的写法，但会编码后再发
- `sort=relevance`（等价于不传）不会发给上游

## PubMed（NCBI E-utilities）· tier A-

上游：`https://eutils.ncbi.nlm.nih.gov/entrez/eutils`，**零 key 可用**。

| 方法 | 路径 | 参数 |
| --- | --- | --- |
| GET | `/api/v1/pubmed/search` | `term`（必填，检索式）、`retmax`(1-100, 默认 20)、`retstart`(0 起, 默认 0)、`sort`（relevance/pub_date/Author/JournalName） |
| GET | `/api/v1/pubmed/summary` | `id`（必填）：PMID，逗号分隔，最多 20 个 |

- 闸门 400ms。NCBI 官方限制是 3 次/秒（无 key）/ 10 次/秒（有 key），
  400ms ≈ 2.5 次/秒，无 key 也在官方额度内
- **两个上游坑都在 runtime 里自己挡掉**：空 `term` 上游返回
  **HTTP 200 + "Empty term and query_key - nothing todo"**，
  非法 PMID 的 esummary 返回 **HTTP 200 + `{"error":"Invalid uid ..."}`**。
  放行就会把 200 + 错误体当正常数据缓存起来，所以一律在回源前 400
- `esummary` 固定 `version=2.0`（题录结构比 1.x 干净）
- **不做 efetch**：只能返回 XML/MEDLINE 文本，要引正则解析器；
  esearch（查 PMID）+ esummary（取题录）都支持 `retmode=json`，纯 JSON 够用
- `retmax` 上界 100：官方最大 10000，但一次 10000 条 esummary 体积没有实用价值，
  分页用 `retstart`
- **可选 key**：设置 `ncbi.api_key`，填了合法值（8-64 位字母数字/`-`/`_`）才附到上游 query，
  配错当没配；它只发往 `eutils.ncbi.nlm.nih.gov`（白名单唯一出口），**不进缓存键**
- 归属：题录（标题/作者/期刊）版权归作者与出版商，PubMed 只做索引

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
`crossref.mailto` 是可选的礼貌设置（进 polite pool），不填也能用。
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
| `itunes/search` | `offset`（偏移量，不是 `page`） | 0 |
| `crossref/search` | `offset`（偏移量），条数参数叫 `rows` | 0 |

lobste.rs 的四个端点没有分页：上游固定返回约 25 条，多余的分页参数会被忽略，
所以干脆不暴露。

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
