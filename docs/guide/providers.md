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

`github` 的四个端点都标了 `auth: 'optional'`：配了 `github.token` 自动提额，不配也能匿名调用。
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

上游：`https://api.stackexchange.com/2.3`，**需要 `stackexchange.api_key`**。

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
| GET | `/api/v1/github/search/repositories` | `q`（必填）、`sort`(stars/forks/help-wanted-issues/updated)、`order`、`per_page`(1-30, 默认 30)、`page`(1 起, 默认 1) |
| GET | `/api/v1/github/android/rising` | `since`(必填, `YYYY-MM-DD`)、`per_page`(1-30, 默认 20)、`page`(1 起, 默认 1) |
| GET | `/api/v1/github/user/{login}` | 路径 `login`：`^[A-Za-z0-9-]{1,39}$` |

- host：`api.github.com`
- 匿名 60 次/小时（core）、10 次/分钟（search）；配 `github.token` 后 5000 次/小时
- 闸门取最严的 6000ms：按**匿名** search 的 10 次/分钟定的（认证后是 30 次/分钟，
  闸门更严所以无副作用），闸门是 provider 级的，宁可慢也不能撞上 10 次/分钟
- token 走 `Authorization: Bearer` 头，不进 query，因此不会进日志和缓存键
- 四个端点都标了 `auth: 'optional'`：不配 token 也能用，`/status` 里 `auth_required=false`
- 只取元数据。README 全文、源码这类大文件不走本项目，raw 域名也不在白名单里

**Android 新星榜** `/api/v1/github/android/rising`：时间窗内新建、star 最高的 Android 仓库。
`topic:android` 与 `sort=stars&order=desc` 由服务端写死，调用方只给 `since` 定时间窗——
`topic` 要是放开，这个端点就退化成通用搜索器。另外未声明的 query 一律 400，
所以调用方也没法偷偷覆盖 `topic`。

```bash
curl "https://<你的域名>/api/v1/github/android/rising?since=2026-08-28&per_page=20"
```

- **为什么不用 GitHub Trending**：Trending 只有 HTML 页、没有官方 API，解析 HTML 违反本项目原则；
  用官方 search 的 `created:>+sort=stars` 构造同等语义
- **transform 而非透传**：上游每项 82 个字段、30 项 164,439B，输出只留 8 字段降到 15,246B（省 92%），
  与 pypi 丢掉 README 全文、crates 丢掉 versions 同理
- `since` 由调用方传而不是 `days`：缓存键只对**请求侧白名单 query** 做哈希、不含上游 URL，
  服务端算出来的日期会漏出缓存键，昨天的时间窗今天照样命中
- `since` 校验形状 + 真实日期：`2026-13-45` / `2026-08-32` 会被本地挡住（上游一律回 422）

**实测约束**（2026-09 探测）：`per_page=1` 5,663B/0.8s；`per_page=30` 164,439B，
连测三次 4.7/1.9/3.0s（**默认 3s 超时就在边缘**，所以两个 search 端点都放宽到 12s）；
`per_page=100` 能返回 200 但 **557,300B，直接超 `MAX_UPSTREAM_BYTES`（512KB）** →
两个端点都封顶 30，**理由是体积不是超时**。`retries: 0`，重试要花 search 的 10 次/分钟预算。

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
- **可选 key**：设置 `pubmed.api_key`，填了合法值（8-64 位字母数字/`-`/`_`）才附到上游 query，
  配错当没配；它只发往 `eutils.ncbi.nlm.nih.gov`（白名单唯一出口），**不进缓存键**
- 归属：题录（标题/作者/期刊）版权归作者与出版商，PubMed 只做索引

## GitLab · tier A-

上游：`https://gitlab.com/api/v4`，**公开项目零 key 可用**（只读，不碰私有项目）。

| 方法 | 路径 | 参数 |
| --- | --- | --- |
| GET | `/api/v1/gitlab/projects` | `q`（必填，检索词）、`limit`(1-100, 默认 20)、`order_by`（last_activity_at/created_at/name/path/id）、`sort`（asc/desc） |
| GET | `/api/v1/gitlab/project/{id}` | 路径 `id`：`namespace/project`（**子组可多层**）或数字项目 id |
| GET | `/api/v1/gitlab/commits` | `project`（必填，`namespace/project` 或数字 id）、`ref`（分支/标签/sha，默认项目默认分支）、`limit`(1-100, 默认 20) |

