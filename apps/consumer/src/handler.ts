import {
  isIsoTimestampWithOffset,
  parseIngestReading,
  type ReadingMessage,
} from '@telemetry/shared'

/** The subset of an amqplib message the handler needs. */
export interface DeliveredMessage {
  content: Buffer
}

/** The subset of an amqplib channel the handler needs. */
export interface AckChannel {
  ack(message: DeliveredMessage): void
  nack(message: DeliveredMessage, allUpTo?: boolean, requeue?: boolean): void
}

export type ProcessReading = (message: ReadingMessage) => Promise<void>

export interface Logger {
  info(message: string, meta?: unknown): void
  error(message: string, meta?: unknown): void
}

export function decodeReadingMessage(content: Buffer): ReadingMessage | null {
  try {
    const decoded: unknown = JSON.parse(content.toString('utf8'))
    if (typeof decoded !== 'object' || decoded === null) {
      return null
    }
    const { reading, receivedAt } = decoded as Record<string, unknown>
    const parsed = parseIngestReading(reading)
    if (!parsed.ok || !isIsoTimestampWithOffset(receivedAt)) {
      return null
    }
    return { reading: parsed.value, receivedAt }
  } catch {
    return null
  }
}

/**
 * Builds the per-delivery callback. Ack happens only after `processReading` resolves,
 * which in phase 2 means after the Postgres transaction commits; a crash before
 * that leaves the message unacked and RabbitMQ redelivers it.
 */
export function createMessageHandler(
  channel: AckChannel,
  processReading: ProcessReading,
  log: Logger,
) {
  return async function handleMessage(message: DeliveredMessage | null) {
    // amqplib delivers null when the broker cancels the consumer.
    if (!message) {
      log.error('consumer was cancelled by the broker')
      return
    }

    const decoded = decodeReadingMessage(message.content)
    if (!decoded) {
      // The api validates before publishing, so this is not a reading we can ever store.
      log.error('dropping undecodable message', { content: message.content.toString('utf8') })
      channel.nack(message, false, false)
      return
    }

    try {
      await processReading(decoded)
      channel.ack(message)
    } catch (error) {
      log.error('failed to process reading, requeueing', { error, reading: decoded.reading })
      channel.nack(message, false, true)
    }
  }
}

/** Phase 1 placeholder: log only. Phase 2A replaces this with the transactional write. */
export function createLoggingProcessor(log: Logger): ProcessReading {
  return async (message) => {
    log.info('received reading', message)
  }
}
