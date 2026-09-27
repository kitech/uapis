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

## 计划中

以下源已列入路线图，接入时逐条过上面的 checklist：

- **零 key 官方源**（tier A-）：Reddit 官方 API（现需 OAuth，匿名抓取违反条款，排到最后）、
  PubMed E-utilities、Open Library、Wikipedia（MediaWiki Action/REST API）
- **需 key 源**（tier B）：F-Droid、YouTube Data API、Phonark/Last.fm、Telegram Bot API

> 说明：dev.to / GitHub / arXiv 已于 P2 接入（见上）。Wikipedia 与 Open Library
> 在开发机上网络不通（连接超时），无法实测响应结构，因此没有凭印象写进来。
> 接任何新源之前必须先 curl 一遍确认能通、能拿到预期结构。
- **付费墙源**（tier C）：必须走 ZenRows / Jina 双通道，`proxy.mode` 控制，
  绝不提供免费绕过路径

## 复审节奏

- 上游改条款或改 API 时，同步更新 `tos` / `limits` 字段（它们直接暴露在 `/status`）
- `minIntervalMs` 与每日额度按实际用量调整：看 `/status` 的 `quota` 与 `gate`
- 出现持续 502 时先查 `/status` 的 `gate` 与 `stats`，确认不是本地闸门在挡
