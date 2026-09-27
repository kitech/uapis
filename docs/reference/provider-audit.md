# provider 上线审计

每个数据源接进来之前过一遍这张清单。registry 里的 `def` 字段就是按这张表设计的，
`validateRegistry()` 会在单元测试里拦住漏配项。

## Checklist

| 项 | 要求 | 落在哪个字段 |
| --- | --- | --- |
| 上游是官方 API | 不是绕过付费墙的抓取 | tier |
| 允许代理/转发 | 条款没禁止 | `tos` / `limits` 人工确认 |
| 归属与署名 | 需要署名就写进 `attribution` | `attribution` |
| 凭据 | 匿名可用 → tier A；需 key → tier B；付费 → tier C | `tier` / `auth` |
| key 申请入口 | 给出 signup URL | `auth.signupUrl` |
| host 白名单 | 只列真正要打的 host | `hosts` |
| 白名单同步 | 同步进 `settings.upstream.allowlist` | 自检强制 |
| 最小间隔 | 按上游容忍度给，宁严勿松 | `minIntervalMs` |
| 每日额度 | 写进 `quota.<provider>.default` | seed |
| 参数白名单 | 只暴露必要参数，带类型和上下界 | `params` |
| 路径参数 | 必须有正则校验 | `runtime.buildPlan` |
| 输出形态 | 能透传就透传 | `passthrough` |
| CPU 估算 | 解析成本写下来，超 5ms 就要重新设计 | `costMs` / `parseCostMs` |
| 缓存档位 | 选对 `resource` | `resource` |
| 回归测试 | 至少一条集成测试 | `test/api.test.ts` |
| 付费通道（仅 tier C） | 声明 `proxy` + `requiredAnyOf`，`inline: false` | 自检强制 |

## 当前状态

### hackernews · tier A ✅

- 上游：`https://hn.algolia.com/api/v1`（Algolia 官方 HN 索引）
- 凭据：无需
- 归属：内容版权归原作者
- 条款：<https://hn.algolia.com/api>
- 限流：官方未公布硬性限流，本项目 300ms 最小间隔自我约束
- 端点：`search`（search 档）、`item`（item 档）、`user`（profile 档）
- 全部 `passthrough`，CPU ≈ 0
- 路径参数：`item` 用 `^[0-9]{1,12}$`，`user` 用 `^[A-Za-z0-9_-]{1,40}$`
- 额度：`quota.hackernews.default` = 10000

### stackexchange · tier B ✅

- 上游：`https://api.stackexchange.com/2.3`
- 凭据：`se.key`（<https://stackapps.com/apps/oauth/register> 注册，约 10000 次/天；匿名约 300 次/天）
- 归属：内容版权归各站点作者，遵循 CC BY-SA
- 条款：<https://stackoverflow.com/help/site-terms>
- 额度文档：<https://api.stackexchange.com/docs/usage>
- 端点：`question`（item 档）、`search`（search 档）、`user`（profile 档）、`tags`（search 档）
- 全部 `passthrough`；key 作为 query 参数注入上游
- `site` 参数走 `^[a-z0-9][a-z0-9.-]{1,34}$`，默认 `stackoverflow`
- 额度：`quota.stackexchange.default` = 9500（留 5% 余量）
- 未配置 key 时返回 `503 PROVIDER_UNCONFIGURED`，`details.setting = "se.key"`

### github · tier A- ✅

- 上游：`https://api.github.com`
- 凭据：`gh.token` 可选（fine-grained PAT，<https://github.com/settings/personal-access-tokens>）；
  匿名 core 60 次/小时、search 10 次/分钟，token 5000 次/小时
- 端点全部标 `auth: 'optional'`，匿名可用；`/status` 报 `auth_required=false`
- 闸门 6000ms：provider 级闸门取最严的约束（search 10 次/分钟）
- token 走 `Authorization: Bearer` 头，不进 query（不进日志、不进缓存键）
- 端点：`repo/{owner}/{repo}`（item 档）、`search/repositories`（search 档）、`user/{login}`（profile 档）
- 只取元数据；raw/大文件域不进白名单
- 额度：`quota.github.default` = 4500

### devto · tier A- ✅

- 上游：`https://dev.to/api`
- 凭据：公开 API 零 key，约 1000 次/5 分钟（按 IP）
- 端点：`articles`（feed 档）、`article/{id}`（item 档）、`user/{username}`（profile 档）
- 全部透传；闸门 500ms；`state` 非法值在 runtime 400 并回 `details.allowed`
- 归属：文章 CC BY-NC-SA 4.0
- 额度：`quota.devto.default` = 9000

