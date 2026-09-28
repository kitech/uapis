# 部署上线

两件事：**把自己的实例跑起来**（第一部分），以及**跑起来之后怎么管**（第二部分）。
只想发第一个请求，看 [快速上手](/guide/quickstart) 就够了。

## 前置条件

| 项 | 要求 | 本项目实测值 |
| --- | --- | --- |
| Node | ≥ 22.12（`engines`） | v24.21.0 / npm 12.0.2 |
| 账号 | Cloudflare Free 计划即可，全部资源在免费额度内 | — |
| 登录 | `npx wrangler login`，或 `CLOUDFLARE_API_TOKEN` 环境变量 | — |

本地门槛，**部署前必须全绿**：

```bash
npm install
npm run typecheck     # tsc --noEmit
npm test              # 232 个离线用例，不发真实请求
npm run deploy:dry    # 构建文档 + dry-run，产物 245.22 KiB / gzip 57.33 KiB
```

Worker 体积上限 64 MiB，本项目 gzip 后 57 KiB，余量充足。
`npm test` 全程用 MSW 拦截出站，**不会**碰真实上游，可以放心跑。

## 第一部分 · 首次部署自己的实例

### 步骤 1 · 建 D1 数据库

```bash
npx wrangler d1 create uapis --location apac
```

回显里的 `database_uuid` 填进 `wrangler.jsonc`：

```jsonc
"d1_databases": [
  {
    "binding": "DB",
    "database_name": "uapis",
    "database_id": "把这里换成刚拿到的 UUID",   // 仓库里是 32 个 0 的占位符
    "migrations_dir": "migrations"
  }
]
```

> **占位符不会触发自动建库。** wrangler 的自动资源开通（auto-provisioning）只在
> `database_id` 这个键**整个缺失**时才生效；32 个 0 是非空字符串，会被当成合法 UUID
> 直接送去 API，然后报 `Couldn't find a D1 DB named 'uapis'`。必须手填。

`--location` 只是主位置提示，Free 计划单库上限 500 MB、每账号最多 10 个库，够用。

### 步骤 2 · 建队列

```bash
npx wrangler queues create uapis-refresh
```

**这步不能跳。** `wrangler.jsonc` 同时声明了 producer 和 consumer 绑定，
wrangler 部署前会校验队列存在，否则直接失败并原话提示：

```text
Queue "uapis-refresh" does not exist. To create it, run: wrangler queues create uapis-refresh
```

### 步骤 3 · 迁移表结构

```bash
npm run db:migrate
```

建 5 张表（`cache` / `settings` / `quota` / `stats` / `gate`）。

脚本里写的是 `wrangler d1 migrations apply DB`——**`DB` 是 binding 不是库名**，
wrangler 的 `<database>` 位置参数同时接受两者。这样改 `database_name` 或换
`database_id` 都不用动脚本；而真要改 binding，`env.DB` 的类型和 `typecheck` 会先拦下来。

首次部署时先迁移再部署：此时还没有流量，不存在迁移窗口问题。
后续 schema 变更走**加法式**（加列、加表）先行；破坏性变更放部署之后并立刻验证——
`wrangler d1 migrations apply` 自己就会提示"迁移期间数据库可能短暂不可用"。

生产**不要**跑 seed。`migrations/seed.sql` 只对本地有效（`npm run db:seed:local`），
凭据一律走 `PUT /admin/settings`。

### 步骤 4 · 部署

```bash
npm run deploy
```

**不要裸跑 `wrangler deploy`。** `.assets/` 已被 gitignore，由 `npm run build:docs`
生成并经 `scripts/stage-docs.mjs` 暂存。裸部署会丢掉整个 `/docs/` 站点，
而且不会报错——静态资源请求免费不限量，缺了目录就是 404 而已。

### 步骤 5 · 设 ADMIN_TOKEN

```bash
npx wrangler secret put ADMIN_TOKEN
```

这是本项目**唯一**用 Worker Secret 的凭据，只管 `/admin/*`。上游凭据全在 D1 `settings` 里。

顺序上没讲究，但**必须在第一次调 `/admin/*` 之前**，否则：

| 状态 | 响应 | 含义 |
| --- | --- | --- |
| 没设 secret | `503 SERVICE_UNAVAILABLE` | `ADMIN_TOKEN not configured` |
| secret 设了、token 错或没带 | `401 UNAUTHORIZED` | `missing or invalid admin token` |

两者别混：503 是配置缺失，401 是凭证不对。

### 步骤 6 · 绑自定义域名，然后改 SITE_URL 再部署一次

