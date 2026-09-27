-- 可选示例设置。本地：npm run db:seed:local
-- 生产建议用 PUT /admin/settings 写入；未写入时全部回落到 src/core/settings.ts 中的代码默认值。
-- 凭据类（se.key / gh.token / reddit.client_id / reddit.client_secret / youtube.key /
-- ph.key / lastfm.key / telegram.token / zenrows.key / jina.key）不要写进本文件。

INSERT OR REPLACE INTO settings (k, v, updated_at) VALUES
  ('maintenance.mode',   'active', 0),
  ('cache.t1',           'on',     0),
  ('cache.soft_rows',    '80000',  0),
  ('ratelimit.rpm',      '60',     0),
  ('cors.origins',       '*',      0),
  ('upstream.allowlist', 'api.stackexchange.com,hn.algolia.com,api.github.com,dev.to,export.arxiv.org,api.zenrows.com,r.jina.ai', 0),
  ('queue.daily_limit',  '3000',   0),
  ('queue.soft_limit',   '2700',   0),
  ('warm.list',          '',       0),
  ('proxy.mode',         'off',    0),
  ('proxy.zenrows_url',  'https://api.zenrows.com/v1/key?apikey={key}&url={url}&mode={mode}&javascript=allowed&wait=20000', 0),
  ('proxy.jina_url',     'https://r.jina.ai/?url={url}', 0),
  ('quota.stackexchange.default',  '9500', 0),
  ('quota.hackernews.default',     '10000', 0),
  ('quota.github.default',         '4500', 0),
  ('quota.devto.default',          '9000', 0),
  ('quota.arxiv.default',          '4000', 0),
  ('quota.proxy.zenrows',          '33', 0),
  ('quota.proxy.jina',             '50', 0);