### arxiv · tier A- ✅

- 上游：`https://export.arxiv.org/api`
- 凭据：零 key
- **官方硬要求**：≤1 次/3 秒（闸门 3000ms）、结果至少缓存 15 分钟（`archive` 档）、
  必须带可识别 UA（`fetcher` 强制注入带站点 URL 的 UA，调用方无法覆盖）
- 唯一非透传源：`ProviderRuntime.transform` 把 Atom XML 转 JSON，零新依赖，
  `parseCostMs = 2`；解析器只认 arXiv `api/query` 的固定结构
- `search_query` 走字符白名单（拒 `&`/`%`），路径参数 `^\d{4}\.\d{4,5}(v\d{1,2})?$`
- 端点：`search`、`paper/{id}`，都是 archive 档
- 额度：`quota.arxiv.default` = 4000

### lobsters · tier A ✅

- 上游：`https://lobste.rs`（站点自带的 JSON 接口）
- 凭据：零 key
- 归属：故事版权归各提交者，内容按 CC BY-SA 3.0
- 条款：<https://lobste.rs/about>
- 端点：`hot` / `newest` / `tag/{tag}`（feed 档）、`story/{id}`（item 档）
- 全部透传；闸门 1000ms；官方未公布硬性限流
- **接之前 curl 过才写**：官方路径是 `hottest.json` / `newest.json` / `t/{tag}.json` / `s/{id}.json`，
  直觉路径（`hot.json` / `new.json` / `recent.json`）全是 404
- 上游无分页（多余分页参数被忽略），因此不暴露分页参数
- 额度：`quota.lobsters.default` = 6000

### itunes · tier A- ✅

- 上游：`https://itunes.apple.com`（Apple 公开 Search API）
- 凭据：零 key；条款 <https://performance-partners.apple.com/terms>
- 端点：`search`（search 档）、`lookup`（item 档）
- 全部透传；闸门 500ms；`limit` 卡 200（上游上限）
- `term` 字符白名单（`&` 保留但必须编码，`=`/`<`/`/`/`%` 拒掉）；`media` 枚举在 runtime 校验
- 分页用 `offset` 而不是 `page`（跟上游），已在文档标注
- 归属：封面与简介版权归 Apple 及各自权利人，只做元数据转发
- 额度：`quota.itunes.default` = 9000

### crossref · tier A- ✅

- 上游：`https://api.crossref.org`
- 凭据：零 key；REST API 文档 <https://www.crossref.org/documentation/retrieve-metadata/rest-api/>
- 端点：`search`（search 档，`rows` ≤ 30）、`work/{doi}`（item 档）
- 全部透传（`{status, message}` 信封原样返回）；闸门 1000ms
- `doi` 走 `multiSegment`，前缀固定 `10.`，额外拒 `..`；老 DOI 里的 `<>` 形态不支持
- polite pool：可选 `crossref.mailto`，填了合法邮箱才带 `mailto`；填错当没配
- 归属：题录版权归出版方与 Crossref
- 额度：`quota.crossref.default` = 5000

### pypi · tier A ✅

- 上游：`https://pypi.org/pypi`
- 凭据：零 key；文档 <https://warehouse.pypa.io/api-reference/json/>
- 端点：`project/{package}`（search 档，**transform**）、`release/{package}/{version}`（item 档，透传）
- 依据实测定的 transform：`requests` 约 193KB、`numpy` 约 1.6MB，其中绝大部分是
  `releases`（全部历史版本）；README 全文 `description` 另有 50KB+
- transform 只留选定 `info` 字段 + `versions` + 当前版本 `files` + `last_serial` + `vulnerabilities`；
  上游返回非 JSON 直接当上游错误，不落库
- 用真实 `requests` 响应（192,960B）跑 transform 得 4,403B，163 个历史版本折叠成 `versions`
- 包名按 PEP 503 归一化（`Django_REST` → `django_rest`），版本号白名单覆盖 PEP 440 常用形态
- 不做 simple index（100KB+ HTML 锚点列表，本项目不解析 HTML）
- 归属：包元数据与代码版权归各自作者/维护方
- 额度：`quota.pypi.default` = 6000

### npm · tier A- ✅

