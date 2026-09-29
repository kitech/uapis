/**
 * migrations/0001_init.sql 的内联副本，供运行期自举使用。
 *
 * 为什么不 `import sql from '../../migrations/0001_init.sql'`：
 * 那依赖 wrangler 默认 module rules 把 .sql 当 Text 加载（4.x 才有），
 * 属于隐式打包器契约——降级 wrangler、换 esbuild 预设或改 rules 都会
 * 在构建期炸成 "No loader is configured for .sql"，而且报错点离改动点很远。
 *
 * 改成显式常量后：单文件即可读、无打包器依赖，
 * test/schema-contract.test.ts 会断言本文件与 .sql 规范化后逐条相等，
 * 漂移由测试拦住而不是靠人记得同步两处。
 */
export const INIT_DDL = `CREATE TABLE IF NOT EXISTS cache (
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
) WITHOUT ROWID;`

/**
 * 按分号切分并剥掉整行 `--` 注释。
 *
 * 局限：不处理字符串字面量里的分号与被引号包裹的 `--`。当前 DDL 两者都没有，
 * test/schema-contract.test.ts 会守住这个前提——DDL 一旦引入（比如 CHECK
 * 约束里写分号），那个测试先红，而不是等到线上建表失败。
 */
export function splitStatements(sql: string): string[] {
  return sql
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n')
    .split(';')
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0)
}