控制台 **Workers & Pages → 你的 Worker → Settings → Domains & Routes → Add → Custom domain**。

（本项目 `wrangler.jsonc` 没有 `routes` 键，所以走控制台。想代码化可以加
`"routes": [{ "pattern": "api.你的域名", "custom_domain": true }]`——custom domain 表示
"这个 Worker 就是该 hostname 的源站"，不需要自己加 DNS 记录；这和 route 不同，
route 要求域名已有被 Cloudflare 代理的 DNS 记录。两者共用同一份 10 万请求/天额度。）

然后改 `wrangler.jsonc` 的 `vars.SITE_URL` 并**重新 `npm run deploy`**：

```jsonc
"vars": { "SITE_NAME": "uapis", "SITE_URL": "https://api.你的域名" }
```

`SITE_URL` 有三处实际用途，不是装饰：

1. **上游 UA 尾串**——`uapis/1.0 (+<SITE_URL>)`，这是本项目"诚实 UA"承诺的一部分，
   改漏了等于对外自称 `uapis.example.workers.dev`
2. `/openapi.json` 的 `servers`
3. `/llms.txt` 里每条接口的前缀

### 步骤 7 · 按需配上游凭据

只有 **Stack Exchange** 是真的必须配 key（tier B，`stackexchange.api_key`）。
其余 16 个数据源都是零 key；`github.token`（GitHub）、`pubmed.api_key`（PubMed）
是可选的，配了提额不配也能用。

```bash
curl -X PUT https://api.你的域名/admin/settings \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"stackexchange.api_key":"YOUR_KEY"}'
```

设置在 isolate 内记忆化 30 秒，改完**最长 30 秒生效**，别立刻断言"没生效"。
`GET /admin/settings` 回显时凭据类字段会被打成 `***set***`，读得到状态看不到值。

### 步骤 8 · 冒烟清单

按顺序跑，前两条不通过就别往下走。

```bash
BASE=https://api.你的域名

# 1. D1 绑定能执行查询。注意：它跑的是 SELECT 1，不碰任何表，所以 ok 不代表表建好了
curl -s $BASE/healthz

# 2. 真正的迁移检查：/status 读 cache/settings/quota/stats/gate 五张表，
#    其中 readAllQuota 与 readGate 没有 try/catch，表没建时这里直接 500
curl -s -o /dev/null -w '%{http_code}\n' $BASE/status
# 拿到 200 后再看内容：stackexchange 该是 unconfigured，其余 16 个都该 active
curl -s $BASE/status | head -c 2000

# 3. 元数据：openapi 的 servers 必须是你的域名
curl -s $BASE/openapi.json | head -c 300

# 4. 文档站：命中静态资源（响应里没有 X-Request-ID，说明没进 Worker）
curl -si $BASE/docs/guide/providers | head -5

# 5. 缓存语义：第一次 REFRESH，第二次必须 HIT
curl -si "$BASE/api/v1/hackernews/search?q=cloudflare" | grep -i x-cache
curl -si "$BASE/api/v1/hackernews/search?q=cloudflare" | grep -i x-cache

# 6. 新端点：非法日期必须 400 且不回源
curl -si "$BASE/api/v1/github/android/rising?since=2026-13-45" | head -1
curl -s "$BASE/api/v1/github/android/rising?since=2026-08-28&per_page=3" | head -c 400

# 7. 付费墙源未配通道：必须 503 PROVIDER_UNCONFIGURED（不是 500）
curl -si "$BASE/api/v1/economist/article/xxx" | head -1

# 8. admin 鉴权：无 token 必须 401
curl -si $BASE/admin/settings | head -1
```

第 4 条值得单独解释：`.assets` 配的是 `not_found_handling: "none"`，`html_handling`
保持默认 `auto-trailing-slash`，所以 `/docs/guide/providers`（不带 `.html`）会命中
`docs/guide/providers.html` 并**不经过 Worker**——静态资源请求免费且不限量，
这也是 `stage-docs.mjs` 存在的意义。

### `/status` 返回 200 也不等于一切正常

`/status` 的各个读数对缺失的表处理方式不一样，一半是硬失败、一半是静默降级：

| 读的表 | 代码 | 表不存在时 |
| --- | --- | --- |
| `quota`（`/status` 里的 `quota` 字段） | `readAllQuota` | **抛异常 → `/status` 500** |
| `gate` | `readGate` | **抛异常 → `/status` 500** |
| `stats` | `readStats` | catch → 返回空数组 |
| `quota`（`queueBudget` 内部） | `readRow` | catch → 记 0 次 |
| `cache` | `cacheRowCount` + `.catch()` | 记 0 行 |
| `settings` | `getSetting` | catch → **回落 `src/core/settings.ts` 的代码默认值** |