- 上游：`https://registry.npmjs.org`
- 凭据：零 key；文档 <https://github.com/npm/registry/blob/master/docs/REGISTRY-API.md>
- 端点：`latest/{name}`、`version/{name}/{version}`（均 item 档，透传）、`search`（search 档，透传）
- `name` 走 `multiSegment`（scoped 包 `@types/node` 天然多段），小写字符白名单
- `version` 端点按 `@scope/` 边界切包名与版本，段数不对直接 400
- **不做 packument**：abbreviated 文档 `react` 2.9MB、`@types/node` 2.3MB，
  完整文档 `lodash` 248KB，都超出本项目 512KB 单响应上限或会打满缓存
- `search` 只放行 `text`/`size`/`from`/`sort`，其余 query 400
- 归属：包元数据与代码版权归各自作者/维护方，npm registry 只做分发
- 额度：`quota.npm.default` = 8000

### pubmed · tier A- ✅

- 上游：`https://eutils.ncbi.nlm.nih.gov/entrez/eutils`
- 凭据：**零 key 可用**；可选 `ncbi.api_key`（官方 3 → 10 次/秒）；
  申请 <https://www.ncbi.nlm.nih.gov/account/settings/>；
  使用规范 <https://www.ncbi.nlm.nih.gov/books/NBK25501/>
- 端点：`search`（esearch，search 档）、`summary`（esummary `version=2.0`，item 档），均透传 JSON
- **必须自己挡的坑**：空 `term` 与非法 PMID 上游都返回 **HTTP 200 + 错误体**
  （"Empty term and query_key - nothing todo" / `{"error":"Invalid uid ..."}`），
  放行就会把错误体缓存下来
- 不做 efetch（只能返回 XML/MEDLINE 文本，要引正则解析器）
- 闸门 400ms（≈2.5 次/秒，无 key 也在官方 3 次/秒内）
- `ncbi.api_key` 只发往 eutils（白名单唯一出口），不进缓存键；填错当没配
- 归属：题录版权归作者与出版商，PubMed 只做索引
- 额度：`quota.pubmed.default` = 10000

### usgs · tier A ✅

- 上游：`https://earthquake.usgs.gov/fdsnws/event/1`
- 凭据：零 key；数据属美国联邦政府**公有领域**；
  使用说明 <https://earthquake.usgs.gov/fdsnws/event/1/>、
  版权与署名 <https://www.usgs.gov/information-policies-and-instructions/copyrights-and-credits>
- 端点：`earthquakes`（FDSN `/query`，feed 档，透传 GeoJSON）、
  `earthquakes/{id}`（单事件，item 档，约 6KB）
- **不用 `feed/v1.0/summary/*.geojson`**：固定 feed 体积跨度过大
  （all_hour 4.6KB → all_month **7.5MB**），且实测拼错路径上游回
  **200 + `404 File Not Found` 纯文本**；`/query` 可控（limit=200 → 145KB）
- `limit` 硬卡 200；`minmagnitude` 是小数而框架只校验 `integer`，
  格式与 0-10 区间在 runtime 兜住
- 超时 8s + 关闭重试（实测 limit=200 需 4.8s，3s 默认超时不够）
- 事件 id 白名单 `^[a-z0-9]{5,20}$`；形态合法但不存在的 id 由上游回 404，不猜成 400
- 闸门 1000ms；额度：`quota.usgs.default` = 4000

### gitlab · tier A- ✅

- 上游：`https://gitlab.com/api/v4`
- 凭据：公开项目**零 key**；文档 <https://docs.gitlab.com/ee/api/>、
  条款 <https://about.gitlab.com/terms/>
- 端点：`projects`（搜索，search 档）、`project/{id}`（profile 档）、
  `commits`（feed 档），均透传 JSON
- 只接**只读公开**端点：私有项目、MR、issue 写操作一概不碰
- `project/{id}` 走 `multiSegment`（子组可多层），runtime 负责编成上游要的
  单段 URL 编码形式 `group%2Fsub%2Fproject`；数字项目 id 原样透传
- `commits` 的 `project` 放 query 而非路径，避免与贪婪多段参数抢路由
- 搜索固定 `simple=true` 精简字段（20 个项目约 28KB）
- 匿名配额实测 `ratelimit-limit: 500`/分钟/IP；闸门 200ms；额度 `quota.gitlab.default` = 5000
- 归属：项目元数据与代码版权归各项目作者/组织，GitLab 只做托管与索引

### crates · tier A- ✅

