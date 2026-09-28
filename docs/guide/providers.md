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

`github` 的四个端点都标了 `auth: 'optional'`：配了 `gh.token` 自动提额，不配也能匿名调用。
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
| GET | `/api/v1/github/search/repositories` | `q`（必填）、`sort`(stars/forks/help-wanted-issues/updated)、`order`、`per_page`(1-30, 默认 30)、`page`(1 起, 默认 1) |
| GET | `/api/v1/github/android/rising` | `since`(必填, `YYYY-MM-DD`)、`per_page`(1-30, 默认 20)、`page`(1 起, 默认 1) |
| GET | `/api/v1/github/user/{login}` | 路径 `login`：`^[A-Za-z0-9-]{1,39}$` |

- host：`api.github.com`
- 匿名 60 次/小时（core）、10 次/分钟（search）；配 `gh.token` 后 5000 次/小时
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
- **可选 key**：设置 `ncbi.api_key`，填了合法值（8-64 位字母数字/`-`/`_`）才附到上游 query，
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
本项目发 `uapis/1.0 (+SITE_URL)`）。

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
本项目发 `uapis/1.0 (+SITE_URL)`）。

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