- 闸门 200ms。匿名配额实测是 `ratelimit-limit: 500`（每分钟每 IP），比多数零 key 源宽松，
  但共享出口 IP 会一起被算，所以只放到 200ms
- 多段路由：`/api/v1/gitlab/project/group/subgroup/project` 走 `multiSegment`，
  上游要的是**单段 URL 编码**形式 `group%2Fsubgroup%2Fproject`，由 runtime 编码
- 提交列表的 `project` 刻意放 query 而不是路径：否则 `project/{id}` 的贪婪多段
  参数会和 `/commits` 后缀抢路由
- 搜索固定带 `simple=true`：精简字段列表，2 个项目 2.8KB、20 个约 28KB
- **不接任何需要 token 的端点**（私有项目、MR、issues 的写操作一概不碰）
- 归属：项目元数据与代码版权归各项目作者/组织，GitLab 只做托管与索引

## crates.io · tier A-

上游：`https://crates.io/api/v1`，**零 key**（上游要求带可识别的 User-Agent，
本项目发 `uapis/0.1.0 (+apple.com)`）。

| 方法 | 路径 | 参数 |
| --- | --- | --- |
| GET | `/api/v1/crates/crate/{name}` | 路径 `name`：crate 名（字母开头） |
| GET | `/api/v1/crates/crate/{name}/{version}` | 路径 `version`：如 `1.0.229` |
| GET | `/api/v1/crates/search` | `q`（必填）、`limit`(1-100, 默认 10)、`sort`（relevance/downloads/recent-downloads/new/alpha/stars/recent-updates） |

- 闸门 1000ms。官方未公布硬性限流但要求合理使用，共享资源别打太密
- **`crate` 端点做 transform**：上游 `GET /crates/{name}` 里 **99% 的体积是 `versions`**
  （serde 441KB / 316 个版本，每个版本还带 features、links、audit_actions、trustpub_data）。
  实测 windows-sys 上游 506KB（**已经贴着本项目 512KB 上限**），
  折叠成 `{num, yanked, created_at, downloads, license, rust_version, checksum, crate_size}`
  之后：windows-sys 506KB → 6.5KB、serde 441KB → 77KB、rand 139KB → 24KB。
  `crate` 对象本身整体保留（只有约 4KB）
- 单版本（1.7KB）和搜索（2.1KB）天然小，passthrough
- 归属：crate 元数据与代码版权归各发布者，crates.io 只做索引与托管

## USGS 地震目录（FDSN event）· tier A

上游：`https://earthquake.usgs.gov/fdsnws/event/1/query`，**零 key、公有领域**。

| 方法 | 路径 | 参数 |
| --- | --- | --- |
| GET | `/api/v1/usgs/earthquakes` | `minmagnitude`(0-10，可含小数, 默认 2.5)、`limit`(1-200, 默认 20)、`orderby`（time/magnitude） |
| GET | `/api/v1/usgs/earthquakes/{id}` | 路径 `id`：事件 id，如 `ci41339847` |

- 闸门 1000ms。官方未公布硬性限流，本项目按"共享公共服务"自我约束
- **只走 `/query`，不走 `feed/v1.0/summary/*.geojson`**：固定 feed 体积跨度太大
  （all_hour 4.6KB、all_day 134KB、2.5_week 234KB、all_month **7.5MB**），
  而且实测拼错的路径（如 `summary/all_min.geojson`）上游会**回 200 + `404 File Not Found` 纯文本**。
  `/query` 反而可控：limit=20 → 14KB、limit=200 → 145KB，所以 `limit` 硬卡 200
- 超时放宽到 8s 并**关掉重试**：实测 limit=200 要 4.8s，3s 默认超时不够；
  慢上游重试只会把内联请求拖成 2× 超时
- `minmagnitude` 是小数，而框架只对 `integer` 类型做范围校验，
  所以格式和 0-10 区间都在 runtime 里兜住
- 事件 id 白名单 `^[a-z0-9]{5,20}$`：形态合法但不存在的 id 由上游回 404，
  那是诚实的答案，不在我们这层猜成 400
- 数据属美国联邦政府**公有领域**；请注明 USGS / NEIC

