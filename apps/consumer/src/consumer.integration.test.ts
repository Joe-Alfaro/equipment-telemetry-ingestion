import { connectBroker, createReadingPublisher, type BrokerConnection } from '@telemetry/broker'
import type { Pool } from '@telemetry/db'
import {
  createTestBroker,
  createTestDatabase,
  getOneMessage,
  micros,
  readingMessage,
  storedReadings,
  TEST_AMQP_URL,
  type TestBroker,
  type TestDatabase,
} from '@telemetry/test-harness'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { startConsumer } from './consumer'

/*
 * CONTRACT: startConsumer({ connection, pool, queue, lateThresholdMs, prefetch?, now?, log? })
 *
 *   - Asserts `queue` (durable) and its dead-letter queue `${queue}.dead-letter` (durable), then
 *     consumes `queue` with manual acks.
 *   - Each decodable message is applied with processReading(pool, message, { now: now(), lateThresholdMs })
 *     and acked only AFTER that transaction commits. 'duplicate' and 'conflict' outcomes are acked too.
 *   - A processing error is classified and retried or dead-lettered per rule 3; see
 *     consumer-errors.integration.test.ts (supersedes decision o's unbounded requeue).
 *   - An undecodable message (bad JSON or failing parseIngestReading) is routed to
 *     `${queue}.dead-letter` with its body byte-for-byte unchanged, and removed from `queue`.
 *     It is never silently dropped and never stored as a reading.
 *   - If the connection dies while a message is in flight, the message is NOT acked and RabbitMQ
 *     redelivers it; reprocessing it is a 'duplicate', so a crash between commit and ack creates
 *     no duplicate rows. A late ack/nack on a dead channel must not raise an unhandled rejection.
 *   - stop() cancels consumption, waits for in-flight messages to settle, then closes its channel
 *     (not the connection).
 */

const ctx: { db?: TestDatabase; broker?: TestBroker; extra: BrokerConnection[] } = { extra: [] }

function pool(): Pool {
  return (ctx.db as TestDatabase).pool
}

function broker(): TestBroker {
  return ctx.broker as TestBroker
}

function deadLetterQueue(): string {
  return `${broker().queue}.dead-letter`
}

async function eventually<T>(
  read: () => Promise<T>,
  done: (value: T) => boolean,
  timeoutMs = 5_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs
  const poll = async (): Promise<T> => {
    const value = await read()
    if (done(value) || Date.now() > deadline) {
      return value
    }
    await new Promise((resolve) => setTimeout(resolve, 25))
    return poll()
  }
  return poll()
}

async function readyCount(): Promise<number> {
  const channel = await broker().connection.createChannel()
  try {
    return (await channel.checkQueue(broker().queue)).messageCount
  } finally {
    await channel.close()
  }
}

async function readingCount(deviceId: string): Promise<number> {
  const { rows } = await pool().query<{ n: number }>(
    'SELECT count(*)::int AS n FROM readings WHERE device_id = $1',
    [deviceId],
  )
  return rows[0]?.n ?? -1
}

beforeAll(async () => {
  ctx.db = await createTestDatabase({ poolSize: 6 })
})

afterAll(async () => {
  await ctx.db?.drop()
})

beforeEach(async () => {
  ctx.broker = await createTestBroker()
})

afterEach(async () => {
  await Promise.all(ctx.extra.map((connection) => connection.close().catch(() => {})))
  ctx.extra = []
  const channel = await broker().connection.createChannel()
  await channel.deleteQueue(deadLetterQueue()).catch(() => {})
  await channel.close().catch(() => {})
  await broker().close()
})

describe('consumer: broker -> processReading -> ack', () => {
  it('stores a published reading with the injected clock and acks it after commit', async () => {
    const now = new Date('2026-10-10T12:01:00.000Z')
    const consumer = await startConsumer({
      connection: broker().connection,
      pool: pool(),
      queue: broker().queue,
      lateThresholdMs: 30_000,
      now: () => now,
    })
    const publisher = await createReadingPublisher(broker().connection, broker().queue)
    await publisher.publish(
      readingMessage({ device_id: 'c-e2e', event_time: '2026-10-10T12:00:00.000Z' }),
    )

    await eventually(
      () => readingCount('c-e2e'),
      (n) => n === 1,
    )
    await consumer.stop()
    await publisher.close()

    expect(await storedReadings(pool(), 'c-e2e')).toMatchObject([
      { processed_at: micros(now.toISOString()), late: true },
    ])
    expect(await readyCount()).toBe(0)
  })

  it('does not ack before commit; a crash before ack redelivers without creating a duplicate', async () => {
    const lock = await pool().connect()
    const crashing = await connectBroker(TEST_AMQP_URL, { attempts: 1 })
    ctx.extra.push(crashing)
    const publisher = await createReadingPublisher(broker().connection, broker().queue)
    try {
      // Block every write to readings so the consumer's transaction cannot commit yet.
      await lock.query('BEGIN')
      await lock.query('LOCK TABLE readings IN ACCESS EXCLUSIVE MODE')
      await startConsumer({
        connection: crashing,
        pool: pool(),
        queue: broker().queue,
        lateThresholdMs: 30_000,
      })
      await publisher.publish(readingMessage({ device_id: 'c-crash' }))
      const waiting = await eventually(
        async () =>
          (
            await pool().query<{ n: number }>(
              `SELECT count(*)::int AS n FROM pg_stat_activity
                WHERE datname = current_database() AND wait_event_type = 'Lock'`,
            )
          ).rows[0]?.n ?? 0,
        (n) => n > 0,
      )
      expect(waiting).toBeGreaterThan(0)

      // Crash: the consumer's connection dies while its transaction is still uncommitted.
      await crashing.close()
      expect(await eventually(readyCount, (n) => n === 1)).toBe(1)
    } finally {
      await lock.query('COMMIT').catch(() => {})
      lock.release()
    }

    // The orphaned transaction may still commit; the redelivery must then be a duplicate.
    const restarted = await startConsumer({
      connection: broker().connection,
      pool: pool(),
      queue: broker().queue,
      lateThresholdMs: 30_000,
    })
    await eventually(readyCount, (n) => n === 0)
    await eventually(
      () => readingCount('c-crash'),
      (n) => n === 1,
    )
    await restarted.stop()
    await publisher.close()

    expect(await readingCount('c-crash')).toBe(1)
    expect(await readyCount()).toBe(0)
  })
})

describe('consumer: undecodable messages go to the dead-letter queue', () => {
  it('routes bad JSON and invalid readings to <queue>.dead-letter unchanged and stores nothing', async () => {
    const consumer = await startConsumer({
      connection: broker().connection,
      pool: pool(),
      queue: broker().queue,
      lateThresholdMs: 30_000,
    })
    const badJson = Buffer.from('not json {')
    const invalid = Buffer.from(
      JSON.stringify({
        reading: { ...readingMessage({ device_id: 'c-dlq' }).reading, value: 'hot' },
        receivedAt: '2026-10-10T12:00:00.000Z',
      }),
    )
    const channel = await broker().connection.createChannel()
    channel.sendToQueue(broker().queue, badJson, { persistent: true })
    channel.sendToQueue(broker().queue, invalid, { persistent: true })
    await channel.close()

    const first = await getOneMessage(broker().connection, deadLetterQueue())
    const second = await getOneMessage(broker().connection, deadLetterQueue())
    await consumer.stop()

    expect([first?.content, second?.content]).toEqual([badJson, invalid])
    expect(await readyCount()).toBe(0)
    expect(await readingCount('c-dlq')).toBe(0)
  })
})
