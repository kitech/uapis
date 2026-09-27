-- uapis D1 schema v1
--
-- 写入预算说明（Cloudflare D1 免费额度每天 10 万“行写入”，索引写入按额外行计）：
--   * `cache` 是写入热点表，只保留 1 个索引（expires_at），因此每次写缓存 = 2 行写入。
--   * settings/quota/stats/gate 全部使用 WITHOUT ROWID，主键即表本身，写入只算 1 行。
--   * 预算：缓存填充 ≤ 2 万/天 = 4 万行；过期清理 ≤ 1.2 万/天 = 2.4 万行；其余 ≈ 2 千行，合计 ≈ 6.4 万行（64%）。

CREATE TABLE IF NOT EXISTS cache (
  k           TEXT    PRIMARY KEY,
  body        BLOB    NOT NULL,
  encoding    TEXT    NOT NULL DEFAULT 'gzip',
  status      INTEGER NOT NULL DEFAULT 200,
  content_type TEXT,
  provider    TEXT    NOT NULL,
  resource    TEXT    NOT NULL DEFAULT '',
  fetched_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  stale_until INTEGER NOT NULL,
  size        INTEGER NOT NULL DEFAULT 0
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_cache_expires ON cache(expires_at);

CREATE TABLE IF NOT EXISTS settings (
  k          TEXT    PRIMARY KEY,
  v          TEXT    NOT NULL,
  updated_at INTEGER NOT NULL DEFAULT 0
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS quota (
  day      TEXT    NOT NULL,
  provider TEXT    NOT NULL,
  channel  TEXT    NOT NULL DEFAULT 'default',
  used     INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, provider, channel)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS stats (
  day  TEXT    NOT NULL,
  path TEXT    NOT NULL,
  n    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, path)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS gate (
  provider TEXT    PRIMARY KEY,
  next_at  INTEGER NOT NULL DEFAULT 0,
  fails    INTEGER NOT NULL DEFAULT 0
) WITHOUT ROWID;