## MusicBrainz · tier A-

上游：`https://musicbrainz.org/ws/2`，**零 key**（上游要求带可识别的 User-Agent，
本项目发 `uapis/0.1.0 (+apple.com)`）。

| 方法 | 路径 | 参数 |
| --- | --- | --- |
| GET | `/api/v1/musicbrainz/search` | `q`（必填，**透传上游 Lucene 语法**）、`type`（artist/release-group/release，默认 artist）、`limit`(1-25, 默认 10) |
| GET | `/api/v1/musicbrainz/artist/{mbid}` | 路径 `mbid`（36 位小写 UUID）；`inc`：url-rels/aliases/genres/tags（单值） |
| GET | `/api/v1/musicbrainz/release-group/{mbid}` | 路径 `mbid`；`inc`：releases/artist-credits/url-rels（单值） |
| GET | `/api/v1/musicbrainz/release/{mbid}` | 路径 `mbid`；`inc`：recordings/artist-credits/labels/media（单值） |

- 闸门 1000ms。**限流是官方写在响应头里的**：search 类端点
  `X-RateLimit-Limit: 400`/分钟，按 MBID 查实体是 `1900`/分钟，1000ms 对两者都在额度内
- **必须写死 `fmt=json`**：漏掉 `fmt` 上游回 **200 + XML**（`<metadata xmlns=...>`）。
  和 PubMed 的 `retmode=json` 同一个坑，只是这里回的是 XML 不是 JSON
- **`limit` 硬卡 25**：搜索体积随查询宽度爆炸——`query=radiohead&limit=25` 只有 15KB，
  但 `query=a&limit=10` 就是 **146KB**，limit=100 是 296KB 且**要 22.8s**。
  超时放宽到 6s 并**关掉重试**，宽查询宁可 502 也不要把内联请求拖成 2× 超时
- 上游在宽查询下会间歇回 **503 "The MusicBrainz web server is currently busy"**；
  5xx 走正常映射变成 `502 UPSTREAM_ERROR` 并写负缓存——**不占用本地闸门的 503 语义**，
  后者只留给"我们自己冷却中"
- `inc` 只放行**单值**：实测 `inc=genres,tags`（逗号无论是否 URL 编码）上游都回 400，
  所以不做逗号组合
- **MBID 只收规范小写**，大写回 400。缓存键由原始路径 id 算出（在归一化之前），
  放行大写等于同一实体两条缓存条目 + 两次一模一样的回源
- `q` 透传 Lucene 语法（官方文档明确支持 `AND`/`OR`/`NOT`/字段前缀），
  允许非 ASCII 检索词（实测"邓丽君"正常返回 642 个艺人），只挡控制字符和超长值
- 归属：音乐元数据（艺人名、发行信息）版权归各权利人，MusicBrainz 只做开放元数据索引

## Open-Meteo · tier A-

上游：`https://api.open-meteo.com`（预报）、`https://geocoding-api.open-meteo.com`（地名检索）、
`https://air-quality-api.open-meteo.com`（空气质量），**零 key**。

> ⚠️ **条款限定非商业用途**（CC BY 4.0）。官方把"运营带订阅或广告的网站/应用"明确列为商业使用，
> 并保留不经通知封禁应用/IP 的权利。公开部署前请自行确认你的部署算非商业；
> 商业化需要换成 `customer-` 前缀的 host 并带 `apikey`（本项目**没有**实现这条路）。
> 署名：数据由 Open-Meteo.com 提供，CC BY 4.0。

| 方法 | 路径 | 参数 |
| --- | --- | --- |
| GET | `/api/v1/openmeteo/current` | `latitude`(-90~90)、`longitude`(-180~180) **必填**；`current`(变量表必填)；`timezone`(默认 auto)；3 个单位枚举 |
| GET | `/api/v1/openmeteo/hourly` | 同上 + `hourly`(变量表必填) + `forecast_days`(1-16，默认 7) |
| GET | `/api/v1/openmeteo/geocode` | `name` 必填；`count`(1-100，默认 5)；`language`(两位小写，默认 en) |
| GET | `/api/v1/openmeteo/air-quality` | 坐标必填；`current`/`hourly`（空气质量变量表，**至少一个**）；`forecast_days`(1-7) |