所以迁移漏跑的特征是：`/status` 直接 500，或者虽然 200 但 `cache.rows` 恒为 0、
`providers[].credits` 全是 `used: 0`。别把"能打开"当成"迁移好了"。

## 第二部分 · 日常运维

### 发布与回滚

```bash
npm run deploy                              # 常规发布
npx wrangler versions list                  # 看历史版本 ID
npx wrangler rollback <version-id>          # 回滚到指定版本
npx wrangler rollback                       # 不给 ID = 自动找上一个 100% 流量的版本
```

回滚会**立即创建一个新 deployment** 并把 100% 流量切过去，所有已绑定的域名一起生效。
但它的作用范围比很多人以为的窄：

| 东西 | 随回滚还原？ |
| --- | --- |
| Worker 代码、绑定、compatibility date、静态资源 | ✅ |
| **Secret 现值** | ❌ 回滚后仍用当前值 |
| **D1 数据与表结构** | ❌ |
| routes / 自定义域名 / cron 触发器 | ❌ |
| 本地开发环境 | ❌ 不受影响 |

所以 schema 必须前向兼容：老代码要能在新表上正确工作，新代码也要能在老表上正确工作。

**回滚会被 secret 变更卡住。** 如果目标版本之后改过 secret，接口返回 `10220`，
wrangler 要你逐个确认才继续。规避办法是先更新 secret 再回滚：

```bash
npx wrangler versions secret put ADMIN_TOKEN
npx wrangler versions rollback <version-id>
```

### 数据层恢复（比 Worker 回滚更实在）

D1 免费计划有 **7 天 Time Travel**，能恢复到任意分钟：

```bash
npx wrangler d1 time-travel list DB --remote
npx wrangler d1 time-travel restore DB --timestamp=<unix> --remote
```

限制：每库 10 分钟内最多 10 次恢复；恢复会**覆盖**全部数据，飞行中的查询和事务会被取消。
用于误删缓存行、settings 被写坏这类事故。缓存行丢了顶多冷启动，写坏了配置才是真故障。

### 降级开关

```bash
# 只读模式：停止一切回源
curl -X POST "$BASE/admin/maintenance?mode=readonly" -H "Authorization: Bearer $ADMIN_TOKEN"
# 恢复
curl -X POST "$BASE/admin/maintenance?mode=active" -H "Authorization: Bearer $ADMIN_TOKEN"

# 单个 provider 冷却 N 分钟（比只读模式粒度细）
curl -X POST "$BASE/admin/kill?provider=github&minutes=30" -H "Authorization: Bearer $ADMIN_TOKEN"

# 手动清负缓存 / 重建某个 key
curl -X POST "$BASE/admin/rebuild" -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H 'Content-Type: application/json' -d '{"provider":"github","op":"androidRising","id":"","query":[["since","2026-08-28"]]}'
```

`readonly` 的精确语义（`pipeline.ts`）：

| 缓存状态 | 只读模式下的行为 | `X-Cache` | 消耗上游额度？ |
| --- | --- | --- | --- |
| `HIT` | 照常 200 返回 | `HIT` | 否 |
| `STALE` | 返回旧值，**不触发刷新** | `STALE` | 否 |
| `NEGATIVE` | 原样回放 | `NEGATIVE` | 否 |
| 超出 stale 窗口但有旧值 | 返回旧值 | `STALE-FALLBACK` | 否 |
| `MISS`（完全没有缓存） | `503 SERVICE_UNAVAILABLE`，`details.mode` | — | 否 |

自动回源的三条路都被挡住了：内联回源、stale 后台入队、cron 预热
（预热按 `warm.list` 长度记进 `__warm_skipped`）。

`STALE-FALLBACK` 那行值得留意：它是一条已经超出 stale 窗口的旧值，原本只在
回源失败时当兜底。只读模式下没有回源可言，所以直接把它返回——比 503 更有用，
排障时能看到最后一份已知数据。

两点例外，都是有意留的：

- **`POST /admin/rebuild` 仍然可用。** 只读冻结的是自动流量，人工显式重建不受影响，
  真出故障时那正是你最需要的动作。
- **切换瞬间已在队列里的消息仍会回源一次。** 队列消费者不查维护模式，
  且 `max_batch_size: 1`，窗口极短。

### 额度监控

`/status` 里这几项是真正要盯的：

