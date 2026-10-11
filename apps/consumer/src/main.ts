import { assertReadingsQueue, connectBroker } from '@telemetry/broker'
import { createPool } from '@telemetry/db'
import { loadConfig } from './config'
import { createLoggingProcessor, createMessageHandler, type Logger } from './handler'

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
// TODO(phase 2A): the pool backs the transactional processor.
const pool = createPool(config.databaseUrl)
const connection = await connectBroker(config.amqpUrl, { log: console.warn })
const channel = await connection.createChannel()
await assertReadingsQueue(channel, config.readingsQueue)
await channel.prefetch(config.prefetch)

// Unacked messages are redelivered by RabbitMQ, so exiting on connection loss is safe;
// docker compose restarts the container.
connection.on('close', () => {
  log.error('broker connection closed, exiting')
  process.exit(1)
})

const handleMessage = createMessageHandler(channel, createLoggingProcessor(log), log)
const { consumerTag } = await channel.consume(config.readingsQueue, (message) => {
  void handleMessage(message)
})
log.info('consuming', { queue: config.readingsQueue, prefetch: config.prefetch })

async function shutdown(signal: string) {
  log.info(`${signal} received, shutting down`)
  await channel.cancel(consumerTag).catch(() => {})
  await connection.close().catch(() => {})
  await pool.end()
  process.exit(0)
}

process.on('SIGTERM', () => void shutdown('SIGTERM'))
process.on('SIGINT', () => void shutdown('SIGINT'))
