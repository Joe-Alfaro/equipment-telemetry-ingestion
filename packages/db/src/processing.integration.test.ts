import type { ReadingMessage } from '@telemetry/shared'
import {
  createTestDatabase,
  dateAt,
  isoAt,
  micros,
  readingMessage,
  storedCurrentState,
  storedDevices,
  storedReadings,
  type ReadingOverrides,
  type TestDatabase,
} from '@telemetry/test-harness'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Pool } from './pool'
import { processReading, type ProcessOutcome } from './processing'

/*
 * CONTRACT: processReading(pool, message, { now, lateThresholdMs }): Promise<ProcessOutcome>
 *
 * Runs ONE Postgres transaction per message and resolves only after COMMIT. Concurrent
 * calls are separate transactions; every invariant below must hold under any interleaving
 * and is enforced by constraints / row locks, not by timing.
 *
 * Identity (decision e): (gateway_id, device_id, sequence).
 *   - New key                        -> 'inserted'.
 *   - Existing key, same payload     -> 'duplicate'. Same payload = same metric, same value and
 *                                       the same event_time instant (offsets may differ).
 *                                       received_at is not part of the payload.
 *   - Existing key, different payload -> 'conflict'. The first copy is kept untouched, the
 *                                       rejected wire body is recorded in reading_conflicts
 *                                       (payload = the IngestReading JSON, received_at = message.receivedAt).
 *   - 'duplicate' and 'conflict' write no readings row and never touch current_state or devices;
 *     their outcome flags are all false.
 *
 * Stored columns: received_at = message.receivedAt, processed_at = options.now.
 *
 * Flags (decision h), computed for 'inserted' only:
 *   - late:        now - event_time > lateThresholdMs (strictly greater). Future event_times are
 *                  accepted as-is and are never late.
 *   - out_of_order: event_time is strictly older than the stored current_state event_time for the
 *                  same (device_id, metric) at processing time. An equal event_time that loses the
 *                  tie-break is NOT out_of_order. First reading of a metric is never out_of_order.
 *
 * current_state (decision f): per (device_id, metric), replaced only when the reading's
 *   (event_time, gateway_id, sequence) is strictly greater, compared in that order with full
 *   microsecond precision and sequence compared numerically. updated_at = now.
 *
 * devices (decision g): the first reading of an unknown device creates exactly one row
 *   (status 'unregistered', first_seen_at = that message's receivedAt, first_seen_gateway_id =
 *   its gateway). deviceDiscovered is true for exactly that one transaction. Later readings never
 *   change status, name, first_seen_* or claimed_at.
 *
 * gateways: every processed message (inserted, duplicate or conflict) upserts its gateway with
 *   last_seen_at = GREATEST(existing, message.receivedAt). A resend still proves the gateway is
 *   online; a redelivered old message never moves last_seen_at backwards.
 */

const BASE = '2026-10-10T12:00:00.000Z'
const LATE_THRESHOLD_MS = 30_000
const NOW = dateAt(BASE, 1_000)

const ctx: { db?: TestDatabase } = {}

function pool(): Pool {
  return (ctx.db as TestDatabase).pool
}

function apply(
  message: ReadingMessage,
  { now = NOW, lateThresholdMs = LATE_THRESHOLD_MS }: { now?: Date; lateThresholdMs?: number } = {},
): Promise<ProcessOutcome> {
  return processReading(pool(), message, { now, lateThresholdMs })
}

/** Processes messages one after another, in array order. */
async function processInOrder(messages: ReadingMessage[]): Promise<ProcessOutcome[]> {
  return messages.reduce<Promise<ProcessOutcome[]>>(
    async (previous, message) => [...(await previous), await apply(message)],
    Promise.resolve([]),
  )
}

async function count(sql: string, params: unknown[]): Promise<number> {
  const { rows } = await pool().query<{ n: number }>(
    `SELECT count(*)::int AS n FROM ${sql}`,
    params,
  )
  return rows[0]?.n ?? -1
}

function msg(overrides: ReadingOverrides): ReadingMessage {
  return readingMessage(overrides)
}

const INSERTED_FLAGS_OFF: ProcessOutcome = {
  status: 'inserted',
  late: false,
  outOfOrder: false,
  deviceDiscovered: false,
  currentStateUpdated: true,
}

const NO_OP = {
  late: false,
  outOfOrder: false,
  deviceDiscovered: false,
  currentStateUpdated: false,
}

