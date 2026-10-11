import {
  isIsoTimestampWithOffset,
  parseIngestReading,
  type ReadingMessage,
} from '@telemetry/shared'
import { classifyError } from './errors'

/** The subset of an amqplib message the handler needs. */
export interface DeliveredMessage {
  content: Buffer
  properties?: { headers?: Record<string, unknown> }
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
    const { reading, receivedAt, naiveTime } = decoded as Record<string, unknown>
    const parsed = parseIngestReading(reading)
    if (!parsed.ok || !isIsoTimestampWithOffset(receivedAt)) {
      return null
    }
    // Absent on envelopes published before the clock check.
    return { reading: parsed.value, receivedAt, naiveTime: naiveTime === true }
  } catch {
    return null
  }
}

/** Republishes an undecodable message body, resolving once the broker has confirmed it. */
export type DeadLetter = (content: Buffer) => Promise<void>

/** Header counting the processing attempts a message has already had (rule 3). */
export const ATTEMPTS_HEADER = 'x-attempts'

export interface RetryPolicy {
  /** Republishes the body to the work queue with x-attempts = `attempts`, resolving once confirmed. */
  republish(content: Buffer, attempts: number): Promise<void>
  /** Delay before a transient error is retried. */
  retryDelayMs: number
  /** Total attempts for an unclassified error before it is dead-lettered. */
  maxAttempts: number
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function attemptsSoFar(message: DeliveredMessage): number {
  const attempts = Number(message.properties?.headers?.[ATTEMPTS_HEADER] ?? 0)
  return Number.isSafeInteger(attempts) && attempts > 0 ? attempts : 0
}

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
  retry?: RetryPolicy,
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

  async function moveToDeadLetter(message: DeliveredMessage, reason: string, error: unknown) {
    if (!deadLetter) {
      settle('nack', message)
      return
    }
    try {
      await deadLetter(message.content)
      log.error(`moved message to the dead-letter queue: ${reason}`, { error })
      settle('ack', message)
    } catch (deadLetterError) {
      log.error('failed to dead-letter message, requeueing', deadLetterError)
      await sleep(retry?.retryDelayMs ?? 0)
      settle('nack', message, true)
    }
  }

  /**
   * Rule 3: no message holds a prefetch slot forever. Data errors are dead-lettered at once,
   * transient errors are requeued after a delay with no cap, anything else is republished with
   * x-attempts and dead-lettered after maxAttempts.
   */
  async function handleFailure(message: DeliveredMessage, decoded: ReadingMessage, error: unknown) {
    const kind = classifyError(error)
    if (kind === 'data') {
      await moveToDeadLetter(message, 'data error', error)
      return
    }
    if (kind === 'transient' || !retry) {
      log.error('transient error processing reading, retrying', { error, reading: decoded.reading })
      await sleep(retry?.retryDelayMs ?? 0)
      settle('nack', message, true)
      return
    }

    const attempts = attemptsSoFar(message) + 1
    if (attempts >= retry.maxAttempts) {
      await moveToDeadLetter(message, `failed ${attempts} attempts`, error)
      return
    }
    log.error(`failed to process reading (attempt ${attempts}), retrying`, {
      error,
      reading: decoded.reading,
    })
    try {
      // Republish before ack: a crash in between leaves a duplicate, which processReading absorbs.
      await retry.republish(message.content, attempts)
      settle('ack', message)
    } catch (republishError) {
      log.error('failed to republish message, requeueing', republishError)
      await sleep(retry.retryDelayMs)
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
      await handleFailure(message, decoded, error)
      return
    }
    settle('ack', message)
  }
}
