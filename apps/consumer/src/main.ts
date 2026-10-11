import { connectBroker } from '@telemetry/broker'
import { createPool } from '@telemetry/db'
import { loadConfig } from './config'
import { startConsumer } from './consumer'
import type { Logger } from './handler'

const log: Logger = {
  info: (message, meta) => console.log(JSON.stringify({ level: 'info', message, meta })),
  error: (message, meta) =>
    console.error(
      JSON.stringify({
        level: 'error',
        message,
        meta: meta instanceof Error ? { error: meta.message } : meta,
      }),
    ),
}

const config = loadConfig()
// One transaction per in-flight message, so the pool matches the prefetch window.
const pool = createPool(config.databaseUrl, config.prefetch)
const connection = await connectBroker(config.amqpUrl, { log: console.warn })

// Unacked messages are redelivered by RabbitMQ, so exiting on connection loss is safe;
// docker compose restarts the container.
connection.on('close', () => {
  log.error('broker connection closed, exiting')
  process.exit(1)
})

const consumer = await startConsumer({
  connection,
  pool,
  queue: config.readingsQueue,
  lateThresholdMs: config.lateThresholdMs,
  prefetch: config.prefetch,
  log,
})
log.info('consuming', { queue: config.readingsQueue, prefetch: config.prefetch })

async function shutdown(signal: string) {
  log.info(`${signal} received, shutting down`)
  await consumer.stop()
  await connection.close().catch(() => {})
  await pool.end()
  process.exit(0)
}

process.on('SIGTERM', () => void shutdown('SIGTERM'))
process.on('SIGINT', () => void shutdown('SIGINT'))