beforeAll(async () => {
  ctx.db = await createTestDatabase({ poolSize: 16 })
})

afterAll(async () => {
  await ctx.db?.drop()
})

describe('processReading: dedup on (gateway_id, device_id, sequence) (invariant 1)', () => {
  it.fails('stores a reading resent 5 times exactly once', async () => {
    const message = msg({ device_id: 'dedup-serial', value: 21.5 })

    const outcomes = await processInOrder(
      [0, 1, 2, 3, 4].map((i) => ({ ...message, receivedAt: isoAt(BASE, 100 + i) })),
    )

    expect(outcomes.map((o) => o.status)).toEqual([
      'inserted',
      'duplicate',
      'duplicate',
      'duplicate',
      'duplicate',
    ])
    expect(outcomes.slice(1)).toEqual(
      Array.from({ length: 4 }, () => ({ status: 'duplicate', ...NO_OP })),
    )
    expect(await count('readings WHERE device_id = $1', ['dedup-serial'])).toBe(1)
    expect(await count('reading_conflicts WHERE device_id = $1', ['dedup-serial'])).toBe(0)
  })

  it.fails(
    'collapses 8 concurrent copies into one row with exactly one inserted outcome',
    async () => {
      const message = msg({ device_id: 'dedup-concurrent', value: 3.25 })

      const outcomes = await Promise.all(Array.from({ length: 8 }, () => apply(message)))

      expect(outcomes.filter((o) => o.status === 'inserted')).toHaveLength(1)
      expect(outcomes.filter((o) => o.status === 'duplicate')).toHaveLength(7)
      expect(outcomes.filter((o) => o.deviceDiscovered)).toHaveLength(1)
      expect(await count('readings WHERE device_id = $1', ['dedup-concurrent'])).toBe(1)
      expect(await count('devices WHERE device_id = $1', ['dedup-concurrent'])).toBe(1)
    },
  )

  it.fails(
    'treats the same event_time instant written with another offset as a duplicate, not a conflict',
    async () => {
      await apply(msg({ device_id: 'dedup-offset', event_time: '2026-10-10T12:00:00.000+00:00' }))

      const outcome = await apply(
        msg({ device_id: 'dedup-offset', event_time: '2026-10-10T14:00:00.000+02:00' }),
      )

      expect(outcome.status).toBe('duplicate')
      expect(await count('reading_conflicts WHERE device_id = $1', ['dedup-offset'])).toBe(0)
    },
  )

  it.fails(
    'same key with a different value is a conflict: keeps the first copy and records the rejected one',
    async () => {
      const first = msg({ device_id: 'conflict-value', value: 10 })
      const second = msg({ device_id: 'conflict-value', value: 99, receivedAt: isoAt(BASE, 500) })
      await apply(first)

      const outcome = await apply(second)

      expect(outcome).toEqual({ status: 'conflict', ...NO_OP })
      const history = await storedReadings(pool(), 'conflict-value')
      expect(history.map((r) => r.value)).toEqual([10])
      const { rows } = await pool().query<{
        payload: unknown
        received_at: Date
        sequence: string
      }>(
        `SELECT payload, received_at, sequence FROM reading_conflicts
        WHERE gateway_id = $1 AND device_id = $2`,
        ['gw-a', 'conflict-value'],
      )
      expect(rows).toHaveLength(1)
      expect(rows[0]?.payload).toEqual(second.reading)
      expect(rows[0]?.received_at.toISOString()).toBe(second.receivedAt)
    },
  )

  it.fails(
    'a conflicting copy with a newer event_time or another metric never touches current_state',
    async () => {
      await apply(msg({ device_id: 'conflict-state', value: 10 }))
      const before = await storedCurrentState(pool(), 'conflict-state')

      const newer = await apply(
        msg({ device_id: 'conflict-state', value: 50, event_time: isoAt(BASE, 60_000) }),
      )
      const otherMetric = await apply(
        msg({ device_id: 'conflict-state', metric: 'vibration', value: 7 }),
      )

      expect([newer.status, otherMetric.status]).toEqual(['conflict', 'conflict'])
      expect(await storedCurrentState(pool(), 'conflict-state')).toEqual(before)
      expect(await count('readings WHERE device_id = $1', ['conflict-state'])).toBe(1)
    },
  )

  it.fails(
    'the same sequence on another device or another gateway is a distinct reading',
    async () => {
      const outcomes = await processInOrder([
        msg({ gateway_id: 'gw-a', device_id: 'seq-reuse-1', sequence: 3 }),
        msg({ gateway_id: 'gw-a', device_id: 'seq-reuse-2', sequence: 3 }),
        msg({ gateway_id: 'gw-b', device_id: 'seq-reuse-1', sequence: 3 }),
      ])

      expect(outcomes.map((o) => o.status)).toEqual(['inserted', 'inserted', 'inserted'])
      expect(
        await count('readings WHERE device_id = ANY($1)', [['seq-reuse-1', 'seq-reuse-2']]),
      ).toBe(3)
    },
  )

  it.fails('stores received_at from the message and processed_at from options.now', async () => {
    const now = dateAt(BASE, 2_345)
    await apply(msg({ device_id: 'stored-times', receivedAt: isoAt(BASE, 1_234) }), { now })

    const [row] = await storedReadings(pool(), 'stored-times')

    expect(row).toEqual({
      gateway_id: 'gw-a',
      device_id: 'stored-times',
      sequence: 0,
      metric: 'temperature',
      value: 20,
      event_time: micros(BASE),
      received_at: micros(isoAt(BASE, 1_234)),
      processed_at: micros(now.toISOString()),
      late: false,
      out_of_order: false,
    })
  })
})

