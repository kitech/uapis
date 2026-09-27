# 合规红线

`uapis` 只在下列边界内工作。越过任何一条，实现就可能被上游封禁或被平台判定滥用。

## 1. 不是开放代理

- 上游 host 固定在 registry 里，并且必须同时出现在 `settings.upstream.allowlist`。
- `assertAllowedUpstream()` 只接受 `https`、拒绝内网/回环/链路本地地址、拒绝白名单外的 host。
- 请求 URL 由 `runtime.buildPlan()` 从**结构化 Target**生成，不接受调用方直接传 URL。
- 没有"抓取任意网页"的端点。tier C（付费墙）源必须走付费代理通道，不允许"免费绕过"。

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

## 4. 自我限速

即使上游没写限流，也按最小间隔自我约束（当前所有 provider 300ms），
并维护每日额度计数。宁可返回 `503 RATE_LIMITED` 让客户端等，也不打上游的脸。

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

## 免责声明

本项目与 uapis.cn 无任何关联，是从零实现的同类项目。
使用者需自行确保使用方式符合所在地区法律与各上游站点条款。