- 闸门 1000ms；每日额度 `quota.openmeteo.default` = 4000。**限流只存在于条款里，响应头一个都没有**：
  600/分钟、5,000/小时、**10,000/天**、300,000/月——绑定约束是每日 10,000，而本项目的 quota 表本来就是按天计的
- **纯透传，不做 transform**：实测 current 327B、hourly 8 变量 × 16 天 20,595B、
  空气质量 9 变量 × 7 天 10,863B，离 512KB 上限差两个数量级。和 PyPI/crates 要 transform 的原因正好相反
- **三个"看起来成功其实没数据"的坑，全在本地挡掉**：
  1. 坐标合法但一个变量都不给 → 上游回 `200` + 171B，只有元数据没有数据
  2. geocoding `name=` 传空 → 上游回 `200` + `{generationtime_ms}`，**没有 `results` 键**
  3. geocoding 查无此城 → 形态相同，但这个是**真·查不到**，应当照常透传（所以只拒空名）
- **变量表必须本地校验**：上游拼错变量名时会把 Scala 内部类名漏进 reason
  （`Cannot initialize SurfacePressureAndHeightVariable<...`），透传等于把上游实现细节甩给调用方。
  天气表（18/20 项）与空气质量表（11 项）**完全不通用**，混用必然 400
- 变量数上界就是白名单长度，不另设 count 上限：384 个时间点 × 20 个变量实测在 50KB 量级
- 空气质量实测最慢 3.3s，**超过默认 3s 超时**，所以该端点显式放宽到 8s；全部端点 `retries: 0`
  （日预算只有 10,000，重试等于白花额度）
- `timezone` 只收 `auto`/`UTC`/`GMT` 或 IANA 形态（`Region/City`）。**不**内联 600 项的完整时区表：
  形态合法但不存在的时区会落到上游 400，最终表现为 `502`——这是已知取舍
- geocoding 写死 `format=json`（默认值本来就是 JSON，写死是防上游改默认值打不到我们，
  和 MusicBrainz 的 `fmt=json` 同一思路）
- **明确不暴露**：`daily` 变量表、`past_days`/`start_date`/`end_date`/`forecast_hours`/`forecast_minutely_15`、
  `models`（几十个模型名会把缓存键打爆）、`elevation`、`apikey`
- 归属：气象与空气质量数据由 Open-Meteo.com 提供，CC BY 4.0

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

## 4chan / 4board · tier A

上游：`https://a.4cdn.org`，官方只读 JSON API，**零 key**。

| 方法 | 路径 | 参数 |
| --- | --- | --- |
| GET | `/api/v1/fourchan/catalog/{board}` | 路径 `board`：板块名 `^[a-z0-9]{1,8}$`（`g` / `pol` / `a`）；`limit`(1-100, 默认 25)；映射上游 `/<board>/catalog.json` |

- ⚠️ **当前不可用**：本部署（Cloudflare Workers 出口）被 4chan 的 Cloudflare 风控
  直接拒绝，实测四种格式一律 403，**与 UA 无关**。这是 4chan 侧的 IP 策略，不是
  本项目的 bug；换出口或换部署形态才可能通。文档保留是为了说明端点契约，不是
  保证可用
- 上游 `catalog.json` 带分页包裹且体量大，**必须 transform**：取前 N 个 OP 后
  按 bump 序输出。超过约 512KB 的板块（如 `/pol` ≈555KB）在回源时直接
  `413 FILE_TOO_LARGE`——transform 只对体量以内的板块生效
- 闸门 1000ms：官方要求每至多 1 请求/秒，这是硬性要求而非自我约束
- 板块名白名单 `^[a-z0-9]{1,8}$`：形态合法但不存在的板块由上游回 404，
  那是诚实的答案，不在我们这层猜成 400
- 归属：各帖版权归发帖者所有

## Telegram 公开频道 · tier A

上游：`https://t.me`，解析**公开网页预览页** `t.me/s/<channel>`，**零 key**。

| 方法 | 路径 | 参数 |
| --- | --- | --- |
| GET | `/api/v1/telegram/channel/{channel}` | 路径 `channel`：频道用户名 `^[A-Za-z][A-Za-z0-9_]{2,31}$`，**不带 `@`**（`telegram` / `durov`）；`limit`(1-20, 默认 20) |

