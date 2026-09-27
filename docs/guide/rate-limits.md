# 限流与免费额度

## 三层限速

| 层 | 作用对象 | 默认值 | 存储 |
| --- | --- | --- | --- |
| 入口限流 | 按 `cf-connecting-ip` 的固定窗口 | 60 次/分钟 | 隔离实例内存 |
| provider 闸门 | 上游请求最小间隔 | registry 里每个 provider 自带（当前 300ms） | D1 `gate` 表 |
| 额度计数 | 每天每个 provider / 队列的调用次数 | SE 9500、HN 10000、队列 3000 | D1 `quota` 表（按天） |

三层都可以用 `/admin/settings` 调：

| 键 | 说明 |
| --- | --- |
| `ratelimit.rpm` | 入口每分钟请求数，`0` 表示不限流 |
| `gate.min_ms` | 覆盖所有 provider 的最小上游间隔（毫秒），空值 = 用 registry 值 |
| `queue.daily_limit` | 队列每日硬上限 |
| `queue.soft_limit` | 队列软上限，超过后 `/status` 标记 `throttled` |
| `quota.<provider>.<channel>` | 单 provider 单 channel 的每日额度 |
| `cache.soft_rows` | D1 缓存行软上限，超过后只允许覆盖已有行 |
| `cache.negative_ttl` | 负缓存秒数，默认 21600（6h） |

## 响应头

命中限流前每个响应都带：

```text
RateLimit-Policy: 60;w=1
RateLimit: r=59;t=42
X-RateLimit-Limit: 60
X-RateLimit-Remaining: 59
X-RateLimit-Reset: 42
```

超限时 `429 RATE_LIMITED`，`details` 里带 `limit` 与 `window_seconds`，并给 `Retry-After`。

provider 闸门冷却时是 `503 RATE_LIMITED`，`details.retry_in` 告诉你等几秒——这是"别打上游"的信号，
不是"你被本服务限流"。队列消费遇到它会 `retry` 而不是丢弃。

## 免费额度边界

| 资源 | 免费额度 | 本项目的设计目标 |
| --- | --- | --- |
| Worker 请求 | 100,000/天 | 靠 T1/T2 命中吸收，热门 key 基本不回源 |
| CPU | 10ms/次 | 上游 JSON 原样透传，零解析（passthrough 端点 CPU ≈ 0） |
| D1 行读 | 5,000,000/天 | 设置记忆化 30s；命中路径 1 次行读 |
| D1 行写 | 100,000/天 | 命中不写；Cron 每 2 小时删 300 行 |
| Queues ops | 10,000/天 | 队列日限 3000、软限 2700，留 3 倍余量 |
| Logs | 200,000 events/天 | 只在异常/刷新失败时打日志 |

这些数字写死在 `/status` 的 `free_tier_budget` 字段里，方便挂监控告警。

## 为什么缓存分两层

```
请求 → T1 (Cache API) → T2 (D1) → 队列/内联回源
        免费、走边缘       1 次行读   消耗额度
```

- T1 命中**不写** D1——省写额度，所以 T1 命中不会回填 T2。
- T2 命中只读不写。
- 只有回源成功或负缓存才写 D1。
- 超过 1KB 的 body 在 D1 里存 gzip；小于 1KB 直接存原文，压缩开销不划算。
- T1 用 `Cache-Control: max-age`（`caches.default.put` 在当前 workerd 只有两参重载），
  过期时间由 Cache API 自己管；D1 用 `expires_at` / `stale_until` 两列。

## TTL 表

| 资源 | 新鲜期 | stale 窗口 |
| --- | --- | --- |
| search | 60s | 10min |
| feed | 2min | 7天 |
| item | 10min | 30天 |
| profile | 5min | 7天 |
| passthrough | 5min | 1天 |
| wall | 24h | 7天 |
| error（负缓存） | 6h | 6h |

`GET /admin/cache/policies` 可以直接读这份表。

## 预热

```bash
curl -X PUT https://<你的域名>/admin/settings \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"warm.list":"v1:hackernews:item:1:q|hackernews|item:1\nv1:hackernews:item:2:q|hackernews|item:2"}'
```

每条一行 `缓存键|provider|target`，`*/30 * * * *` 的 Cron 会按顺序刷一遍。
格式和缓存键不匹配的行会被跳过并计数，方便你从日志里发现拼错。
