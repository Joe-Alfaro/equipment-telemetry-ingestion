import { randomUUID } from 'node:crypto'
import { connectBroker, type BrokerConnection } from '@telemetry/broker'
import { TEST_AMQP_URL } from './env'

export interface TestBroker {
  connection: BrokerConnection
  /** A queue name unique to this test broker; pass it to publishers and consumers. */
  queue: string
  /** Deletes the queue and closes the connection. */
  close(): Promise<void>
}

export async function createTestBroker(): Promise<TestBroker> {
  const connection = await connectBroker(TEST_AMQP_URL, { attempts: 1 })
  const queue = `it-readings-${randomUUID()}`

  async function close() {
    const channel = await connection.createChannel()
    await channel.deleteQueue(queue)
    await channel.close()
    await connection.close()
  }

  return { connection, queue, close }
}

/** Reads one message from the queue, polling until it arrives or the timeout passes. */
export async function getOneMessage(
  connection: BrokerConnection,
  queue: string,
  { timeoutMs = 5000, intervalMs = 50 } = {},
): Promise<{ content: Buffer } | null> {
  const channel = await connection.createChannel()
  const deadline = Date.now() + timeoutMs

  const poll = async (): Promise<{ content: Buffer } | null> => {
    const message = await channel.get(queue, { noAck: true })
    if (message) {
      return message
    }
    if (Date.now() >= deadline) {
      return null
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
    return poll()
  }

  try {
    return await poll()
  } finally {
    await channel.close()
  }
}