| 字段 | 含义 | 触顶后果 |
| --- | --- | --- |
| `quota` | 各 provider 今日已用/上限 | 超限返回 `503 QUOTA_EXHAUSTED`，等 UTC 日切 |
| `queue` | 队列今日 operations | 超软限后转排队，客户端见 `503 REBUILDING` |
| `cache.rows` | D1 `cache` 表行数 | 对照 `cache.soft_rows`（默认 8 万） |
| `gate` | 哪些 provider 正在冷却 | 命中返回 `503 RATE_LIMITED` |

配额**按 UTC 日切**（`today()` 取 `toISOString().slice(0,10)`），不是本地时区。

Free 计划的硬边界，以及越线之后到底会怎样：

| 资源 | Free 上限 | 越线行为 |
| --- | --- | --- |
| Workers 请求 | 10 万/天 | Cloudflare **Error 1027** 错误页，整个 Worker 不可用 |
| CPU | 10 ms/次 | 请求失败 |
| D1 行读 / 行写 | 500 万 / 10 万，**每天** | **D1 查询直接报错**，全站 500，直到 00:00 UTC 重置 |
| D1 库大小 | 单库 500 MB | 无法再写入/建表 |
| Queues operations | 1 万/天 | 入队失败，刷新链路断 |
| Queues 消息保留 | **24 小时，不可配置** | 失败消息 1 天后静默消失 |
| Workers Logs | 20 万 events/天，保留 3 天 | — |

D1 那条要特别注意：免费额度是**硬失败**而不是计费超支。`migrations/0001_init.sql`
头部那份预算表（缓存填充 ≤ 2 万/天、过期清理 ≤ 1.2 万/天，合计约 6.4 万行写入 = 64%）
不是"参考值"，是别越的红线——越了全站 D1 查询报错。所以 `cache.soft_rows` 别往上抬，
Cron 的清理批量也别加大。

### 定时任务

`wrangler.jsonc` 配了两个 cron（Free 计划每账号上限 5 个）：

| 表达式 | 做什么 |
| --- | --- |
| `7 */2 * * *` | prune：删 `expires_at < now` 的行，每批 300 行，顺带刷新 `cache.rows` |
| `*/30 * * * *` | warm：给 `warm.list` 里的 key 预热，每轮最多 50 条，受 `queue.soft_limit` 约束 |

`warm.list` 格式是 `{cacheKey}|{provider}|{target}`，逗号分隔，key 从
`cacheKeyFor()` 算、`target` 走 `encodeTarget()`，可以从 `POST /admin/rebuild`
的响应里直接抄。预热是**锦上添花**，不配就没人管，`__warm_skipped` 会一直涨。

### 部署失败速查

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| `Queue "uapis-refresh" does not exist` | 跳了步骤 2 | `npx wrangler queues create uapis-refresh` |
| `Couldn't find a D1 DB named 'uapis'` | `database_id` 还是 32 个 0 | 填真实 UUID（见步骤 1） |
| `/healthz` 一直 ok，但 `/status` 500 或 `cache.rows` 恒为 0 | 迁移没跑，或打到了别的库 | `npm run db:migrate`（`/healthz` 的 `SELECT 1` 不碰表，查不出这个问题） |
| `/docs/` 404，但 API 正常 | 裸跑了 `wrangler deploy` | `npm run deploy` |
| 上游 UA 显示 `uapis.example.workers.dev` | 改完域名忘了改 `SITE_URL` | 改 `vars.SITE_URL` 再部署 |
| `/admin/*` 一直 503 | 没设 `ADMIN_TOKEN` secret | `npx wrangler secret put ADMIN_TOKEN` |
| 改了 `wrangler.jsonc` 后 typecheck 报 `Env` 缺绑定 | 绑定变了 | `npm run cf:typegen` 然后 `npm run typecheck` |
| 全站 500 且 `/status` 也打不开 | D1 读写行数触顶 | 等 00:00 UTC，或降 `cache.soft_rows` |
| Cloudflare 1027 错误页 | Workers 请求超 10 万/天 | 等 UTC 日切，或降 `ratelimit.rpm` |

## 细节去哪查

| 问题 | 去哪 |
| --- | --- |
| 错误码、`X-Cache` 各值、排障顺序 | [错误与排障](/guide/errors) |
| 三层限速怎么配合、免费额度怎么分档 | [限流与免费额度](/guide/rate-limits) |
| 每个 provider 的凭据、上游条款、字段裁剪 | [数据源与凭据](/guide/providers) |
| 为什么是这些上游、哪些被排除 | [provider 审计](/reference/provider-audit) |
| 白名单、诚实 UA、代理的红线 | [合规红线](/guide/compliance) |
| 预算分配的推导过程 | [设计决策](/reference/design-decisions) |