describe('processReading: current_state is monotonic in (event_time, gateway_id, sequence) (invariant 2)', () => {
  it.fails(
    'a newer reading followed by an older one leaves current on the newer value; the older is stored and flagged',
    async () => {
      const newer = await apply(
        msg({ device_id: 'ooo-1', sequence: 1, value: 2, event_time: isoAt(BASE, 5_000) }),
      )
      const older = await apply(
        msg({ device_id: 'ooo-1', sequence: 0, value: 1, event_time: isoAt(BASE, 1_000) }),
      )

      expect(newer).toEqual({ ...INSERTED_FLAGS_OFF, deviceDiscovered: true })
      expect(older).toEqual({ ...INSERTED_FLAGS_OFF, outOfOrder: true, currentStateUpdated: false })
      expect(await storedCurrentState(pool(), 'ooo-1')).toEqual([
        {
          metric: 'temperature',
          value: 2,
          event_time: micros(isoAt(BASE, 5_000)),
          gateway_id: 'gw-a',
          sequence: 1,
          updated_at: micros(NOW.toISOString()),
        },
      ])
      const history = await storedReadings(pool(), 'ooo-1')
      expect(history.map((r) => [r.sequence, r.out_of_order])).toEqual([
        [0, true],
        [1, false],
      ])
    },
  )

  it.fails(
    'an older reading followed by a newer one advances current and flags neither',
    async () => {
      await apply(
        msg({ device_id: 'ooo-2', sequence: 0, value: 1, event_time: isoAt(BASE, 1_000) }),
      )
      const newer = await apply(
        msg({ device_id: 'ooo-2', sequence: 1, value: 2, event_time: isoAt(BASE, 5_000) }),
      )

      expect(newer).toEqual(INSERTED_FLAGS_OFF)
      expect((await storedCurrentState(pool(), 'ooo-2')).map((s) => s.value)).toEqual([2])
      expect((await storedReadings(pool(), 'ooo-2')).map((r) => r.out_of_order)).toEqual([
        false,
        false,
      ])
    },
  )

  it.fails('an out-of-order reading does not touch current_state.updated_at', async () => {
    await apply(msg({ device_id: 'ooo-updated-at', sequence: 1, event_time: isoAt(BASE, 5_000) }), {
      now: dateAt(BASE, 6_000),
    })
    await apply(msg({ device_id: 'ooo-updated-at', sequence: 0, event_time: isoAt(BASE, 1_000) }), {
      now: dateAt(BASE, 9_000),
    })

    expect((await storedCurrentState(pool(), 'ooo-updated-at'))[0]?.updated_at).toBe(
      micros(isoAt(BASE, 6_000)),
    )
  })

  it.fails('a replayed backlog from another gateway never regresses the same metric', async () => {
    await apply(
      msg({
        gateway_id: 'gw-live',
        device_id: 'ooo-backlog',
        sequence: 1000,
        value: 75,
        event_time: isoAt(BASE, 0),
      }),
    )

    const backlog = await processInOrder(
      [20, 15, 10, 5, 1].map((secondsAgo, i) =>
        msg({
          gateway_id: 'gw-backlog',
          device_id: 'ooo-backlog',
          sequence: i,
          value: i,
          event_time: isoAt(BASE, -secondsAgo * 1_000),
        }),
      ),
    )

    expect(backlog.map((o) => [o.status, o.outOfOrder, o.currentStateUpdated])).toEqual(
      Array.from({ length: 5 }, () => ['inserted', true, false]),
    )
    expect(
      (await storedCurrentState(pool(), 'ooo-backlog')).map((s) => [s.gateway_id, s.value]),
    ).toEqual([['gw-live', 75]])
    expect(await count('readings WHERE device_id = $1', ['ooo-backlog'])).toBe(6)
  })

  it.fails('compares event_time with microsecond precision', async () => {
    await apply(
      msg({
        device_id: 'micros',
        sequence: 1,
        value: 2,
        event_time: '2026-10-10T12:00:00.123457+00:00',
      }),
    )
    const older = await apply(
      msg({
        device_id: 'micros',
        sequence: 0,
        value: 1,
        event_time: '2026-10-10T12:00:00.123456+00:00',
      }),
    )

    expect(older.outOfOrder).toBe(true)
    expect(await storedCurrentState(pool(), 'micros')).toMatchObject([
      { value: 2, event_time: '2026-10-10T12:00:00.123457Z' },
    ])
    expect((await storedReadings(pool(), 'micros')).map((r) => r.event_time)).toEqual([
      '2026-10-10T12:00:00.123456Z',
      '2026-10-10T12:00:00.123457Z',
    ])
  })

  it.fails('every arrival order of the same 4 readings yields the same current_state', async () => {
    const offsets = [3_000, 0, 2_000, 1_000]
    const permutations = (items: number[]): number[][] =>
      items.length <= 1
        ? [items]
        : items.flatMap((item, i) =>
            permutations([...items.slice(0, i), ...items.slice(i + 1)]).map((rest) => [
              item,
              ...rest,
            ]),
          )
    const orders = permutations([0, 1, 2, 3])

    await Promise.all(
      orders.map((order, p) =>
        processInOrder(
          order.map((i) =>
            msg({
              device_id: `perm-${p}`,
              sequence: i,
              value: offsets[i] as number,
              event_time: isoAt(BASE, offsets[i] as number),
            }),
          ),
        ),
      ),
    )

    const states = await Promise.all(orders.map((_, p) => storedCurrentState(pool(), `perm-${p}`)))
    expect(orders).toHaveLength(24)
    states.forEach((state) => {
      expect(state.map((s) => [s.value, s.sequence, s.event_time])).toEqual([
        [3_000, 0, micros(isoAt(BASE, 3_000))],
      ])
    })
  })

  it.fails(
    '12 concurrent readings for one (device, metric) leave current on the greatest event_time',
    async () => {
      const offsets = [7, 2, 11, 0, 5, 9, 1, 10, 3, 6, 8, 4]
      await apply(
        msg({
          device_id: 'concurrent-state',
          sequence: 100,
          value: -1,
          event_time: isoAt(BASE, -1),
        }),
      )

      await Promise.all(
        offsets.map((offset, i) =>
          apply(
            msg({
              gateway_id: `gw-${i % 3}`,
              device_id: 'concurrent-state',
              sequence: i,
              value: offset,
              event_time: isoAt(BASE, offset * 1_000),
            }),
          ),
        ),
      )

      expect(
        (await storedCurrentState(pool(), 'concurrent-state')).map((s) => [
          s.value,
          s.gateway_id,
          s.sequence,
        ]),
      ).toEqual([[11, 'gw-2', 2]])
      expect(await count('readings WHERE device_id = $1', ['concurrent-state'])).toBe(13)
    },
  )
})

