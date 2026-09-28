---
layout: home
hero:
  name: uapis
  text: 国外站点聚合 API
  tagline: 单个 Cloudflare Worker，全部跑在免费额度内
  actions:
    - theme: brand
      text: 快速上手
      link: /guide/quickstart
    - theme: alt
      text: OpenAPI
      link: /openapi.json
  features:
    - title: 单 Worker
      details: API、VitePress 文档、Queues 刷新、Cron 清理都跑在一个 Worker 里，静态资源不消耗 Worker 请求额度。
    - title: 诚实缓存
      details: T1 Cache API → T2 D1 → Queue 回源，stale-while-revalidate、负缓存、命中状态写在 X-Cache 头里。
    - title: 零依赖额度
      details: 只用 D1、Queues、Cache API 和一个 secret，不用 KV/R2/DO/Browser Run/Service Bindings。
    - title: 不做开放代理
      details: 固定 host 白名单 + 不可覆盖的 UA，只代理 registry 里声明过的上游。
---

## 这是什么

`uapis` 把 Hacker News、Stack Exchange 等国外站点的公开接口聚合成一套 `/api/v1/...` 路径，
用同一套响应约定（成功是裸业务对象，错误是 `{code, message, details?}`），
并且按 Cloudflare 免费额度设计缓存、限流与刷新节奏。

> 本项目与 uapis.cn 无任何关联，是从零实现的同类项目。

## 已接入的接口

| provider | 端点 | 凭据 |
| --- | --- | --- |
| hackernews | `search`、`item/{id}`、`user/{id}`、`front`、`latest`、`user/{id}/posts` | 无 |
| stackexchange | `question/{id}`、`search`、`user/{id}`、`tags`、`question/{id}/answers`、`question/{id}/comments`、`sites` | `stackexchange.api_key`（`sites` 除外） |
| github | `repo/{owner}/{repo}`、`search/repositories`、`android/rising`、`user/{login}` | 无（`github.token` 可选） |
| devto | `articles`、`article/{id}`、`user/{username}` | 无 |
| arxiv | `search`、`paper/{id}` | 无 |
| economist | `article/{slug}` | `zenrows.key` 或 `jina.key`（付费通道，任一即可） |
| lobsters | `hot`、`newest`、`story/{id}`、`tag/{tag}` | 无 |
| itunes | `search`、`lookup` | 无 |
| crossref | `search`、`work/{doi}` | 无 |
| pypi | `project/{package}`、`release/{package}/{version}` | 无 |
| npm | `search`、`latest/{name}`、`version/{name}/{version}` | 无 |
| pubmed | `search`、`summary` | 无（`pubmed.api_key` 可选） |
| usgs | `earthquakes`、`earthquakes/{id}` | 无 |
| gitlab | `projects`、`project/{id}`、`commits` | 无 |
| crates | `search`、`crate/{name}`、`crate/{name}/{version}` | 无 |
| musicbrainz | `search`、`artist/{mbid}`、`release/{mbid}`、`release-group/{mbid}` | 无 |
| openmeteo | `current`、`hourly`、`geocode`、`air-quality` | 无 |

17 个数据源 / 54 个端点里，**只有 Stack Exchange 的 6 个端点必须配 key**（`/sites` 除外），
其余全是零 key 源。完整参数见 [数据源与凭据](/guide/providers) 或 `/openapi.json`。

## 快速预览

```bash
curl -i https://<你的域名>/api/v1/hackernews/search?q=cloudflare
```

第一次是 `X-Cache: REFRESH`，紧接着再来一次应该是 `X-Cache: HIT`。
两次都不消耗上游额度。

## 元数据端点

| 端点 | 说明 |
| --- | --- |
| `/openapi.json` | OpenAPI 3.1 文档，由 registry 生成 |
| `/llms.txt` | 纯文本接口清单，便于 LLM 抓取 |
| `/status` | 缓存行数、队列额度、闸门、统计、provider 配置状态 |
| `/healthz` | 存活探测，会实测一次 D1 |
| `/docs/` | 本文档（Static Assets 直出） |

## 接下来

- [快速上手](/guide/quickstart)：部署自己的实例并发出第一个请求
- [数据源与凭据](/guide/providers)：现有 provider 与需要配置的 key
- [限流与免费额度](/guide/rate-limits)：三层限速与预算分配
- [同类项目对照](/reference/related-projects)：与 `vikiboss/60s` 等项目的差异
