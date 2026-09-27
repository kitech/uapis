# 错误与排障

## 错误信封

失败时统一返回：

```json
{
  "code": "UPSTREAM_ERROR",
  "message": "upstream hackernews responded 503",
  "details": { "provider": "hackernews", "upstream_status": 503 }
}
```

`details` 始终是可读的诊断信息，不含任何凭据。上游 4xx/5xx 会被映射成统一语义，
响应体是重新生成的（不直接回放上游原文），只有负缓存命中时才原样回放。

## 错误码表

| code | HTTP | 含义 | 客户端动作 |
| --- | --- | --- | --- |
| `INVALID_ARGUMENT` | 400 | 请求整体不合法 | 修请求 |
| `INVALID_PARAMETER` | 400 | 参数名未声明 / 类型错 / 越界 | 看 `details.allowed` / `details.maximum` |
| `UNAUTHORIZED` | 401 | 管理接口缺 token 或 token 错 | 补 `Authorization: Bearer` |
| `FORBIDDEN` | 403 | 已知身份但不允许 | 检查 scope |
| `NOT_FOUND` | 404 | 路由不存在或上游 404 | 检查路径 |
| `NO_MATCH` | 404 | 路径合法但没有结果 | 正常业务结果 |
| `FILE_TOO_LARGE` | 413 | 上游响应超过 2MB 上限 | 用更精确的查询 |
| `RATE_LIMITED` | 429 / 503 | 入口限流（429）或 provider 闸门冷却（503） | 看 `Retry-After` / `details.retry_in` |
| `INTERNAL_ERROR` | 500 | Worker 内部异常 | 带上 `X-Request-ID` 反馈 |
| `UPSTREAM_ERROR` | 502 | 上游 5xx | 稍后重试，会命中负缓存 |
| `PROVIDER_UNCONFIGURED` | 503 | 缺 key | 配 `details.setting` 指定的设置项 |
| `QUOTA_EXHAUSTED` | 503 | 今日队列/上游额度用尽 | 等 UTC 日切或调大额度 |
| `REBUILDING` | 503 | 已入队但还没有数据 | 按 `Retry-After` 重试 |
| `SERVICE_UNAVAILABLE` | 503 | 只读/维护模式 | 看 `details.mode` |
| `UPSTREAM_TIMEOUT` | 504 | 上游超时 | 缩小查询范围 |
| `ACCEPTED` | 202 | 配合 `Prefer: respond-async`，已入队 | 轮询同一路径 |

## 排障顺序

1. 看 `X-Request-ID`，把同一个值带进日志搜索。
2. 看 `X-Cache`：
   - `HIT`/`HIT-T1` → 不是缓存问题
   - `NEGATIVE` → 上游之前失败过，6 小时内不再回源，等 TTL 或 `POST /admin/rebuild`
   - `QUEUED` → 内联回源关着，或者在队列额度里
3. `/status` 看 `gate`（哪个 provider 冷却中）、`queue.used`、`cache.rows`、
   `providers[].configured`。
4. `X-RateLimit-Remaining: 0` 就是入口限流，不是上游问题。

## 常见问题

**为什么第一次是 `REFRESH` 第二次才是 `HIT`？**
`REFRESH` 表示本次同步回源并写了缓存，这是设计行为。

**`503 RATE_LIMITED` 但我只有一个请求？**
provider 闸门是按 provider 全局的最小间隔（当前 300ms）。别的 key 刚刷新过同一个 provider，
你的请求就进冷却了。可以在测试/自用场景把 `gate.min_ms` 调小。

**`INVALID_PARAMETER` 里 `allowed` 是什么？**
当前端点声明的白名单参数名。白名单之外的参数一律 400，不做静默忽略——
静默忽略会让用户误以为参数生效了。

**改了 `/admin/settings` 但行为没变？**
设置在隔离实例内记忆化 30 秒，跨实例最长 30 秒生效。

**`502` 之后一直 `502`？**
负缓存。看 `POST /admin/rebuild` 手动重建，或把 `cache.negative_ttl` 调小。

**Cron 会不会把热数据删掉？**
不会。Cron 只删 `expires_at < now` 的行，每批 300 行；stale 窗口内的数据不会被删，
回源失败时还能作为兜底返回。
