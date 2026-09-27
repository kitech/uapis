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
  PubMed E-utilities、Open Library、Wikipedia（MediaWiki Action/REST API）
- **需 key 源**（tier B）：F-Droid、YouTube Data API、Phonark/Last.fm、Telegram Bot API

> 说明：dev.to / GitHub / arXiv 已于 P2 接入，lobsters / itunes / crossref 于 P4 接入（见上）。
> Wikipedia、Open Library、YouTube、Docker Hub、F-Droid 在开发机上网络不通（连接超时），
> MusicBrainz 503、crates.io 403（UA 拦截），因此没有凭印象写进来。
> PyPI、npm registry、PubMed E-utilities 实测可达（HTTP 200），留作下一批候选。
> 接任何新源之前必须先 curl 一遍确认能通、能拿到预期结构。
- **付费墙源**（tier C）：机制已就绪（ZenRows / Jina 双通道、额度、tier C 校验），
  economist 已接入作为参考实现；下一个源同样要先过条款这一关，
  绝不提供免费绕过路径

## 复审节奏

- 上游改条款或改 API 时，同步更新 `tos` / `limits` 字段（它们直接暴露在 `/status`）
- `minIntervalMs` 与每日额度按实际用量调整：看 `/status` 的 `quota` 与 `gate`
- 出现持续 502 时先查 `/status` 的 `gate` 与 `stats`，确认不是本地闸门在挡
