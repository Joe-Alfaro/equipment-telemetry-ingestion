import { createReadingPublisher } from '@telemetry/broker'
import { createPool, processReading, type Pool } from '@telemetry/db'
import type { ReadingMessage } from '@telemetry/shared'
import {
  createTestBroker,
  createTestDatabase,
  dateAt,
  getOneMessage,
  isoAt,
  readingMessage,
  type ReadingOverrides,
  type TestBroker,
  type TestDatabase,
} from '@telemetry/test-harness'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { startConsumer, type ConsumerOptions, type RunningConsumer } from './consumer'

/*
 * CONTRACT (rule 3): no message may hold a prefetch slot forever.
 *
 *   - Deterministic data errors go to `${queue}.dead-letter` at once, body unchanged, after ONE
 *     attempt: Postgres SQLSTATE class 22 (data exception), class 54 (program limit), and class 23
 *     (anything other than the unique conflict processReading already handles).
 *   - Transient errors are retried after a delay (option retryDelayMs, default about 1000 ms) with
 *     NO attempt cap, so a database outage loses nothing and never dead-letters: connection errors,
 *     class 08, 57P01/57P02/57P03, ECONNREFUSED and ETIMEDOUT.
 *   - Any other error is retried by republishing the body with an `x-attempts` header (the number
 *     of attempts already made) and acking the original, up to maxAttempts (default 5) attempts in
 *     total, then dead-lettered. A message that arrives with x-attempts = 4 gets one more attempt.
 *   - Valid readings queued behind poison messages are still stored.
 *
 * Errors that cannot be produced for real are injected through the processReading option, the
 * boundary between the consumer and Postgres.
 */

const BASE = '2026-10-10T12:00:00.000Z'

const ctx: { db?: TestDatabase; broker?: TestBroker; consumers: RunningConsumer[] } = {
  consumers: [],
}

function pool(): Pool {
  return (ctx.db as TestDatabase).pool
}

function broker(): TestBroker {
  return ctx.broker as TestBroker
}

function deadLetterQueue(): string {
  return `${broker().queue}.dead-letter`
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
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
    await sleep(25)
    return poll()
  }
  return poll()
}

