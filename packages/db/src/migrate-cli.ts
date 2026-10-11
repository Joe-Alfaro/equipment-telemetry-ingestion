import { migrate } from './migrate'
import { createPool } from './pool'

const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) {
  console.error('DATABASE_URL is required')
  process.exit(1)
}

const pool = createPool(databaseUrl, 1)
try {
  const applied = await migrate(pool)
  console.log(applied.length > 0 ? `applied: ${applied.join(', ')}` : 'no pending migrations')
} catch (error) {
  console.error('migration failed', error)
  process.exitCode = 1
} finally {
  await pool.end()
}
