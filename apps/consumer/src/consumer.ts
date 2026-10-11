import type { BrokerConnection } from '@telemetry/broker'
import type { Pool } from '@telemetry/db'
import type { Logger } from './handler'

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

/**
 * Consumes `queue` and applies each message with processReading. The contract is documented
 * in consumer.integration.test.ts.
 */
export async function startConsumer(_options: ConsumerOptions): Promise<RunningConsumer> {
  throw new Error('not implemented')
}