describe('processReading: tie-break on equal event_time', () => {
  it.fails(
    'the greater gateway_id wins regardless of arrival order, and the loser is not out_of_order',
    async () => {
      const at = isoAt(BASE, 2_000)
      const a = (device: string) =>
        msg({ gateway_id: 'gw-a', device_id: device, value: 1, event_time: at })
      const b = (device: string) =>
        msg({ gateway_id: 'gw-b', device_id: device, value: 2, event_time: at })

      const ab = await processInOrder([a('tie-ab'), b('tie-ab')])
      const ba = await processInOrder([b('tie-ba'), a('tie-ba')])

      expect(ab.map((o) => [o.currentStateUpdated, o.outOfOrder])).toEqual([
        [true, false],
        [true, false],
      ])
      expect(ba.map((o) => [o.currentStateUpdated, o.outOfOrder])).toEqual([
        [true, false],
        [false, false],
      ])
      const winners = await Promise.all(
        ['tie-ab', 'tie-ba'].map((d) => storedCurrentState(pool(), d)),
      )
      winners.forEach((state) => {
        expect(state.map((s) => [s.gateway_id, s.value])).toEqual([['gw-b', 2]])
      })
    },
  )

  it.fails(
    'with equal event_time and gateway, the greater sequence wins, compared numerically',
    async () => {
      const at = isoAt(BASE, 2_000)

      await processInOrder([
        msg({ device_id: 'tie-seq', sequence: 10, value: 10, event_time: at }),
        msg({ device_id: 'tie-seq', sequence: 9, value: 9, event_time: at }),
      ])

      expect(
        (await storedCurrentState(pool(), 'tie-seq')).map((s) => [s.sequence, s.value]),
      ).toEqual([[10, 10]])
    },
  )

  it.fails(
    'event_time beats gateway_id: an earlier reading from a greater gateway does not win',
    async () => {
      await processInOrder([
        msg({
          gateway_id: 'gw-a',
          device_id: 'tie-time-first',
          value: 1,
          event_time: isoAt(BASE, 2_000),
        }),
        msg({
          gateway_id: 'gw-z',
          device_id: 'tie-time-first',
          value: 2,
          event_time: isoAt(BASE, 1_999),
        }),
      ])

      expect((await storedCurrentState(pool(), 'tie-time-first')).map((s) => s.gateway_id)).toEqual(
        ['gw-a'],
      )
    },
  )
})

