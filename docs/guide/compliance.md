# 合规红线

`uapis` 只在下列边界内工作。越过任何一条，实现就可能被上游封禁或被平台判定滥用。

## 1. 不是开放代理

- 上游 host 固定在 registry 里，并且必须同时出现在 `settings.upstream.allowlist`。
- `assertAllowedUpstream()` 只接受 `https`、拒绝内网/回环/链路本地地址、拒绝白名单外的 host。
- 请求 URL 由 `runtime.buildPlan()` 从**结构化 Target**生成，不接受调用方直接传 URL。
- 没有"抓取任意网页"的端点。tier C（付费墙）源必须走付费代理通道，不允许"免费绕过"。
- tier C 的源我们**不直连**：目标 host 只出现在 registry 的 `hosts`（用于校验
  `proxy.host`），真正出网的只有 `egressHosts` 里的代理服务，单独过白名单。
- 付费通道端点一律 `inline: false`。同步回源没有额度节流，
  一次突发就能把当天的付费 credits 打光，因此 miss 时只入队，不在请求路径上花钱。

## 2. 诚实的 User-Agent

UA 固定为 `uapis/1.0 (+https://<SITE_URL>)`，调用方无法覆盖。
`SITE_URL` 必须是你自己控制的域名，部署时先改好再上线——
用别人的域名会误导上游，也会让上游的滥用投诉打错人。

## 3. 上游条款优先

每个 provider 在 `def` 里写明 `tos` 与 `limits`，`/status` 和 `/admin/providers` 会原样暴露。
接入新源之前先读它的条款：

- 禁止抓取的源不接
- 要求署名/回链的源在响应或文档里保留 `attribution`
- 明确禁止代理/转售的源不接

内容版权归原作者。本项目不重新分发内容，只做缓存与转发。

tier C 的判断标准比上面几条更严：**只有条款明确允许代理转发或引用的源才接**，
并且只提取元数据（标题、摘要、栏目、时间），不搬运正文。
`validateRegistry()` 强制 tier C 必须声明 `proxy` 与 `requiredAnyOf`，
但"条款是否允许"是人的判断，代码只保证不会出现免费绕过路径。

## 4. 自我限速

每个 provider 按上游容忍度给最小间隔，并维护每日额度计数。
宁可返回 `503 RATE_LIMITED` 让客户端等，也不打上游的脸。

| provider | 最小间隔 | 依据 |
| --- | --- | --- |
| arxiv | 3000ms | 官方硬要求 ≤1 次/3 秒 |
| github | 6000ms | search 10 次/分钟，取最严的约束 |
| devto | 500ms | 1000 次/5 分钟，自我约束 |
| hackernews | 300ms | 官方未公布限流，自我约束 |
| stackexchange | 300ms | 官方未公布匿名硬限流，自我约束 |
| economist | 10000ms | 付费通道有每次请求的成本，额度由 `quota.proxy.*` 兜底 |
| usgs | 1000ms | 官方未公布限流，公共服务按保守间隔打 |
| crates | 1000ms | 官方未公布限流但要求合理使用，共享资源不打太密 |
| gitlab | 200ms | 匿名 500 次/分钟/IP，取最严约束 |
| musicbrainz | 1000ms | 官方口头约定 1 次/秒；响应头实测 search 端点 400/分钟、实体 1900/分钟 |
| openmeteo | 1000ms | 条款额度 600/分钟、5,000/小时、10,000/天（响应头不含任何限流信息），取最严约束 |

`gate.min_ms` 可整体覆盖（运维/测试用），但调低它等于替上游承担被封的风险。

## 5. 凭据处理

- 只有 `ADMIN_TOKEN` 用 Worker secret。
- 上游 key 存 D1 `settings`，`/admin/settings` 读取时脱敏成 `***set***`，
  错误体与日志里不会出现 key 值。
- 仓库里只有 `.dev.vars.example`，没有真实凭据。

## 6. 隐私

不收集用户数据，不写访问者标识。入口限流用 `cf-connecting-ip` 只存在隔离实例内存里，
60 秒窗口过期即丢，不落 D1。

## 7. 免费额度

不通过压榨免费额度来提供服务：请求预算、CPU、D1 读写、队列 ops 都有设计上限，
`/status` 里能直接看到当前用量和硬边界。额度打满时的行为是明确报错，不是变慢变卡。

付费通道同理：额度用尽返回 `503 QUOTA_EXHAUSTED`，队列消息直接丢弃——
重试不会让 ZenRows 的额度长回来，只会白占 3 次 attempt 和队列操作。

## 免责声明

本项目与 uapis.cn 无任何关联，是从零实现的同类项目。
使用者需自行确保使用方式符合所在地区法律与各上游站点条款。
