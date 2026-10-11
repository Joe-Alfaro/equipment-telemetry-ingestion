import type { ReadingMessage } from '@telemetry/shared'
import { assertReadingsQueue, DEFAULT_READINGS_QUEUE, type BrokerConnection } from './connection'

export interface ReadingPublisher {
  /** Resolves only once the broker has confirmed the message is persisted. */
  publish(message: ReadingMessage): Promise<void>
  isReady(): boolean
  close(): Promise<void>
}

/**
 * Publishes persistent messages on a confirm channel. `publish` resolves on the
 * broker ack and rejects on a nack or a closed channel, so a 202 is only ever
 * returned for a reading the broker has taken responsibility for.
 */
export async function createReadingPublisher(
  connection: BrokerConnection,
  queue = DEFAULT_READINGS_QUEUE,
): Promise<ReadingPublisher> {
  const channel = await connection.createConfirmChannel()
  await assertReadingsQueue(channel, queue)

  const state = { open: true }
  channel.on('close', () => {
    state.open = false
  })
  channel.on('error', () => {
    state.open = false
  })

  function publish(message: ReadingMessage): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!state.open) {
        reject(new Error('publisher channel is closed'))
        return
      }
      try {
        channel.sendToQueue(
          queue,
          Buffer.from(JSON.stringify(message)),
          { persistent: true, contentType: 'application/json' },
          (error) => {
            if (error) {
              reject(error instanceof Error ? error : new Error('broker nacked the message'))
              return
            }
            resolve()
          },
        )
      } catch (error) {
        reject(error)
      }
    })
  }

  async function close() {
    if (!state.open) {
      return
    }
    state.open = false
    await channel.close()
  }

  return { publish, isReady: () => state.open, close }
}