describe('processReading: metrics are independent', () => {
  it.fails(
    'an older reading of one metric is not out_of_order relative to a newer reading of another',
    async () => {
      await apply(
        msg({
          device_id: 'metrics-1',
          metric: 'vibration',
          sequence: 0,
          value: 0.5,
          event_time: isoAt(BASE, 9_000),
        }),
      )
      const temperature = await apply(
        msg({
          device_id: 'metrics-1',
          metric: 'temperature',
          sequence: 1,
          value: 70,
          event_time: isoAt(BASE, 1_000),
        }),
      )

      expect(temperature).toEqual(INSERTED_FLAGS_OFF)
      expect(
        (await storedCurrentState(pool(), 'metrics-1')).map((s) => [s.metric, s.value]),
      ).toEqual([
        ['temperature', 70],
        ['vibration', 0.5],
      ])
    },
  )

  it.fails('out_of_order is decided per metric', async () => {
    const outcomes = await processInOrder([
      msg({
        device_id: 'metrics-2',
        metric: 'temperature',
        sequence: 0,
        event_time: isoAt(BASE, 5_000),
      }),
      msg({
        device_id: 'metrics-2',
        metric: 'power_draw',
        sequence: 1,
        event_time: isoAt(BASE, 6_000),
      }),
      msg({
        device_id: 'metrics-2',
        metric: 'temperature',
        sequence: 2,
        event_time: isoAt(BASE, 4_000),
      }),
      msg({
        device_id: 'metrics-2',
        metric: 'power_draw',
        sequence: 3,
        event_time: isoAt(BASE, 7_000),
      }),
    ])

    expect(outcomes.map((o) => o.outOfOrder)).toEqual([false, false, true, false])
    expect(
      (await storedCurrentState(pool(), 'metrics-2')).map((s) => [s.metric, s.sequence]),
    ).toEqual([
      ['power_draw', 3],
      ['temperature', 0],
    ])
  })
})