- 上游：`https://crates.io/api/v1`
- 凭据：零 key，但**要求可识别的 User-Agent**（本项目发 `uapis/1.0 (+SITE_URL)`）；
  数据访问文档 <https://crates.io/data-access>、站点条款 <https://crates.io/policies>
- 端点：`crate/{name}`（**transform**）、`crate/{name}/{version}`（透传，1.7KB）、
  `search`（透传，2.1KB）
- `crate` 做 transform 的原因同 PyPI：**99% 体积是 `versions`**
  （serde 441KB / 316 版；windows-sys 上游 506KB，已贴着 512KB 上限），
  折叠成 `{num, yanked, created_at, downloads, license, rust_version, checksum, crate_size}`
  后：windows-sys 506KB → 6.5KB、serde 441KB → 77KB、rand 139KB → 24KB
- 官方未公布硬性限流但要求合理使用，共享资源别打太密：闸门 1000ms；
  额度 `quota.crates.default` = 3000
- 归属：crate 元数据与代码版权归各发布者，crates.io 只做索引与托管

### economist · tier C ⚠️ 需自行确认条款

- 目标 host：`www.economist.com`——**我们不直连**，只作为 `proxy.host` 的校验对象；
  真正出网的是 `egressHosts = [api.zenrows.com, r.jina.ai]`
- 通道：`zenrows.key` / `jina.key` 任一即可（`requiredAnyOf`），两条都空时
  `503 PROVIDER_UNCONFIGURED`，`details.any_of` 列出该配哪个
- 端点：`article/{slug}`（wall 档，24h 新鲜 + 7 天 stale），`inline: false`——
  首次请求只入队，返回 `503 REBUILDING` + `X-Cache: QUEUED`
- 只提取 `og:title` / `og:description` / `article:section` / 发布时间，**不搬运正文**
- slug 走 `multiSegment`（含 `/`），白名单字符 + 显式拒 `..`，目标 host 写死在常量里
- 额度：`quota.proxy.zenrows` = 33、`quota.proxy.jina` = 50；打满后消息直接丢弃不重试
- 归属：内容版权归 The Economist 所有
- 条款：<https://www.economist.com/help/legal/terms-of-use>
- **⚠️ 上线前自己再读一遍条款**：本项目只取标题与摘要这类元数据，不提供免费绕过，
  但"是否允许代理转发/引用"是条款解释问题，不是代码能保证的事。
  不同意就把这个 provider 从 `src/providers/index.ts` 里摘掉，
  代理机制本身（`pickChannel` / `quota.proxy.*` / tier C 校验）与它无关

## 计划中

以下源已列入路线图，接入时逐条过上面的 checklist：

- **零 key 官方源**（tier A-）：Reddit 官方 API（现需 OAuth，匿名抓取违反条款，排到最后）、
  Open Library、Wikipedia（MediaWiki Action/REST API）
- **需 key 源**（tier B）：F-Droid、YouTube Data API、Phonark/Last.fm、Telegram Bot API

> 说明：dev.to / GitHub / arXiv 已于 P2 接入，lobsters / itunes / crossref 于 P4 接入，
> PyPI / npm registry / PubMed 于 P5 接入，USGS / GitLab / crates.io 于 P6 接入（见上）。
> P6 的探测结论（**都实测过，不是凭印象**）：
> crates.io 之前记的"403 UA 拦截"是**探测姿势问题**——带上项目的诚实 UA 就能通；
> 反而是被我们探测脚本漏掉的 `gitlab.com` 与 `earthquake.usgs.gov` 一直可用。
> Wikipedia、Open Library、Docker Hub、F-Droid 仍然连接超时；
> MusicBrainz 503（服务器忙）；NWS `api.weather.gov` 的 `/alerts/active` 无参调用
> **1MB 且 20s 超时**（`limit` 参数还报 400），体积不适合做缓存条目。
> 接任何新源之前必须先 curl 一遍确认能通、能拿到预期结构，
> 并按单响应 512KB 上限决定是透传还是 transform。
- **付费墙源**（tier C）：机制已就绪（ZenRows / Jina 双通道、额度、tier C 校验），
  economist 已接入作为参考实现；下一个源同样要先过条款这一关，
  绝不提供免费绕过路径

## 复审节奏

- 上游改条款或改 API 时，同步更新 `tos` / `limits` 字段（它们直接暴露在 `/status`）
- `minIntervalMs` 与每日额度按实际用量调整：看 `/status` 的 `quota` 与 `gate`
- 出现持续 502 时先查 `/status` 的 `gate` 与 `stats`，确认不是本地闸门在挡
