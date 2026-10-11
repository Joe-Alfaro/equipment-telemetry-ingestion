import { assertReadingsQueue, type BrokerConnection } from '@telemetry/broker'
import { processReading, type Pool } from '@telemetry/db'
import { createMessageHandler, type Logger } from './handler'

export interface ConsumerOptions {
  connection: BrokerConnection
  pool: Pool
  queue: string
  lateThresholdMs: number
  prefetch?: number
  now?: () => Date
  log?: Logger
}

export interface RunningConsumer {
  /** Cancels consumption, waits for in-flight messages to settle (ack/nack), then closes the channel. */
  stop(): Promise<void>
}

const silentLog: Logger = { info: () => {}, error: () => {} }

export function deadLetterQueueName(queue: string): string {
  return `${queue}.dead-letter`
}

/**
 * Consumes `queue` and applies each message with processReading. The contract is documented
 * in consumer.integration.test.ts.
 *
 * Undecodable messages are republished to `${queue}.dead-letter` by the consumer itself rather
 * than through x-dead-letter-* queue arguments: changing the arguments of an existing durable
 * queue fails with PRECONDITION_FAILED, so this works unchanged on volumes created before the
 * dead-letter queue existed (decision t).
 */
export async function startConsumer({
  connection,
  pool,
  queue,
  lateThresholdMs,
  prefetch = 20,
  now = () => new Date(),
  log = silentLog,
}: ConsumerOptions): Promise<RunningConsumer> {
  const channel = await connection.createConfirmChannel()
  // Without a listener an 'error' event (e.g. the connection dying) would crash the process.
  channel.on('error', (error) => log.error('consumer channel error', error))
  const deadLetterQueue = deadLetterQueueName(queue)
  await assertReadingsQueue(channel, queue)
  await channel.assertQueue(deadLetterQueue, { durable: true })
  await channel.prefetch(prefetch)

  function deadLetter(content: Buffer): Promise<void> {
    return new Promise((resolve, reject) => {
      channel.sendToQueue(deadLetterQueue, content, { persistent: true }, (error) =>
        error ? reject(error) : resolve(),
      )
    })
  }

  const handleMessage = createMessageHandler(
    channel,
    async (message) => {
      await processReading(pool, message, { now: now(), lateThresholdMs })
    },
    log,
    deadLetter,
  )

  const inFlight = new Set<Promise<void>>()
  const { consumerTag } = await channel.consume(queue, (message) => {
    const handled = handleMessage(message)
    inFlight.add(handled)
    void handled.finally(() => inFlight.delete(handled)).catch(() => {})
  })

  async function stop() {
    await channel.cancel(consumerTag).catch(() => {})
    await Promise.allSettled([...inFlight])
    await channel.close().catch(() => {})
  }

  return { stop }
}