describe('processReading: late flag (now - event_time > lateThresholdMs)', () => {
  it.fails(
    'is not late at exactly the threshold and late 1 ms past it; both are stored',
    async () => {
      const atThreshold = await apply(
        msg({ device_id: 'late-boundary', sequence: 0, event_time: isoAt(BASE, -30_000) }),
        { now: dateAt(BASE, 0) },
      )
      const pastThreshold = await apply(
        msg({ device_id: 'late-boundary', sequence: 1, event_time: isoAt(BASE, -30_001) }),
        { now: dateAt(BASE, 0) },
      )

      expect([atThreshold.late, pastThreshold.late]).toEqual([false, true])
      expect(
        (await storedReadings(pool(), 'late-boundary')).map((r) => [r.sequence, r.late]),
      ).toEqual([
        [1, true],
        [0, false],
      ])
    },
  )

  it.fails('honours the configured threshold', async () => {
    const outcome = await apply(
      msg({ device_id: 'late-config', event_time: isoAt(BASE, -1_001) }),
      { now: dateAt(BASE, 0), lateThresholdMs: 1_000 },
    )

    expect(outcome.late).toBe(true)
  })

  it.fails(
    'accepts a future event_time as-is: stored, not late, and it becomes current',
    async () => {
      const future = isoAt(BASE, 5_000)

      const outcome = await apply(msg({ device_id: 'late-future', event_time: future }), {
        now: dateAt(BASE, 0),
      })

      expect(outcome).toEqual({ ...INSERTED_FLAGS_OFF, deviceDiscovered: true })
      expect(
        (await storedReadings(pool(), 'late-future')).map((r) => [r.event_time, r.late]),
      ).toEqual([[micros(future), false]])
      expect((await storedCurrentState(pool(), 'late-future')).map((s) => s.event_time)).toEqual([
        micros(future),
      ])
    },
  )

  it.fails(
    'a late reading is only flagged: it still becomes current when it is the newest',
    async () => {
      const outcome = await apply(
        msg({ device_id: 'late-current', event_time: isoAt(BASE, -60_000) }),
        {
          now: dateAt(BASE, 0),
        },
      )

      expect(outcome).toEqual({ ...INSERTED_FLAGS_OFF, late: true, deviceDiscovered: true })
      expect(await storedCurrentState(pool(), 'late-current')).toHaveLength(1)
    },
  )
})

describe('processReading: exactly-once registration (invariant 3)', () => {
  it.fails(
    'the first reading creates one unregistered device; later readings leave it unchanged',
    async () => {
      const first = await apply(
        msg({ gateway_id: 'gw-b', device_id: 'reg-serial', receivedAt: isoAt(BASE, 100) }),
      )
      const second = await apply(
        msg({
          gateway_id: 'gw-a',
          device_id: 'reg-serial',
          sequence: 1,
          receivedAt: isoAt(BASE, 200),
        }),
      )

      expect([first.deviceDiscovered, second.deviceDiscovered]).toEqual([true, false])
      expect(await storedDevices(pool(), 'reg-serial')).toEqual([
        {
          device_id: 'reg-serial',
          status: 'unregistered',
          name: null,
          first_seen_at: micros(isoAt(BASE, 100)),
          first_seen_gateway_id: 'gw-b',
          claimed_at: null,
        },
      ])
    },
  )

  it.fails(
    '12 parallel first reports from 12 gateways register the device once and keep all 12 readings (10 rounds)',
    async () => {
      const rounds = Array.from({ length: 10 }, (_, r) => `reg-race-${r}`)

      await rounds.reduce(async (previous, device) => {
        await previous
        const messages = Array.from({ length: 12 }, (_, g) =>
          msg({
            gateway_id: `gw-${String(g).padStart(2, '0')}`,
            device_id: device,
            metric: 'status',
            value: 1,
            event_time: isoAt(BASE, g),
            receivedAt: isoAt(BASE, 100 + g),
          }),
        )

        const outcomes = await Promise.all(messages.map((m) => apply(m)))

        expect(outcomes.map((o) => o.status)).toEqual(Array.from({ length: 12 }, () => 'inserted'))
        const discoverers = messages.filter((_, i) => outcomes[i]?.deviceDiscovered)
        expect(discoverers).toHaveLength(1)
        const devices = await storedDevices(pool(), device)
        expect(devices).toHaveLength(1)
        expect(devices[0]?.first_seen_gateway_id).toBe(discoverers[0]?.reading.gateway_id)
        expect(devices[0]?.first_seen_at).toBe(micros(discoverers[0]?.receivedAt as string))
        expect(await count('readings WHERE device_id = $1', [device])).toBe(12)
        expect((await storedCurrentState(pool(), device)).map((s) => s.gateway_id)).toEqual([
          'gw-11',
        ])
      }, Promise.resolve())
    },
  )

  it.fails('4 gateways x 5 readings all in parallel: one device, 20 readings', async () => {
    const messages = Array.from({ length: 20 }, (_, i) =>
      msg({
        gateway_id: `gw-${i % 4}`,
        device_id: 'reg-burst',
        metric: ['temperature', 'vibration'][i % 2] as string,
        sequence: Math.floor(i / 4),
        value: i,
        event_time: isoAt(BASE, i * 10),
      }),
    )

    const outcomes = await Promise.all(messages.map((m) => apply(m)))

    expect(outcomes.filter((o) => o.deviceDiscovered)).toHaveLength(1)
    expect(await count('devices WHERE device_id = $1', ['reg-burst'])).toBe(1)
    expect(await count('readings WHERE device_id = $1', ['reg-burst'])).toBe(20)
    expect((await storedCurrentState(pool(), 'reg-burst')).map((s) => [s.metric, s.value])).toEqual(
      [
        ['temperature', 18],
        ['vibration', 19],
      ],
    )
  })

  it.fails(
    'readings for a registered device keep it registered with its name and claim time',
    async () => {
      await apply(msg({ device_id: 'reg-claimed' }))
      await pool().query(
        `UPDATE devices SET status = 'registered', name = 'Chiller 1', claimed_at = $2 WHERE device_id = $1`,
        ['reg-claimed', isoAt(BASE, 500)],
      )

      const outcome = await apply(
        msg({ device_id: 'reg-claimed', sequence: 1, event_time: isoAt(BASE, 1) }),
      )

      expect(outcome.deviceDiscovered).toBe(false)
      expect(await storedDevices(pool(), 'reg-claimed')).toMatchObject([
        { status: 'registered', name: 'Chiller 1', claimed_at: micros(isoAt(BASE, 500)) },
      ])
    },
  )
})

