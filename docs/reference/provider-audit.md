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

## 计划中

以下源已列入路线图，接入时逐条过上面的 checklist：

- **零 key 官方源**（tier A-）：Reddit 官方 API、GitHub REST（可选 token）、
  arXiv、PubMed、Open Library、Wikipedia/DuckDuckGo 摘要等
- **需 key 源**（tier B）：Dev.to、ArXiv（可选）、F-Droid
- **付费墙源**（tier C）：必须走 ZenRows / Jina 双通道，`proxy.mode` 控制，
  绝不提供免费绕过路径

## 复审节奏

- 上游改条款或改 API 时，同步更新 `tos` / `limits` 字段（它们直接暴露在 `/status`）
- `minIntervalMs` 与每日额度按实际用量调整：看 `/status` 的 `quota` 与 `gate`
- 出现持续 502 时先查 `/status` 的 `gate` 与 `stats`，确认不是本地闸门在挡
