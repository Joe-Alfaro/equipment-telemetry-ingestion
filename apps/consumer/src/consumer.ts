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
  /** Passed to processReading as futureSkewMs (rule 4). Default 60000. */
  futureSkewMs?: number
  /** Delay before a transient error (DB unreachable) is retried. Default about 1000 (rule 3). */
  retryDelayMs?: number
  /** Attempts for an unclassified error before dead-lettering. Default 5 (rule 3). */
  maxAttempts?: number
  /** Test seam: replaces processReading so tests can inject failures at the DB boundary. */
  processReading?: typeof processReading
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
  processReading: process = processReading,
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
      await process(pool, message, { now: now(), lateThresholdMs })
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
