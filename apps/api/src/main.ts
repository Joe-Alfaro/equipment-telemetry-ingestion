import { connectBroker, createReadingPublisher } from '@telemetry/broker'
import { createPool } from '@telemetry/db'
import { buildApp } from './app'
import { loadConfig } from './config'

const config = loadConfig()
const pool = createPool(config.databaseUrl)
const connection = await connectBroker(config.amqpUrl, { log: console.warn })
const publisher = await createReadingPublisher(connection, config.readingsQueue)

const app = buildApp({ publisher, pool, lateThresholdMs: config.lateThresholdMs, logger: true })

// Losing the broker means we can no longer confirm readings; exit and let the
// orchestrator (docker compose `restart`) bring us back with a fresh connection.
connection.on('close', () => {
  app.log.error('broker connection closed, exiting')
  process.exit(1)
})

async function shutdown(signal: string) {
  app.log.info(`${signal} received, shutting down`)
  await app.close()
  await publisher.close().catch(() => {})
  await connection.close().catch(() => {})
  await pool.end()
  process.exit(0)
}

process.on('SIGTERM', () => void shutdown('SIGTERM'))
process.on('SIGINT', () => void shutdown('SIGINT'))

await app.listen({ host: config.host, port: config.port })
