# 限流与免费额度

## 三层限速

| 层 | 作用对象 | 默认值 | 存储 |
| --- | --- | --- | --- |
| 入口限流 | 按 `cf-connecting-ip` 的固定窗口 | 60 次/分钟 | 隔离实例内存 |
| provider 闸门 | 上游请求最小间隔 | registry 里每个 provider 自带（当前 300ms） | D1 `gate` 表 |
| 额度计数 | 每天每个 provider / 队列 / 付费通道的调用次数 | SE 9500、HN 10000、GH 4500、DEV 9000、arXiv 4000、lobsters 6000、iTunes 9000、Crossref 5000、PyPI 6000、npm 8000、PubMed 10000、队列 3000、ZenRows 33、Jina 50 | D1 `quota` 表（按天） |

三层都可以用 `/admin/settings` 调：

| 键 | 说明 |
| --- | --- |
| `ratelimit.rpm` | 入口每分钟请求数，`0` 表示不限流 |
| `gate.min_ms` | 覆盖所有 provider 的最小上游间隔（毫秒），空值 = 用 registry 值 |
| `queue.daily_limit` | 队列每日硬上限 |
| `queue.soft_limit` | 队列软上限，超过后 `/status` 标记 `throttled` |
| `quota.<provider>.<channel>` | 单 provider 单 channel 的每日额度；`proxy.zenrows` / `proxy.jina` 是付费通道额度 |
| `crossref.mailto` | 可选，填合法邮箱即带 `mailto` 进 Crossref polite pool；填错当没配 |
| `ncbi.api_key` | 可选，NCBI E-utilities API key（3 → 10 次/秒）；填合法值才带上，填错当没配，不进缓存键 |
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

反过来，`QUOTA_EXHAUSTED` 与 `PROVIDER_UNCONFIGURED` 一律**直接丢弃**不重试：
等一会并不会让额度长回来，重试只会白占 3 次 attempt 和队列操作。

## 付费通道额度

tier C 源（The Economist）不直连，每次回源都要花钱，所以额度单独记：

| 维度 | 键 | 默认 | 说明 |
| --- | --- | --- | --- |
| 通道 | `quota.proxy.zenrows` | 33 | ZenRows credits / 天，`0` 表示不限 |
| 通道 | `quota.proxy.jina` | 50 | Jina 请求数 / 天，`0` 表示不限 |

扣费点在 `refreshTarget()` 拿到 `buildPlan()` 之后、真正发请求之前，
并且记在**实际选中的那条通道**上——ZenRows 没额度时会自动走 Jina，
这时就不能把账记到 ZenRows 头上。

`proxy.mode` 写成 `zenrows` 或 `jina` 是**强制**走那一条（该通道没 key 就 503）；
`off` / `auto` 都表示"没有偏好，按可用性自动选"。
它只对声明了 `proxy` 的端点有意义，不会让任何源绕过付费通道直连。

`/status` 的 `providers[].channels` 会同时给出两条通道的 `configured` 与 `credits`，
两条都没配时该 provider 的 `status` 是 `unconfigured`：
`["zenrows.key","jina.key"]`（见 `details.any_of`）。

## 免费额度边界

每次**真正回源**（含内联与队列消费）扣 1，扣到 0 就不再打上游，直接
`503 QUOTA_EXHAUSTED` + `Retry-After: 3600`：

| 维度 | 记在哪 | 说明 |
| --- | --- | --- |
| 直连源 | `quota.<provider>.default` | HN 10000、SE 9500、GH 4500、DEV 9000、arXiv 4000、lobsters 6000、iTunes 9000、Crossref 5000、PyPI 6000、npm 8000、PubMed 10000 |
| 付费通道（tier C） | `quota.proxy.zenrows` / `quota.proxy.jina` | 记在**实际选中**的那条通道上 |

计费点的位置有讲究：

- **在闸门之后、`buildPlan()` 之后**——非法参数（400）永远不消耗额度
- **在缓存命中路径之外**——命中 T1/T2 一次都不扣，所以额度实际消耗 ≈ 上游请求数，
  热门 key 基本不花钱
- **内部重试算 1 次**：`fetchUpstream` 自己的 5xx/429 退避重试不再单独扣，
  免得一次故障把当天额度打光
- **不写负缓存**：额度是我们自己的状态，不是上游的。等日切或调大额度就会恢复，
  缓存一个 503 只会让恢复之后还继续报错

`validateRegistry` 的配套自检 `missingQuotaDefaults()` 要求每个直连 provider
都有正的 `quota.<name>.default`：`0` 表示不限，而"忘了配"和"故意不限"效果一样，
所以都算漏配，单元测试会红。tier C 不参与这项检查（它记在通道维度）。

`/status` 的 `providers[].credits` 对直连源一律给出 `used/limit/remaining`；
tier C 报 `null`，真实用量看 `providers[].channels[].credits`，避免两处数字打架。
调额度用 `PUT /admin/settings`（`quota.<provider>.default`），
误扣多了用 `POST /admin/quota/reset {"provider":"hackernews"}`。

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
| archive | 15min | 1天 |
| wall | 24h | 7天 |
| error（负缓存） | 6h | 6h |

`archive` 是给「上游明确要求长缓存」准备的档位：arXiv 官方要求结果至少缓存 15 分钟，
所以它的两个端点都用这一档，而不是 60s 的 `search`。

`GET /admin/cache/policies` 可以直接读这份表。

## 预热

```bash
curl -X PUT https://<你的域名>/admin/settings \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"warm.list":"v3:hackernews:item:item:1:q|hackernews|item:1\nv3:hackernews:item:item:2:q|hackernews|item:2"}'
```

每条一行 `缓存键|provider|target`，`*/30 * * * *` 的 Cron 会按顺序刷一遍。
格式和缓存键不匹配的行会被跳过并计数，方便你从日志里发现拼错。
