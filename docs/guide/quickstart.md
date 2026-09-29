# 快速上手

## 1. 本地跑起来

```bash
npm install
cp .dev.vars.example .dev.vars      # 填入 ADMIN_TOKEN
npm run db:migrate:local            # 建 D1 五张表
npm run db:seed:local               # 可选：写入示例 settings
npm run dev
```

`wrangler dev` 会同时模拟 D1、Queues 和 Cache API，本地就能看到完整的缓存行为。

## 2. 发第一个请求

```bash
curl -i http://localhost:8787/api/v1/hackernews/search?q=cloudflare
```

响应体就是上游 Algolia API 的 JSON，**没有信封**。头里有：

```text
x-request-id: 8f0b...            # 排障用，可把你自己的 X-Request-ID 带进来
x-cache: REFRESH                 # 第一次回源并写缓存
ratelimit-policy: 60;w=1
ratelimit: r=59;t=42
```

再打一次：

```bash
curl -i http://localhost:8787/api/v1/hackernews/search?q=cloudflare
```

`x-cache` 变成 `HIT`，而且这次完全不碰上游。

## 3. 读懂 X-Cache

| 值 | 含义 | 是否消耗上游额度 |
| --- | --- | --- |
| `HIT` / `HIT-T1` | 命中 T1 Cache API 或 T2 D1 | 否 |
| `STALE` | 已过期但在 stale 窗口内，同时后台异步刷新 | 本次不消耗 |
| `REFRESH` | 缓存未命中，本次同步回源并写缓存 | 是 |
| `STALE-FALLBACK` | 回源失败，返回超出 stale 窗口的旧值 | 尝试过 |
| `NEGATIVE` | 命中负缓存，原样回放上游错误 | 否 |
| `QUEUED` | 关闭内联回源后已入队，等 `Retry-After` 秒再试 | 否 |

想要"宁慢勿等"的语义，加 `Prefer: respond-async`：

```bash
curl -i -H 'Prefer: respond-async' http://localhost:8787/api/v1/hackernews/item/999
```

入队成功返回 `202 ACCEPTED`，否则 `503 REBUILDING` + `Retry-After: 1`。

## 4. 配一个需要 key 的数据源

Stack Exchange 是 tier B，未配置 key 时返回 `503 PROVIDER_UNCONFIGURED`：

```bash
curl -X PUT http://localhost:8787/admin/settings \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"stackexchange.api_key":"YOUR_KEY"}'
```

拿 key：<https://stackapps.com/apps/oauth/register>（本项目只用到免登录的 2.3 API key 部分）。

## 5. 验证与部署

```bash
npm run typecheck        # tsc --noEmit
npm test                 # 240 个离线测试，不发真实请求
npm run deploy:dry       # 构建文档 + dry-run，检查产物 < 64MiB
```

要发布到线上看 **[部署上线](/guide/deployment)**：建 D1、建队列、迁移、部署、设
`ADMIN_TOKEN`、绑域名，以及回滚 / Time Travel / 只读模式 / 额度监控这些日常运维。

## 6. 下一步

- [数据源与凭据](/guide/providers)：每个 provider 的凭据、上游条款与限流
- [部署上线](/guide/deployment)：把自己的实例发出去，以及上线后的运维
- [限流与免费额度](/guide/rate-limits)：三层限速是怎么配合的
- [错误与排障](/guide/errors)：错误码表与常见问题