- **不需要 `api_id` / `api_hash`，也不需要登录**：走的是任何人打开浏览器都能看到的
  公开预览页，不是 Bot API。私有频道一律拿不到
- 上游是 **HTML**，必须 transform 成 JSON。频道标题取自
  `class="tgme_channel_info_header_title"` 里套的 `<span>`，正文取自
  `class="…tgme_widget_message_text…"`——**按 class 列表含目标类匹配，不能写死整个
  class 串**：上游的 class 带 `js-message_text` 之类的附加类，写死
  `/class="tgme_widget_message_text"/` 匹配不到任何东西（线上实测过），
  而静默取空比匹配失败更糟，所以取不到就抛 502 让上层重试
- 上游在频道正常时也会回「没找到消息」页（限流所致），这种情况同样按 502 处理
- 预览页只给有限条数，`limit` 上界 20；单页之外没有分页参数
- 闸门 1000ms。官方未公布预览页限流，这是**纯自我约束**
- 归属：各帖版权归频道作者所有

## Medium · tier A-

上游：`https://medium.com`，官方公开 RSS 接口，**零 key**。

| 方法 | 路径 | 参数 |
| --- | --- | --- |
| GET | `/api/v1/medium/tag/{tag}` | 路径 `tag`：`^[a-z0-9][a-z0-9-]{0,49}$`（`programming`）；`limit`(1-10, 默认 10) |
| GET | `/api/v1/medium/publication/{publication}` | 路径 `publication`：同 `tag` 正则（如 `towards-data-science`） |
| GET | `/api/v1/medium/user/{user}` | 路径 `user`：`^(?!.*\.\.)[A-Za-z0-9][A-Za-z0-9._-]{0,49}$`，**不含 `@`** |
| GET | `/api/v1/medium/tagged/{publication}/{tag}` | 两个路径参数，按 `/` 拼接；各自同上正则 |

- **上游固定 10 条且不可分页**，所以 `limit` 上界就是 10。传入更大的值不报错，
  但也不会多给条数——这是上游形态，不是我们的截断
- 闸门 **2000ms**（比别处宽）：无官方数值，而 Cloudflare 对数据中心 IP 敏感，
  社区实测并发拉 Medium feed 会吃 429；再低只会撞限流而换不来更高成功率
- **`retries: 0`**：Medium 的限流是持续封锁，1.5s 退避救不回来，重试只会把
  内联请求拖成 2× 超时
- 只返回**纯文本摘要不返回正文**；付费文章仅给预览，`metered: true` 标记，
  **不做任何绕过**
- 上游被限流时会给「200 + 空 body」而不是报错，所以 0 items 一律抛 502 而非返回
  空数组：空结果被缓存住意味着这个 tag 的热贴凭空消失，抛 502 至少让下次请求重试。
  代价是真正冷清的 tag 也会 502——已知取舍
- 限流不带 `Retry-After`，所以本地退避值是猜的，只能当保底
- **不支持 `{user}.medium.com` 与自定义域 feed**：host 白名单是精确匹配，
  放开就等于开了一条 SSRF
- `tagged` 是 medium 内唯一的多段路径端点（`{publication}` 与 `{tag}` 用 `/` 拼），
  拆出的两段各自要过正则；全仓库还有 crossref、economist、npm、gitlab/project
  也是多段路径
- 归属：各文章版权归作者所有，Medium 托管

## bioRxiv / medRxiv · tier A-

上游：`https://api.biorxiv.org`，官方公开 REST API，**零 key**。
预印本正文与元数据以 CC BY 4.0 授权。

| 方法 | 路径 | 参数 |
| --- | --- | --- |
| GET | `/api/v1/biorxiv/{server}/recent` | 路径 `server`：`biorxiv` / `medrxiv`；`days`(1-30, 默认 7) |
| GET | `/api/v1/biorxiv/{server}/range` | 路径 `server`：同上；`from`、`to`(均必填，`yyyy-mm-dd`) |
| GET | `/api/v1/biorxiv/{server}/detail/{doi}` | 两个路径参数；`doi` 含 `/`，多段匹配 |

- **`recent` 是本服务自己算日期区间**，不是把 `N` 或 `Nd` 丢给上游。
  文档里写了「近 N 篇」(`10`) 与「近 N 天」(`7d`)，实测线上部署会当日期区间解析
