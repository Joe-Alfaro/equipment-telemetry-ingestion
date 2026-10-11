import { randomUUID } from 'node:crypto'
import { createPool, migrate, type Pool } from '@telemetry/db'
import { TEST_DATABASE_URL } from './env'

export interface TestDatabase {
  pool: Pool
  url: string
  name: string
  /** Closes the pool and drops the database. */
  drop(): Promise<void>
}

function withDatabase(url: string, name: string): string {
  const parsed = new URL(url)
  parsed.pathname = `/${name}`
  return parsed.toString()
}

/**
 * Creates an isolated, fully migrated database so test files can run in parallel
 * without sharing state. Call `drop()` in `afterAll`.
 */
export async function createTestDatabase({ poolSize = 10 } = {}): Promise<TestDatabase> {
  const name = `it_${randomUUID().replaceAll('-', '')}`
  const admin = createPool(TEST_DATABASE_URL, 1)
  try {
    await admin.query(`CREATE DATABASE ${name}`)
  } finally {
    await admin.end()
  }

  const url = withDatabase(TEST_DATABASE_URL, name)
  const pool = createPool(url, poolSize)
  await migrate(pool)

  async function drop() {
    await pool.end()
    const cleanup = createPool(TEST_DATABASE_URL, 1)
    try {
      await cleanup.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`)
    } finally {
      await cleanup.end()
    }
  }

  return { pool, url, name, drop }
}
