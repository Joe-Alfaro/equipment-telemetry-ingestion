import { connectBroker } from '@telemetry/broker'
import { createPool } from '@telemetry/db'
import { TEST_AMQP_URL, TEST_DATABASE_URL } from './env'

/** Fails fast with a useful message when the integration infrastructure is down. */
export async function setup() {
  const pool = createPool(TEST_DATABASE_URL, 1)
  try {
    await pool.query('SELECT 1')
  } catch (error) {
    throw new Error(
      `Postgres not reachable at ${TEST_DATABASE_URL}. Run \`npm run test:infra:up\`.`,
      { cause: error },
    )
  } finally {
    await pool.end()
  }

  try {
    const connection = await connectBroker(TEST_AMQP_URL, { attempts: 1 })
    await connection.close()
  } catch (error) {
    throw new Error(`RabbitMQ not reachable at ${TEST_AMQP_URL}. Run \`npm run test:infra:up\`.`, {
      cause: error,
    })
  }
}