- **报错不是 HTTP 错误码**：非法 interval 回 `200` +
  `{"messages":[{"status":...}],"collection":[]}`。提取器必须先判 `messages`，
  否则会把「参数被上游拒了」静默落库成「今天没有新预印本」——两者在响应里长得一样
- `from > to` 在本地就 400，不花一次回源
- DOI 形如 `10.1101/2020.09.09.20191205`，含 `/` 故走 `multiSegment`；自己拦了路径穿越
- 上游未公布硬性限流，闸门 1000ms 是自我约束；`details` 单页固定 30 条
- 实测区间响应 67-83KB，离 512KB 闸门还有余量

## HAL · tier A-

上游：`https://api.hal.science`，官方 Solr 接口，匿名可用，**零 key**。

| 方法 | 路径 | 参数 |
| --- | --- | --- |
| GET | `/api/v1/hal/search` | `q`(必填)；`rows`(1-100, 默认 10)；`start`(默认 0)；`sort`；`fl` |
| GET | `/api/v1/hal/detail/{id}` | 路径 `id`：`^hal-\d{6,9}(v\d+)?$` |

- **`sort` 是空格分隔，不是逗号**：`sort=producedDate_s,desc` 回 44 字节错误体，
  `sort=producedDate_s%20desc` 才正常。默认 `producedDate_s desc`
- **没有 `/doc/{id}` 这条 REST 路径**（会 302）。单篇取回就是一次
  `q=halId_s:<id>&rows=1` 的检索，所以 `detail` 复用 search 的 URL 形态
- 默认 `fl` 刻意收窄：`fl=*` 会把 `filesMain_s`（全文 PDF 链接）、`abstract_s`、
  `keyword_s` 全带回来，体积能翻几倍。要全文由调用方显式传 `fl`
- 实测 `rows` 10 → 5KB、100 → 52KB，故上界定在 100
- `timeoutMs: 8000` 且 **`retries: 0`**：Solr 慢查询重试只会把内联请求拖成 2× 超时
- 归属：各条目按 HAL 上标注的许可（多数 CC BY / CC BY-SA）为准，档案库本身不代为授权

## Discourse · tier A-

上游：多个公开论坛站点的官方 Discourse API，**零 key**。
host 白名单（也是 `forum` 路径参数的取值）：

`meta.discourse.org`、`discuss.python.org`、`discourse.nixos.org`、
`forums.swift.org`、`community.crowdin.com`

| 方法 | 路径 | 参数 |
| --- | --- | --- |
| GET | `/api/v1/discourse/{forum}/hot` | 路径 `forum`：白名单主机名；`per_page`(1-30, 默认 10) |
| GET | `/api/v1/discourse/{forum}/top` | 同上；`period`：`daily`/`weekly`/`monthly`/`yearly`/`all`(默认 `weekly`) |
| GET | `/api/v1/discourse/{forum}/latest` | 同上；`order`：`activity`/`created`(默认 `activity`) |

- **`forum` 路径参数取的就是主机名**。没走「forum slug → host 映射表」是因为那张表
  得放进 `src/core/uapis.ts`（提取器要用 host 拼话题绝对地址），会与 `FORMAT_PARAM`
  形成循环依赖 / TDZ。直接用主机名当白名单值最省事
- **路由层对 path 参数只检查非空、不校验 `enum`**，真正的白名单在
  `buildPlan` 的 `requireForum`。枚举写在 `ParamDef` 里只为 OpenAPI 文档
- 同一台站 `per_page` 实测 10 → 28KB、30 → 80KB、50 → 103KB，上游默认 50 太大，
  故上界压到 30
- 响应里那个 `users` 数组与热榜无关却占掉相当体积，提取器不取
- 话题对象只给 `slug` 与数字 `id`，绝对地址由 `https://{forum}/t/{slug}/{id}` 拼出
- **不接分类（categories）端点**：分类 slug 猜错会 301 到别处，需要逐站核对
- `forums.raspberrypi.com` 实测 403、`www.askubuntu.com` 302，均不入白名单

## PeerTube · tier A-

上游：多个公开 PeerTube 实例的官方 API，**零 key**。
host 白名单（也是 `instance` 路径参数的取值）：

`framatube.org`、`peertube.tv`、`video.blender.org`、`peertube.opencloud.lu`、
`tube.tchncs.de`、`tilvids.com`

