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

/** Republishes an undecodable message body, resolving once the broker has confirmed it. */
export type DeadLetter = (content: Buffer) => Promise<void>

/**
 * Builds the per-delivery callback. Ack happens only after `processReading` resolves,
 * i.e. after the Postgres transaction commits; a crash before that leaves the message
 * unacked and RabbitMQ redelivers it. The returned promise never rejects.
 */
export function createMessageHandler(
  channel: AckChannel,
  processReading: ProcessReading,
  log: Logger,
  deadLetter?: DeadLetter,
) {
  // ack/nack throw synchronously once the channel is closed (e.g. the connection died while a
  // transaction was in flight). The message is then redelivered, so there is nothing to do.
  function settle(action: 'ack' | 'nack', message: DeliveredMessage, requeue = false) {
    try {
      if (action === 'ack') {
        channel.ack(message)
        return
      }
      channel.nack(message, false, requeue)
    } catch (error) {
      log.error(`could not ${action} message; the broker will redeliver it`, error)
    }
  }

  async function rejectUndecodable(message: DeliveredMessage) {
    if (!deadLetter) {
      log.error('dropping undecodable message', { content: message.content.toString('utf8') })
      settle('nack', message)
      return
    }
    try {
      await deadLetter(message.content)
      log.error('moved undecodable message to the dead-letter queue', {
        content: message.content.toString('utf8'),
      })
      settle('ack', message)
    } catch (error) {
      log.error('failed to dead-letter undecodable message, requeueing', error)
      settle('nack', message, true)
    }
  }

  return async function handleMessage(message: DeliveredMessage | null) {
    // amqplib delivers null when the broker cancels the consumer.
    if (!message) {
      log.error('consumer was cancelled by the broker')
      return
    }

    const decoded = decodeReadingMessage(message.content)
    if (!decoded) {
      // The api validates before publishing, so this is not a reading we can ever store.
      await rejectUndecodable(message)
      return
    }

    try {
      await processReading(decoded)
    } catch (error) {
      log.error('failed to process reading, requeueing', { error, reading: decoded.reading })
      settle('nack', message, true)
      return
    }
    settle('ack', message)
  }
}
