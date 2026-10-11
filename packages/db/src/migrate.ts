import { readdir, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import type pg from 'pg'

export const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url))

// Arbitrary constant so concurrent migrators against one database serialize.
const MIGRATION_LOCK_ID = 7_041_001

export function sortMigrationFiles(files: string[]): string[] {
  return files.filter((file) => file.endsWith('.sql')).sort((a, b) => a.localeCompare(b))
}

export async function listMigrations(dir = MIGRATIONS_DIR): Promise<string[]> {
  return sortMigrationFiles(await readdir(dir))
}

/**
 * Applies pending SQL migrations in filename order, each in its own transaction.
 * Returns the names of the migrations applied by this call.
 */
export async function migrate(pool: pg.Pool, dir = MIGRATIONS_DIR): Promise<string[]> {
  const client = await pool.connect()
  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_ID])
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name       text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `)
    const { rows } = await client.query<{ name: string }>('SELECT name FROM schema_migrations')
    const applied = new Set(rows.map((row) => row.name))
    const pending = (await listMigrations(dir)).filter((name) => !applied.has(name))

    // Sequential on purpose: each migration may depend on the previous one.
    await pending.reduce(async (previous, name) => {
      await previous
      const sql = await readFile(`${dir}/${name}`, 'utf8')
      await client.query('BEGIN')
      try {
        await client.query(sql)
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [name])
        await client.query('COMMIT')
      } catch (error) {
        await client.query('ROLLBACK')
        throw error
      }
    }, Promise.resolve())

    return pending
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_ID]).catch(() => {})
    client.release()
  }
}
