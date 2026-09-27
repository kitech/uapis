/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { env } from 'cloudflare:workers'
import { applyD1Migrations, type D1Migration } from 'cloudflare:test'
import { beforeAll } from 'vitest'

type TestEnv = Env & { TEST_MIGRATIONS: D1Migration[] }

beforeAll(async () => {
  await applyD1Migrations(env.DB, (env as unknown as TestEnv).TEST_MIGRATIONS)
})
