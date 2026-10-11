import amqp from 'amqplib'

export type BrokerConnection = amqp.ChannelModel

export const DEFAULT_READINGS_QUEUE = 'readings'

export interface ConnectOptions {
  attempts?: number
  delayMs?: number
  log?: (message: string) => void
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Connects to RabbitMQ, retrying while the broker is still starting. */
export async function connectBroker(
  url: string,
  { attempts = 30, delayMs = 1000, log = () => {} }: ConnectOptions = {},
): Promise<BrokerConnection> {
  const tryConnect = async (attempt: number): Promise<BrokerConnection> => {
    try {
      return await amqp.connect(url)
    } catch (error) {
      if (attempt >= attempts) {
        throw error
      }
      log(`broker not reachable (attempt ${attempt}/${attempts}), retrying in ${delayMs}ms`)
      await sleep(delayMs)
      return tryConnect(attempt + 1)
    }
  }
  return tryConnect(1)
}

/** Readings must survive a broker restart, so the queue is durable. */
export async function assertReadingsQueue(
  channel: amqp.Channel,
  queue = DEFAULT_READINGS_QUEUE,
): Promise<void> {
  await channel.assertQueue(queue, { durable: true })
}