describe('processReading: gateways.last_seen_at = GREATEST(existing, receivedAt)', () => {
  async function lastSeen(gatewayId: string): Promise<string[]> {
    const { rows } = await pool().query<{ last_seen_at: Date }>(
      'SELECT last_seen_at FROM gateways WHERE gateway_id = $1',
      [gatewayId],
    )
    return rows.map((row) => row.last_seen_at.toISOString())
  }

  it.fails('creates the gateway on first message and advances it on later ones', async () => {
    await apply(
      msg({ gateway_id: 'gw-seen', device_id: 'gw-seen-dev', receivedAt: isoAt(BASE, 100) }),
    )
    expect(await lastSeen('gw-seen')).toEqual([isoAt(BASE, 100)])

    await apply(
      msg({
        gateway_id: 'gw-seen',
        device_id: 'gw-seen-dev',
        sequence: 1,
        receivedAt: isoAt(BASE, 900),
      }),
    )
    expect(await lastSeen('gw-seen')).toEqual([isoAt(BASE, 900)])
  })

  it.fails(
    'a redelivered message with an older receivedAt does not move last_seen_at backwards',
    async () => {
      await apply(
        msg({
          gateway_id: 'gw-redeliver',
          device_id: 'gw-r-dev',
          sequence: 1,
          receivedAt: isoAt(BASE, 900),
        }),
      )
      await apply(
        msg({
          gateway_id: 'gw-redeliver',
          device_id: 'gw-r-dev',
          sequence: 0,
          receivedAt: isoAt(BASE, 100),
        }),
      )

      expect(await lastSeen('gw-redeliver')).toEqual([isoAt(BASE, 900)])
    },
  )

  it.fails('a duplicate or a conflict still counts as the gateway being seen', async () => {
    await apply(
      msg({ gateway_id: 'gw-resend', device_id: 'gw-resend-dev', receivedAt: isoAt(BASE, 100) }),
    )

    const duplicate = await apply(
      msg({ gateway_id: 'gw-resend', device_id: 'gw-resend-dev', receivedAt: isoAt(BASE, 400) }),
    )
    expect(duplicate.status).toBe('duplicate')
    expect(await lastSeen('gw-resend')).toEqual([isoAt(BASE, 400)])

    const conflict = await apply(
      msg({
        gateway_id: 'gw-resend',
        device_id: 'gw-resend-dev',
        value: -5,
        receivedAt: isoAt(BASE, 700),
      }),
    )
    expect(conflict.status).toBe('conflict')
    expect(await lastSeen('gw-resend')).toEqual([isoAt(BASE, 700)])
  })
})
