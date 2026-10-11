import { migrate } from '@telemetry/db'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createTestDatabase, type TestDatabase } from './database'

describe('createTestDatabase + migrations', () => {
  const ctx: { db?: TestDatabase } = {}

  beforeAll(async () => {
    ctx.db = await createTestDatabase()
  })

  afterAll(async () => {
    await ctx.db?.drop()
  })

  it('creates the full schema', async () => {
    const { rows } = await (ctx.db as TestDatabase).pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' ORDER BY table_name`,
    )

    expect(rows.map((row) => row.table_name)).toEqual([
      'current_state',
      'devices',
      'gateways',
      'reading_conflicts',
      'readings',
      'schema_migrations',
    ])
  })

  it('is idempotent', async () => {
    expect(await migrate((ctx.db as TestDatabase).pool)).toEqual([])
  })
})