async function queueCount(queue: string): Promise<number> {
  const channel = await broker().connection.createChannel()
  try {
    return (await channel.checkQueue(queue)).messageCount
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

async function start(options: Partial<ConsumerOptions> = {}): Promise<RunningConsumer> {
  const consumer = await startConsumer({
    connection: broker().connection,
    pool: pool(),
    queue: broker().queue,
    lateThresholdMs: 30_000,
    ...options,
  })
  ctx.consumers.push(consumer)
  return consumer
}

/** Sends raw bodies straight to the queue, bypassing api validation, in order. */
async function sendRaw(bodies: Buffer[], headers?: Record<string, unknown>): Promise<void> {
  const channel = await broker().connection.createConfirmChannel()
  bodies.forEach((body) => channel.sendToQueue(broker().queue, body, { persistent: true, headers }))
  await channel.waitForConfirms()
  await channel.close()
}

function body(overrides: ReadingOverrides): Buffer {
  return Buffer.from(JSON.stringify(readingMessage(overrides)))
}

async function publish(overrides: ReadingOverrides): Promise<ReadingMessage> {
  const message = readingMessage(overrides)
  const publisher = await createReadingPublisher(broker().connection, broker().queue)
  await publisher.publish(message)
  await publisher.close()
  return message
}

interface FailingProcessor {
  processReading: typeof processReading
  calls(): number
}

/** Delegates to the real processReading, but throws `failure()` for one device while it returns an error. */
function failFor(deviceId: string, failure: (attempt: number) => Error | null): FailingProcessor {
  const state = { calls: 0 }
  const wrapped: typeof processReading = async (target, message, options) => {
    if (message.reading.device_id !== deviceId) {
      return processReading(target, message, options)
    }
    state.calls += 1
    const error = failure(state.calls)
    if (error) {
      throw error
    }
    return processReading(target, message, options)
  }
  return { processReading: wrapped, calls: () => state.calls }
}

function pgError(code: string): Error {
  return Object.assign(new Error(`injected SQLSTATE ${code}`), { code })
}

beforeAll(async () => {
  ctx.db = await createTestDatabase({ poolSize: 22 })
})

afterAll(async () => {
  await ctx.db?.drop()
})

beforeEach(async () => {
  ctx.broker = await createTestBroker()
})

afterEach(async () => {
  await Promise.all(ctx.consumers.map((consumer) => consumer.stop().catch(() => {})))
  ctx.consumers = []
  const channel = await broker().connection.createChannel()
  await channel.deleteQueue(deadLetterQueue()).catch(() => {})
  await channel.close().catch(() => {})
  await broker().close()
})

describe('consumer: deterministic data errors go to the dead-letter queue (rule 3)', () => {
  it.fails.each([
    ['22008 datetime field overflow', '22008'],
    ['22P05 untranslatable character (NUL)', '22P05'],
    ['22001 string data right truncation', '22001'],
    ['54000 program limit exceeded (index row size)', '54000'],
    ['23502 not-null violation', '23502'],
    ['23514 check violation', '23514'],
    ['23505 unique violation outside the handled conflict', '23505'],
  ])(
    '%s: dead-lettered after one attempt without blocking the next reading',
    async (_label, code) => {
      const poison = failFor('poison-data', () => pgError(code))
      await start({ processReading: poison.processReading })

      const sent = await publish({ device_id: 'poison-data' })
      await publish({ device_id: `after-${code}` })

      expect(
        await eventually(
          () => readingCount(`after-${code}`),
          (n) => n === 1,
        ),
      ).toBe(1)
      const dead = await getOneMessage(broker().connection, deadLetterQueue())
      expect(JSON.parse(dead?.content.toString('utf8') ?? 'null')).toEqual(sent)
      await sleep(300)
      expect(poison.calls()).toBe(1)
      expect(await queueCount(broker().queue)).toBe(0)
      expect(await readingCount('poison-data')).toBe(0)
    },
  )

  it.fails(
    '25 real poison messages (Feb 30) then 1 valid reading: the valid one is stored within a few seconds',
    async () => {
      await start({ prefetch: 20 })
      const poison = Array.from({ length: 25 }, (_, i) =>
        body({ device_id: 'poison-feb30', sequence: i, event_time: '2026-02-30T00:00:00Z' }),
      )

      await sendRaw(poison)
      await publish({ device_id: 'behind-poison' })

      expect(
        await eventually(
          () => readingCount('behind-poison'),
          (n) => n === 1,
        ),
      ).toBe(1)
      expect(
        await eventually(
          () => queueCount(deadLetterQueue()),
          (n) => n === 25,
        ),
      ).toBe(25)
      expect(await queueCount(broker().queue)).toBe(0)
      expect(await readingCount('poison-feb30')).toBe(0)
    },
  )
})

describe('consumer: unclassified errors retry with x-attempts, then dead-letter (rule 3)', () => {
  it.fails(
    'a generic error is attempted 5 times in total, then dead-lettered with its body unchanged',
    async () => {
      const failing = failFor('c-generic', () => new Error('something unexpected'))
      await start({ processReading: failing.processReading })

      const sent = await publish({ device_id: 'c-generic' })

      const dead = await getOneMessage(broker().connection, deadLetterQueue(), {
        timeoutMs: 15_000,
      })
      expect(JSON.parse(dead?.content.toString('utf8') ?? 'null')).toEqual(sent)
      await sleep(500)
      expect(failing.calls()).toBe(5)
      expect(await queueCount(broker().queue)).toBe(0)
    },
  )

  it.fails(
    'honours an incoming x-attempts header: x-attempts 4 gets one last attempt',
    async () => {
      const failing = failFor('c-attempts', () => new Error('something unexpected'))
      await start({ processReading: failing.processReading })

      await sendRaw([body({ device_id: 'c-attempts' })], { 'x-attempts': 4 })

      const dead = await getOneMessage(broker().connection, deadLetterQueue(), { timeoutMs: 5_000 })
      expect(dead).not.toBeNull()
      await sleep(300)
      expect(failing.calls()).toBe(1)
    },
  )

  // Holds before rule 3 too (plain requeue); kept as a guard for the x-attempts retry path.
  it('a generic error that clears on the 3rd attempt is stored once and not dead-lettered', async () => {
    const flaky = failFor('c-flaky', (attempt) => (attempt < 3 ? new Error('flaky') : null))
    await start({ processReading: flaky.processReading })

    await publish({ device_id: 'c-flaky' })

    expect(
      await eventually(
        () => readingCount('c-flaky'),
        (n) => n === 1,
        10_000,
      ),
    ).toBe(1)
    await sleep(300)
    expect(flaky.calls()).toBe(3)
    expect(await queueCount(deadLetterQueue())).toBe(0)
    expect(await queueCount(broker().queue)).toBe(0)
  })
})

describe('consumer: transient database errors are retried after a delay, uncapped (rule 3)', () => {
  /** Real connection failures: a pool pointing at a port nothing listens on. */
  function outage(): { processReading: typeof processReading; calls(): number; end(): void } {
    const dead = createPool('postgres://telemetry:telemetry@127.0.0.1:1/telemetry', 2)
    const state = { down: true, calls: 0 }
    const wrapped: typeof processReading = async (target, message, options) => {
      if (!state.down) {
        return processReading(target, message, options)
      }
      state.calls += 1
      return processReading(dead, message, options)
    }
    return {
      processReading: wrapped,
      calls: () => state.calls,
      end: () => {
        state.down = false
        void dead.end().catch(() => {})
      },
    }
  }

  it.fails(
    'ECONNREFUSED during a DB outage: retried with a delay past 5 attempts, stored once the DB is back, never dead-lettered',
    async () => {
      const db = outage()
      await start({ processReading: db.processReading, retryDelayMs: 100 })

      await publish({ device_id: 'c-outage' })
      await sleep(1_500)
      const attemptsDuringOutage = db.calls()
      db.end()

      // Delayed (about 15 attempts in 1.5 s, not a hot loop) and uncapped (more than 5).
      expect(attemptsDuringOutage).toBeGreaterThan(5)
      expect(attemptsDuringOutage).toBeLessThanOrEqual(20)
      expect(
        await eventually(
          () => readingCount('c-outage'),
          (n) => n === 1,
        ),
      ).toBe(1)
      expect(await queueCount(deadLetterQueue())).toBe(0)
      expect(await queueCount(broker().queue)).toBe(0)
    },
  )

  it.fails('the default retry delay is about 1 s', async () => {
    const db = outage()
    await start({ processReading: db.processReading })

    await publish({ device_id: 'c-outage-default' })
    await sleep(2_500)
    const attemptsDuringOutage = db.calls()
    db.end()

    expect(attemptsDuringOutage).toBeGreaterThanOrEqual(2)
    expect(attemptsDuringOutage).toBeLessThanOrEqual(5)
    expect(
      await eventually(
        () => readingCount('c-outage-default'),
        (n) => n === 1,
      ),
    ).toBe(1)
    expect(await queueCount(deadLetterQueue())).toBe(0)
  })

  it.fails.each([
    ['08006 connection failure', pgError('08006')],
    ['57P01 admin shutdown', pgError('57P01')],
    ['57P02 crash shutdown', pgError('57P02')],
    ['57P03 cannot connect now', pgError('57P03')],
    ['ETIMEDOUT', Object.assign(new Error('connect ETIMEDOUT'), { code: 'ETIMEDOUT' })],
  ])(
    '%s is transient: retried with a delay past 5 attempts, then stored',
    async (_label, error) => {
      const state = { down: true }
      const transient = failFor('c-transient', () => (state.down ? error : null))
      await start({ processReading: transient.processReading, retryDelayMs: 100 })

      await publish({ device_id: 'c-transient' })
      await sleep(1_200)
      state.down = false
      const attemptsDuringOutage = transient.calls()

      expect(attemptsDuringOutage).toBeGreaterThan(5)
      expect(attemptsDuringOutage).toBeLessThanOrEqual(16)
      expect(
        await eventually(
          () => readingCount('c-transient'),
          (n) => n === 1,
        ),
      ).toBe(1)
      expect(await queueCount(deadLetterQueue())).toBe(0)
    },
  )
})

describe('consumer: future flag is configurable (rule 4)', () => {
  it.fails('passes futureSkewMs to processReading', async () => {
    const now = dateAt(BASE, 0)
    await start({ now: () => now, futureSkewMs: 1_000 })

    await publish({ device_id: 'c-future', sequence: 0, event_time: isoAt(BASE, 2_000) })
    await publish({ device_id: 'c-future', sequence: 1, event_time: isoAt(BASE, 500) })
    await eventually(
      () => readingCount('c-future'),
      (n) => n === 2,
    )

    const { rows } = await pool().query<{ sequence: number; future: boolean }>(
      `SELECT sequence::int AS sequence, future FROM readings
        WHERE device_id = 'c-future' ORDER BY sequence`,
    )
    expect(rows).toEqual([
      { sequence: 0, future: true },
      { sequence: 1, future: false },
    ])
  })
})