| 方法 | 路径 | 参数 |
| --- | --- | --- |
| GET | `/api/v1/peertube/{instance}/trending` | 路径 `instance`：白名单主机名；`count`(1-20, 默认 10) |
| GET | `/api/v1/peertube/{instance}/views` | 同上 |
| GET | `/api/v1/peertube/{instance}/likes` | 同上 |
| GET | `/api/v1/peertube/{instance}/latest` | 同上 |

- **热榜是 `?sort=-trending`，不是 `/api/v1/videos/trending`**。后两个写法都不存在：
  会被 `/api/v1/videos/:id` 的 `{id}` 路由吃掉，回 `Should have a valid video id`
- **PeerTube 没有全局 RSS**，`/api/v1/videos/rss` 同理不存在
- 各实例字段实测一致（`url`/`name`/`views`/`likes`/`publishedAt`/`duration`），
  播放页绝对地址由上游直接给，不用拼
- 实测单条约 4-4.7KB；`count` 10 → 40KB、20 → 87KB，故上界定在 20
- 实例可能下线或改实例模式，白名单是**逐个探测过**的固定集合，不做通配

## 配 key

```bash
curl -X PUT https://<你的域名>/admin/settings \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"stackexchange.api_key":"YOUR_KEY","github.token":"YOUR_TOKEN"}'
```

设置在隔离实例内记忆化 30 秒，`PUT` 之后立刻生效。

只有 `stackexchange.api_key` 是必需的（不配就是 `503 PROVIDER_UNCONFIGURED`）。
`github.token` 配不配都能跑：配了走 `Authorization: Bearer`，不配就匿名。
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

## 输出格式

26 个 feed 端点（13 个 provider）接受 `format` 查询参数，决定响应体的形态。
其余 46 个端点没有这个参数，带上就是 400 `unknown query parameter: format`——
**不做静默忽略**，理由见[设计决策](/reference/design-decisions)。

| 取值 | 含义 | Content-Type |
| --- | --- | --- |
| `uapis` | **默认**。归一化后的业务 JSON，字段最全 | `application/json; charset=utf-8` |
| `original` | 上游原样透传，不做任何解析 | 上游自己的类型 |
| `rss` | RSS 2.0，严格用标准字段 | `application/rss+xml; charset=utf-8` |
| `atom` | Atom 1.0，严格用标准字段 | `application/atom+xml; charset=utf-8` |

```bash
curl -i 'https://<你的域名>/api/v1/lobsters/hot?format=atom'
```

### 哪些端点支持

| provider | 端点 |
| --- | --- |
| hackernews | `front`、`latest`、`user/{id}/posts` |
| lobsters | `hot`、`newest`、`tag/{tag}` |
| medium | `tag/{tag}`、`publication/{publication}`、`user/{user}`、`tagged/{publication}/{tag}` |
| openmeteo | `hourly` |
| usgs | `earthquakes` |
| devto | `articles` |
| gitlab | `commits` |
| telegram | `channel/{channel}` |
| fourchan | `catalog/{board}` |

带 `format` 的端点正好是 `resource: 'feed'` 的那 16 个——分界线是**有没有条目列表可投影**，
不是 `passthrough`。`hackernews` 的 `search`、`item/{id}`、`user/{id}` 都在其中缺席，
因为它们的 `resource` 是 `search` / `item` / `profile`：单个对象或搜索结果，套进 RSS/Atom
只会得到一个 item 包着整份 JSON，订阅器读起来是坏的。

### 字段对照

**默认的 `uapis` 才是字段最全的**，XML 是有损投影：

| 字段 | `uapis` | `rss` / `atom` |
| --- | --- | --- |
| `title`、`url` | 有 | 有 |
| `date`（时间戳） | 有 | 映射到 `pubDate` / `updated` |
| `summary` | 有 | 映射到 `description` / `summary` |
| `hot_value`（热度） | 有 | **丢** |
| `cover`（封面图） | 有 | **丢**（原因见下） |
| `extra`（上游原始 lossless 结构） | 有 | **丢** |

