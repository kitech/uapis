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
npm test              # 240 个离线用例，不发真实请求
npm run deploy:dry    # 构建文档 + dry-run，产物约 245 KiB（gzip 约 57 KiB，58 个文件）
```

Worker 体积上限 64 MiB，本项目 gzip 后 57 KiB，余量充足。
`npm test` 全程用 MSW 拦截出站，**不会**碰真实上游，可以放心跑。

## 第一部分 · 首次部署自己的实例

### 步骤 1 · D1 由首次部署自动开通

`wrangler.jsonc` 里**故意不写 `database_id`**：

```jsonc
"d1_databases": [
  {
    "binding": "DB",
    "database_name": "uapis",
    "migrations_table": "d1_migrations",
    "migrations_dir": "migrations",
    "migrations_pattern": "migrations/[0-9]*.sql"
  }
]
```

wrangler ≥4.45.0 的**自动资源开通**（automatic resource provisioning）看到「有 `database_name`
但没有 ID」就会在首次 `wrangler deploy` 时调 API 把库建出来，所以这步不需要手工操作。

> **别拿占位符代替缺失。** 自动开通只在 `database_id` 这个键**整个不存在**时触发。
> 曾经这里写的是 32 个 0，而 wrangler 判定「有没有 UUID」的实现是
> `!!db?.uuid`（据 wrangler 4.x 打包产物反推的 `hasUuid`，非官方承诺）——非空字符串就算有。
> 于是 32 个 0 会**短路掉**自动开通分支，被当成一个合法但存在的 ID 直接送去 API，然后报
> `D1 binding 'DB' references database '000…' which was not found. [code: 10181]`。
> 要么留空，要么删掉整个键，别填垃圾值。
>
> 4.102.0 的按名回退**救不了这个 case**：它只在 wrangler 认为「没有 ID」时才去查 API，
> 而 `000…0` 恰好被判定为「有 ID」，两条路径都绕开，只能手工纠正。

**Workers Builds 不会把生成的 ID 写回仓库。** Cloudflare 官方文档原话：这种「从面板/GitHub
发起的部署」资源会被创建，但「ID 只能从 dashboard 看到，不会写回你的仓库」。

> **本地首次部署会把 ID 写回文件。** 从命令行跑 `wrangler deploy` 时官方文档明写
> 「their IDs will be written back to your configuration file」，真实的 `database_id` 会被
> 注入磁盘上的 `wrangler.jsonc`。所以第一次 `npm run deploy` 之后 `git status` 会多出这个文件。
>
> **本项目的处置：`git checkout -- wrangler.jsonc` 把它退掉。** 保持「故意不写 ID」的设计：
> 4.102.0 起所有远程 `d1` 子命令（`migrations apply` / `migrations list` / `execute` /
> `export` / `time-travel`）都走 API 按 `database_name` 回退查找，迁移不依赖这个 ID，
> 资源在后续部署之间也保持绑定。附带好处是 fork 出去的副本不会带着原账号的 UUID。
> 代价只是每次 `db:migrate` 多一次 API 查询。

想改成手工管库也可以（也就是老做法）：

```bash
npx wrangler d1 create uapis --location apac
```

然后把回显的 `database_uuid` 填进 `wrangler.jsonc` 的 `database_id` 并提交。`--location` 只是
主位置提示，Free 计划单库上限 500 MB、每账号最多 10 个库，够用。

两种方式二选一，**不要混**：填了 `database_id` 就走「按 ID 寻址」，不填就走「按名字查」。

### 步骤 2 · 建队列

```bash
npx wrangler queues create uapis-refresh
```

**这步不能跳，队列不会自动开通。** `wrangler.jsonc` 同时声明了 producer 和 consumer 绑定，
wrangler 部署前会校验队列存在，否则直接失败并原话提示：

```text
Queue "uapis-refresh" does not exist. To create it, run: wrangler queues create uapis-refresh
```

D1 能自动开通、队列不能，原因是配置里**写了队列的具名**（`"queue": "uapis-refresh"`）。
自动开通的命名规则是 `<worker 名>-<binding 名>`，没具名的话会生成一个叫 `uapis-REFRESH`
的队列——和这里要用的 `uapis-refresh` 是两个东西，绑定照样对不上。

### 步骤 3 · 表结构由 Worker 代码自举

`wrangler deploy` 只保证**库存在**，不保证**表存在**。所以本项目不靠手工迁移起步：
Worker 里有一段 `ensureSchema()`（`src/core/bootstrap.ts`），在检测到表缺失时把 schema 装上。

它挂在三个触发点上，任一即可完成安装：

| 触发点 | 位置 | 为什么需要它 |
| --- | --- | --- |
| 每个请求 | `index.ts` 中间件，`waitUntil` | 正常流量下第一次请求就装好 |
| 每次 cron | `index.ts` `scheduled` | 部署后长时间没流量时兜底 |
| `/healthz` | `meta.ts`，`waitUntil` | 监控一定会轮询它，真实流量可能为零 |

**不需要任何手工步骤。** `wrangler deploy` 之后，第一次请求（含 `/healthz`）就会建表，
业务端点立刻可用。

冷路径上一次查询拿全库结构（`sqlite_master` + `pragma_table_info`）并与
`src/core/schema-contract.ts` 的契约逐表逐列逐索引比对，结论有三种：

| 契约状态 | 自举行为 |
| --- | --- |
| 完整 | 记进 isolate 记忆，本 isolate 内后续请求零查询 |
| 缺表 / 缺索引 | 重跑幂等 DDL 补上（这正是修复动作），补完复测 |
| 只缺列 | **不硬补**。`CREATE TABLE IF NOT EXISTS` 对已存在的表是空操作，唯一的补法 `ALTER TABLE ADD COLUMN` 又是非幂等的。结论是「需要真的迁移」，报出来并指路 `npm run db:migrate` |

补上之后会**重新比对**再决定是否记进记忆，而不是假定「跑过 DDL 就一定好了」——
缺表和缺列可能同时存在。

> **为什么幂等迁移不查 `d1_migrations` 就重跑。** 直觉上该跳过「已应用」的迁移，
> 但那样就修不了漂移：记账说「跑过了」，而表被手工删掉或半截安装时，DDL 再也不会
> 执行，缺口永远补不上。能走到这个分支说明契约已经不完整，而幂等 DDL 重跑本身
> 就是安全且正是「修复」所需的动作。记账用 `INSERT OR IGNORE`，不会产生重复行。

> **记账表与 wrangler 共用 `d1_migrations`。** `ensureSchema` 建表时用的 DDL 与
> wrangler `getCreateMigrationsTableQuery` 逐字一致，且 `name` 存相对
> `migrations_dir` 的路径（`0001_init.sql`，不是 `migrations/0001_init.sql`）。
> 两边因此能互相认账：自举记过的迁移，之后跑 `npm run db:migrate` 不会重复执行。
> `wrangler.jsonc` 里也显式写了 `"migrations_table": "d1_migrations"`。
>
> 记账表**先单独建好再查**：空库上此刻它还不存在，直接 `SELECT` 会抛
> `no such table: d1_migrations`，整个自举挂在第一次查询上，永远装不上。
>
> **`npm run db:migrate` 仍然保留**，它是**非幂等迁移的唯一通道**（见下）。

**只自动应用幂等迁移。** 每个迁移在 `MIGRATIONS` 里显式标 `idempotent`：

- `0001_init.sql` 全部是 `CREATE TABLE/INDEX IF NOT EXISTS` → `idempotent: true`，可自动应用；
- 未来的 `ALTER TABLE ADD COLUMN` 之类 → 必须标 `false`，自举会拒绝执行并记
  `schema_bootstrap_refused` 日志，这类迁移只能走 `npm run db:migrate`。

> **这个标记只存在于代码里，SQL 里没有。** 加新迁移文件时必须同步登记进
> `MIGRATIONS` 并显式填 `idempotent`；漏登记会被 `EXPECTED_MIGRATIONS` 的
> 一致性测试（`test/schema-contract.test.ts`）拦下。
>
> **自举的 DDL 是 `src/core/schema-ddl.ts` 里的内联常量，不是 `.sql` 导入。**
> `import sql from './x.sql'` 依赖 wrangler 默认 module rules 把 `.sql` 当 Text
> 加载（4.x 才有），属隐式打包器契约，换打包器会在构建期炸成
> "No loader is configured"。同一个测试文件会断言内联常量与
> `migrations/0001_init.sql` 归一化后逐条相等，漂移由测试拦住。

库名 vs binding：官方文档建议迁移用**库名**而非 binding（binding 名可能会改，库名不会）。
本项目 `db:migrate` 脚本目前写的是 binding `DB`——wrangler 的 `<database>` 位置参数
同时接受两者，两者都不会变动时等价。将来要分 staging 环境或改 binding 名时，
换成 `wrangler d1 migrations apply uapis`。

> **`missing a database_id` 在 wrangler ≥ 4.102.0 已经修好**（PR #14275，commit `594544d`：
> 远程子命令的按名寻址改走 `GET /accounts/:accountId/d1/database/:name?fields=uuid`
> 解析，覆盖 `migrations apply` / `migrations list` / `execute` / `export` / `time-travel`）。
> 本项目锁 4.141.0，已包含该修复。**注意它是远程 API 查询**，所以库必须先由
> `wrangler deploy` 建出来。
> 万一还是失败，按步骤 1 的手工路径 `npx wrangler d1 create uapis` 拿 UUID、
> 填进 `wrangler.jsonc`、提交即可。

**seed 不会跟着迁移跑。** `migrations/seed.sql` 和真正的迁移同住一个目录，而
`migrations apply` 的默认发现规则是 `migrations/*.sql`——那会把 seed 一起当成一次迁移
应用到生产。而 seed 是 `INSERT OR REPLACE`，重跑一次就会把 `maintenance.mode` 覆盖回
`active`、把 `cors.origins` 覆盖回 `*`，正是 readonly 想避免的事。

所以 `wrangler.jsonc` 里配了 `migrations_pattern: "migrations/[0-9]*.sql"`：
只认 `0001_init.sql` 这种编号文件，`seed.sql` 不匹配。生产因此只建表、不写设置，
全部回落到 `src/core/settings.ts` 的代码默认值——这本来就是设计意图。
需要本地数据时手工跑 `npm run db:seed:local`，凭据一律走 `PUT /admin/settings`。

> 注意 seed 也**不在**自举范围内：自举只应用 `MIGRATIONS` 登记的编号迁移，
> 读不到 `seed.sql`。

迁移的通用纪律与库怎么建无关：后续 schema 变更走**加法式**（加列、加表）先行；
破坏性变更放部署之后并立刻验证。

### 步骤 3b · 选填：写死 account_id

`wrangler.jsonc` 默认不带 `account_id`，本地命令会问你用哪个账号。Workers Builds 由
Cloudflare 注入，不用管。只有名下有多个账号、且想免掉每次选择时才加：

```jsonc
"account_id": "ac7da44d2ead53aabeb00ef8b6c56a04"
```

### 步骤 3c · 选填：preview_database_id

没配 `preview_database_id` 时，`wrangler dev --remote` 会直接用生产库。
本项目不需要它（`npm run dev` 走本地模式），但如果哪天要加 `--remote`，
先补上这个字段，否则一次本地调试就能改到生产数据。

### 步骤 4 · 部署

```bash
npm run deploy
```

**首次部署时，这一步同时把 D1 库开出来**（见步骤 1）。表结构由 Worker 代码在
第一个请求时自举装好（见步骤 3），所以自动开通路线下不需要任何手工的迁移步骤。

> 这一步之后 `wrangler.jsonc` 会被 wrangler 写入真实 `database_id`（见步骤 1），
> 按项目约定 `git checkout -- wrangler.jsonc` 退掉，保持不写 ID。

**不要裸跑 `wrangler deploy`。** `wrangler.jsonc` 里 `assets.directory` 指向 `.assets`，
而该目录已被 gitignore（`.gitignore` 第 3 行）——它是构建产物，由 `npm run build:docs`
里的 `vitepress build docs && node scripts/stage-docs.mjs` 生成。

所以干净 checkout 里没有 `.assets/`，而 wrangler 4 对缺失的 assets 目录是**硬报错**，
整个部署会直接终止：

```
✘ [ERROR] The directory specified by the "assets.directory" field in your
configuration file does not exist: /path/to/repo/.assets
```

### 步骤 4b · Cloudflare Workers Builds 面板

用 Workers Builds 自动部署时，仓库会被 clone 到构建容器的 `/opt/buildhome/repo`。
面板设置必须是：

| 字段 | 值 |
| --- | --- |
| Build command | `npm run build:docs` |
| Deploy command | `npx wrangler deploy` |

Build command 留空是最常见的踩法：面板只跑 `wrangler deploy`，`.assets` 没人生成，
于是每一条构建都在上面那个报错上挂掉。仓库里**没有** `build` 这个 script
（只有 `build:docs`），所以别填 `npm run build`。

Deploy command 那一段就是步骤 4（对应 `npm run deploy` 的第二段）。
表结构不靠它——Worker 自己会装（步骤 3），省掉它也能建表。
构建容器是非交互环境，`d1 migrations apply` 的确认提示会自动跳过。

Build command 填了 `build:docs` 的情况下**不要**再把 Deploy command 填成
`npm run deploy`——那会让文档构建两遍。

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

### 步骤 6 · 绑自定义域名，然后重新部署

控制台 **Workers & Pages → 你的 Worker → Settings → Domains & Routes → Add → Custom domain**。

（本项目 `wrangler.jsonc` 没有 `routes` 键，所以走控制台。想代码化可以加
`"routes": [{ "pattern": "api.你的域名", "custom_domain": true }]`——custom domain 表示
"这个 Worker 就是该 hostname 的源站"，不需要自己加 DNS 记录；这和 route 不同，
route 要求域名已有被 Cloudflare 代理的 DNS 记录。两者共用同一份 10 万请求/天额度。）

绑完**重新 `npm run deploy`** 即可，无需任何配置改动：`/openapi.json` 的 `servers` 和
`/llms.txt` 的接口前缀都从当前请求的 Host 自动取；UA 是全局固定的 `uapis/0.1.0 (+apple.com)`。

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

# 1. D1 绑定能执行查询，且 schema 完整（缺表时首次调用会触发自举，
#    所以这一次可能仍是 degraded，再调一次就应该是 ok）
curl -s $BASE/healthz

# 2. /status 读 cache/settings/quota/stats/gate 五张表。
#    缺表不会 500，但顶层 degraded 会列出失败区块，degraded 为 [] 才算全绿
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

`/status` 的各个读数对缺失的表处理方式不一样，**但现在整页都不会 500 了**——
每个区块各自兜底，失败项记进顶层 `degraded` 数组：

| 读的表 | 代码 | 表不存在时 |
| --- | --- | --- |
| `quota`（`/status` 里的 `quota` 字段） | `readAllQuota` | `degraded` 含 `quota`，字段回落 `[]` |
| `gate` | `readGate` | `degraded` 含 `gate`，字段回落 `[]` |
| `quota`（`queueBudget` 内部） | `readRow` | `degraded` 含 `queue` |
| `cache` | `cacheRowCount` | `degraded` 含 `cache`，记 0 行 |
| `settings` | `getSetting` | 静默回落代码默认值（计数器 `setting_fallback`）|
| `stats` | `readStats` | 静默返回空数组（计数器 `stats_read_failed`）|

迁移没跑的特征：`/healthz` 的 `schema: false`（503），`/status` 顶部 `degraded`
非空。自举会自动补上，所以在补上之前会看到这两者；补上后再调就是全绿。
`/healthz` 的 `checks.schema.diff` 会直接给出缺哪张表、哪一列、哪个索引。

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
| `D1 binding 'DB' references database '000…' which was not found. [code: 10181]` | `database_id` 填了占位符 | 删掉 `database_id` 整个键（自动开通），或填真实 UUID |
| 跑 `db:migrate` 报库找不到 | 远端还没建出这个库：没跑过 `wrangler deploy` | 先 `wrangler deploy`（自动开通），再 `npm run db:migrate` |
| `missing a database_id`（仅 wrangler < 4.102.0 会遇到） | 按名寻址缺陷，PR #14275 已修 | 升级 wrangler 到 ≥ 4.102.0 |
| `503 STORAGE_UNAVAILABLE`，message 含 `no such table: xxx` | 自举还没跑完，或打到了别的库 | 再调一次触发自举；持续出现看 `checks.schema.diff` |
| `/healthz` 持续 `schema: false` | 自举失败，DDL 被拒或 D1 不可用 | 看 Workers Logs 的 `schema_bootstrap_failed` / `schema_bootstrap_refused` |
| `/healthz` 出现 `migrations_pending` 非空 | 有迁移被标为非幂等、自举拒绝自动应用 | 走 `npm run db:migrate`（非幂等迁移的唯一通道） |
| `/healthz` 的 `warnings` 含 `queue-consumer` | 队列消费者没在 10 分钟内确认探针 | 检查 queue consumer 绑定与 `max_retries` |
| The directory specified by the "assets.directory" field ... does not exist: .../.assets | 裸跑了 `wrangler deploy`，或 Workers Builds 的 Build command 留空 | 本地 `npm run deploy`；面板 Build command 填 `npm run build:docs` |
| UA 是全局固定的 `uapis/0.1.0 (+apple.com)`，不随访问域名变化 | 不是故障 | 无需处理 |
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
