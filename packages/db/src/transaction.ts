import type { Pool, PoolClient } from './pool'

/** Runs `work` in one transaction on a dedicated client; resolves only after COMMIT. */
export async function withTransaction<T>(
  pool: Pool,
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const result = await work(client)
    await client.query('COMMIT')
    client.release()
    return result
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    // Discard the connection: after an error its state is not trustworthy.
    client.release(error instanceof Error ? error : true)
    throw error
  }
}