封面必然丢：RSS 2.0 没有 item 级图片的标准元素，`enclosure` 又强制要求同时给
`length` 和 `type`，而我们既不知道字节数也不知道 MIME。Atom 的 `<content>` 或
`<link rel="enclosure">` 能承载，但我们不造自己拿不到的数据——**要封面用 `uapis`**。
`hot_value` 和 `extra` 是本项目的产物，RSS/Atom 里没有对应标准字段，加自定义
命名空间又会让通用订阅器读不懂，所以直接不输出。

### 日期

| 格式 | 元素 | 规范 |
| --- | --- | --- |
| `rss` | `<pubDate>` | RFC-822（`Wed, 30 Sep 2026 07:07:16 GMT`） |
| `atom` | `<updated>` | RFC-3339（`2026-09-30T07:07:16.000Z`） |

两者都带时区，不会产出裸本地时间。`openmeteo/hourly` **没有日期**——它给的是
不带偏移的本地时刻，补一个偏移就是编造时间，所以留空而不是猜一个。

摘要逐 provider 的来源不一样：medium 用 excerpt，Hacker News 用
`story_text` / `comment_text`，devto 与 lobsters 用 `description`，USGS 用 place，
Open-Meteo 是 `变量: 值`。fourchan、telegram、gitlab 没有可用的摘要字段，
对应元素直接不输出。

### id 与链接

Atom 的 feed `<id>` 是 URN，**带 query 段**：

```text
urn:uapis:usgs:search:94fcfcf6        ← minmagnitude=2.5
urn:uapis:usgs:search:d0b27b10        ← minmagnitude=4.5
```

必须带 query，是因为这四个端点的 `id` 都是空的，`op` 在同一 provider 内也不变，
拼出来的 base 只有 provider 和 op：

| 端点 | base | 区分查询的信息全在 query |
| --- | --- | --- |
| `usgs/earthquakes` | `urn:uapis:usgs:search` | `minmagnitude`、`orderby`、`limit` |
| `gitlab/commits` | `urn:uapis:gitlab:commits` | `project`、`ref`、`limit` |
| `openmeteo/hourly` | `urn:uapis:openmeteo:hourly` | `latitude`、`longitude`、`hourly` |
| `hackernews/front` | `urn:uapis:hackernews:front` | `page`、`hitsPerPage` |

不并进 query 段，`minmagnitude=2.5` 和 `4.5` 就会共用同一个 id——两份内容不同、
id 却撞车的文档，违反 Atom 对 feed id 全局唯一的要求。query 段是排序后 query 的
哈希，所以参数顺序不影响结果。`format` 不参与：同一个 feed 的 RSS 与 Atom 两种
序列化本来就该共用一个 id。

**RSS 侧刻意不做对应的事。** RSS 2.0 的 channel 根本没有 `id` 元素，身份由指向
站点的 `<link>` 承担，跨查询恒定正合规范。硬塞一个 `atom:link` 只会让非 Atom
订阅器看到不认识的元素。

用 URN 而不是 URL，是因为这些 id 不指向任何可解引用的资源，写成 `https://…` 是
撒谎；而且队列刷新拿不到请求，缓存字节也不该随访问域名变化。

item 级：能拿到绝对 URL 就用它（RSS 的 `<guid isPermaLink="true">`、Atom 的
`<id>`）；不是 http(s) 开头、或同一个 feed 内 URL 撞车时，退回
`urn:uapis:<provider>:<op>:item:<序号>`——同一个 feed 内 `<id>` 重复会让 Atom
校验器直接判文档不合法。

### 缓存

`format` 是缓存键的一部分，所以同一个 feed 的四种格式各占一桶、分别回源。
`?format=rss` 命中不会顺带填好 `?format=uapis` 的缓存。要同时看两种就得各打一次。

### 硬化

- 剔除 XML 1.0 不允许的码点与孤立代理项，成对 emoji 不受影响
- 标题截断到 2000 字符、摘要截断到 1000 字符，**先截断再转义**
- 文本与属性分别转义，`&` 先于其它实体处理
- feed 里的 HTML 一律降为纯文本：`script` / `style` 整块丢弃，实体解一次

### 加新 feed 端点时

在 `src/core/uapis.ts` 的 `reshapeFeed` 里写一条提取器，这个端点就自动获得四种
格式。漏写提取器不会报错，而是让 `format=rss` 以 200 返回原始 JSON——比 400 更
难发现，所以新增端点时记得同时补提取器与 `test/unit.test.ts` 的断言。

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
