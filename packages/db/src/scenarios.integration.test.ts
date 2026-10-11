import type { ReadingMessage } from '@telemetry/shared'
import {
  createTestDatabase,
  dateAt,
  isoAt,
  micros,
  storedCurrentState,
  storedDevices,
  storedReadings,
  type TestDatabase,
} from '@telemetry/test-harness'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Pool } from './pool'
import { processReading, type ProcessOutcome } from './processing'

/*
 * Drives the exact message shapes telemetry_generator.py produces through processReading
 * (same processing contract as processing.integration.test.ts). Arrival times are fixed so
 * the late/out_of_order expectations are deterministic: each message is "received" at its
 * simulated send time and processed 3 ms later.
 */

const ctx: { db?: TestDatabase } = {}

function pool(): Pool {
  return (ctx.db as TestDatabase).pool
}

interface Arrival {
  message: ReadingMessage
  /** Simulated processing time. */
  now: Date
}

function arrival(reading: ReadingMessage['reading'], base: string, sentAtMs: number): Arrival {
  return {
    message: { reading, receivedAt: isoAt(base, sentAtMs) },
    now: dateAt(base, sentAtMs + 3),
  }
}

function processAll(arrivals: Arrival[], lateThresholdMs = 30_000): Promise<ProcessOutcome[]> {
  return arrivals.reduce<Promise<ProcessOutcome[]>>(
    async (previous, { message, now }) => [
      ...(await previous),
      await processReading(pool(), message, { now, lateThresholdMs }),
    ],
    Promise.resolve([]),
  )
}

/** ISO string `base` + `offsetMicros` µs, keeping microsecond precision like Python's isoformat(). */
function isoMicrosAt(base: string, offsetMicros: number): string {
  const ms = Math.floor(offsetMicros / 1_000)
  const rest = String(offsetMicros % 1_000).padStart(3, '0')
  return isoAt(base, ms).replace(/\.(\d{3})Z$/, `.$1${rest}+00:00`)
}

beforeAll(async () => {
  ctx.db = await createTestDatabase({ poolSize: 8 })
})

afterAll(async () => {
  await ctx.db?.drop()
})

describe('replay scenario shape (scenario_replay)', () => {
  /*
   * gw-0 live: temperature, seq 1000+i, event_time = start + i*100ms, sent at i*100ms.
   * gw-1 backlog: vibration, seq i, event_time = start - (20-i)s, sent ascending from 500 ms,
   * 5 ms apart; seq 0, 4, 8, 12, 16 are resent byte-for-byte 1 ms later.
   */
  const START = '2026-10-10T12:00:00.000Z'

  function replayArrivals(device: string): Arrival[] {
    const live = Array.from({ length: 20 }, (_, i) =>
      arrival(
        {
          gateway_id: 'gw-0',
          device_id: device,
          metric: 'temperature',
          value: Math.round((60 + i * 1.5) * 10) / 10,
          event_time: isoMicrosAt(START, i * 100_000),
          sequence: 1000 + i,
        },
        START,
        i * 100,
      ),
    )
    const backlog = Array.from({ length: 20 }, (_, i) => {
      const reading = {
        gateway_id: 'gw-1',
        device_id: device,
        metric: 'vibration',
        value: i * 0.25,
        event_time: isoMicrosAt(START, -(20 - i) * 1_000_000),
        sequence: i,
      }
      const sent = arrival(reading, START, 500 + i * 5)
      return i % 4 === 0 ? [sent, arrival(reading, START, 500 + i * 5 + 1)] : [sent]
    }).flat()
    return [...live, ...backlog].sort(
      (a, b) => Date.parse(a.message.receivedAt) - Date.parse(b.message.receivedAt),
    )
  }

  it('stores every distinct reading once, drops the 5 resends, and never regresses current state', async () => {
    const device = 'known-device-replay-424242'

    const outcomes = await processAll(replayArrivals(device))

    expect(outcomes).toHaveLength(45)
    expect(outcomes.filter((o) => o.status === 'duplicate')).toHaveLength(5)
    expect(outcomes.filter((o) => o.status === 'conflict')).toHaveLength(0)
    const history = await storedReadings(pool(), device)
    expect(history.map((r) => [r.gateway_id, r.sequence])).toEqual([
      ...Array.from({ length: 20 }, (_, i) => ['gw-1', i]),
      ...Array.from({ length: 20 }, (_, i) => ['gw-0', 1000 + i]),
    ])
    expect(history.filter((r) => r.out_of_order)).toEqual([])
    expect(history.filter((r) => r.late)).toEqual([])
    expect(
      (await storedCurrentState(pool(), device)).map((s) => [
        s.metric,
        s.gateway_id,
        s.sequence,
        s.value,
      ]),
    ).toEqual([
      ['temperature', 'gw-0', 1019, 88.5],
      ['vibration', 'gw-1', 19, 4.75],
    ])
  })

  it('with a 10 s threshold flags exactly backlog seq 0-10 late', async () => {
    const device = 'known-device-replay-10s'

    await processAll(replayArrivals(device), 10_000)

    const late = (await storedReadings(pool(), device)).filter((r) => r.late)
    expect(late.map((r) => [r.gateway_id, r.sequence])).toEqual(
      Array.from({ length: 11 }, (_, i) => ['gw-1', i]),
    )
  })

  it('gives the same result when the live and backlog senders run in parallel', async () => {
    const device = 'known-device-replay-parallel'
    const arrivals = replayArrivals(device)
    const lane = (gateway: string) =>
      arrivals.filter((a) => a.message.reading.gateway_id === gateway)

    await Promise.all([processAll(lane('gw-0')), processAll(lane('gw-1'))])

    expect(await storedReadings(pool(), device)).toHaveLength(40)
    expect((await storedCurrentState(pool(), device)).map((s) => [s.metric, s.sequence])).toEqual([
      ['temperature', 1019],
      ['vibration', 19],
    ])
  })
})

describe('race scenario shape (scenario_race)', () => {
  /*
   * gw-race-0 and gw-race-1 each send seq 0, metric status, value 1 (an int) for the same new
   * device, released together. event_times differ by microseconds.
   */
  it('20 rounds: one device, both readings kept, current = the later event_time', async () => {
    const rounds = Array.from({ length: 20 }, (_, r) => r)

    await rounds.reduce(async (previous, r) => {
      await previous
      const device = `new-device-${10000 + r}`
      const base = isoAt('2026-10-10T12:00:00.000Z', r * 1_000)
      const laterGateway = r % 2 === 0 ? 'gw-race-1' : 'gw-race-0'
      const messages = ['gw-race-0', 'gw-race-1'].map((gateway) => ({
        reading: {
          gateway_id: gateway,
          device_id: device,
          metric: 'status',
          value: 1,
          event_time: isoMicrosAt(base, gateway === laterGateway ? 137 : 0),
          sequence: 0,
        },
        receivedAt: isoAt(base, 2),
      }))

      const outcomes = await Promise.all(
        messages.map((m) =>
          processReading(pool(), m, { now: dateAt(base, 5), lateThresholdMs: 30_000 }),
        ),
      )

      expect(outcomes.map((o) => o.status)).toEqual(['inserted', 'inserted'])
      expect(outcomes.filter((o) => o.deviceDiscovered)).toHaveLength(1)
      expect(await storedDevices(pool(), device)).toMatchObject([{ status: 'unregistered' }])
      expect((await storedReadings(pool(), device)).map((row) => row.gateway_id).sort()).toEqual([
        'gw-race-0',
        'gw-race-1',
      ])
      expect(await storedCurrentState(pool(), device)).toMatchObject([
        { metric: 'status', value: 1, gateway_id: laterGateway },
      ])
    }, Promise.resolve())
  })

  it('identical event_times: the tie-break makes gw-race-1 current', async () => {
    const device = 'new-device-tie'
    const reading = (gateway: string) => ({
      reading: {
        gateway_id: gateway,
        device_id: device,
        metric: 'status',
        value: 1,
        event_time: '2026-10-10T12:00:00.123456+00:00',
        sequence: 0,
      },
      receivedAt: '2026-10-10T12:00:00.200Z',
    })

    await Promise.all(
      ['gw-race-0', 'gw-race-1'].map((g) =>
        processReading(pool(), reading(g), {
          now: new Date('2026-10-10T12:00:00.300Z'),
          lateThresholdMs: 30_000,
        }),
      ),
    )

    expect(await storedDevices(pool(), device)).toHaveLength(1)
    expect((await storedCurrentState(pool(), device)).map((s) => s.gateway_id)).toEqual([
      'gw-race-1',
    ])
  })
})

describe('clean scenario shape (scenario_clean)', () => {
  /*
   * 3 gateways x 5 devices x 10 readings, event_time = base + i*200ms for every gateway, so the
   * same device gets equal event_times from all 3 gateways. Metric is fixed per (device, i) here
   * (random in the generator) so every tie is on the same metric.
   */
  it('stores all 150 readings and resolves every tie to the greatest gateway_id', async () => {
    const base = '2026-10-10T12:00:00.000Z'
    const metrics = ['temperature', 'vibration', 'power_draw', 'status']
    const arrivals = Array.from({ length: 3 }, (_, g) =>
      Array.from({ length: 5 }, (_, d) =>
        Array.from({ length: 10 }, (_, i) =>
          arrival(
            {
              gateway_id: `gw-clean-${g}-777`,
              device_id: `known-device-clean-${d}-777`,
              metric: metrics[(d + i) % 4] as string,
              value: g * 100 + d * 10 + i,
              event_time: isoMicrosAt(base, i * 200_000),
              sequence: i,
            },
            base,
            (g * 50 + d * 10 + i) * 20,
          ),
        ),
      ),
    ).flat(2)

    const outcomes = await processAll(arrivals)

    expect(outcomes.filter((o) => o.status === 'inserted')).toHaveLength(150)
    expect(outcomes.filter((o) => o.deviceDiscovered)).toHaveLength(5)
    const devices = Array.from({ length: 5 }, (_, d) => d)
    await Promise.all(
      devices.map(async (d) => {
        const device = `known-device-clean-${d}-777`
        const latestI = (metric: string) =>
          Math.max(
            ...Array.from({ length: 10 }, (_, i) => i).filter(
              (i) => metrics[(d + i) % 4] === metric,
            ),
          )
        const expected = [...metrics]
          .sort()
          .map((metric) => [
            metric,
            'gw-clean-2-777',
            latestI(metric),
            200 + d * 10 + latestI(metric),
          ])
        expect(await storedReadings(pool(), device)).toHaveLength(30)
        expect(await storedDevices(pool(), device)).toMatchObject([
          { first_seen_gateway_id: 'gw-clean-0-777' },
        ])
        expect(
          (await storedCurrentState(pool(), device)).map((s) => [
            s.metric,
            s.gateway_id,
            s.sequence,
            s.value,
          ]),
        ).toEqual(expected)
      }),
    )
  })
})

describe('trace scenario (--seed joe-alfaro), as hand-traced in DESIGN.md', () => {
  /*
   * Printed sequence (device trace-device-2493). event_time = B + offset; sent 50 ms apart,
   * so message k is received at B + 50k ms.
   */
  const B = '2026-10-10T12:00:00.000Z'
  const DEVICE = 'trace-device-2493'
  const GW_A = 'gw-a-joe-alfaro'
  const GW_B = 'gw-b-joe-alfaro'
  const EVENTS: [number, string, string, number, number][] = [
    [0, GW_A, 'temperature', 41.73, 0],
    [1, GW_B, 'power_draw', 32.63, 2],
    [2, GW_B, 'temperature', 36.52, 3],
    [3, GW_A, 'temperature', 91.83, 4],
    [4, GW_B, 'temperature', 23.15, 1],
    [5, GW_B, 'status', 81.31, 5],
    [5, GW_B, 'status', 81.31, 5],
  ]

  function traceArrivals(base: string, device = DEVICE): Arrival[] {
    return EVENTS.map(([seq, gateway, metric, value, offset], k) =>
      arrival(
        {
          gateway_id: gateway,
          device_id: device,
          metric,
          value,
          event_time: isoMicrosAt(base, offset * 1_000_000),
          sequence: seq,
        },
        base,
        k * 50,
      ),
    )
  }

  it('matches the hand trace: outcomes, flags, history and current per metric', async () => {
    const outcomes = await processAll(traceArrivals(B))

    expect(outcomes.map((o) => [o.status, o.late, o.outOfOrder, o.currentStateUpdated])).toEqual([
      ['inserted', false, false, true],
      ['inserted', false, false, true],
      ['inserted', false, false, true],
      ['inserted', false, false, true],
      ['inserted', false, true, false],
      ['inserted', false, false, true],
      ['duplicate', false, false, false],
    ])
    expect(outcomes.map((o) => o.deviceDiscovered)).toEqual([
      true,
      false,
      false,
      false,
      false,
      false,
      false,
    ])

    expect(
      (await storedReadings(pool(), DEVICE)).map((r) => [
        r.event_time,
        r.sequence,
        r.gateway_id,
        r.metric,
        r.value,
        r.late,
        r.out_of_order,
      ]),
    ).toEqual([
      [micros(isoAt(B, 0)), 0, GW_A, 'temperature', 41.73, false, false],
      [micros(isoAt(B, 1_000)), 4, GW_B, 'temperature', 23.15, false, true],
      [micros(isoAt(B, 2_000)), 1, GW_B, 'power_draw', 32.63, false, false],
      [micros(isoAt(B, 3_000)), 2, GW_B, 'temperature', 36.52, false, false],
      [micros(isoAt(B, 4_000)), 3, GW_A, 'temperature', 91.83, false, false],
      [micros(isoAt(B, 5_000)), 5, GW_B, 'status', 81.31, false, false],
    ])
    expect(
      (await storedCurrentState(pool(), DEVICE)).map((s) => [
        s.metric,
        s.value,
        s.event_time,
        s.gateway_id,
        s.sequence,
      ]),
    ).toEqual([
      ['power_draw', 32.63, micros(isoAt(B, 2_000)), GW_B, 1],
      ['status', 81.31, micros(isoAt(B, 5_000)), GW_B, 5],
      ['temperature', 91.83, micros(isoAt(B, 4_000)), GW_A, 3],
    ])
    expect(await storedDevices(pool(), DEVICE)).toMatchObject([
      { status: 'unregistered', first_seen_gateway_id: GW_A },
    ])
  })

  it('re-running the trace with a new base time stores 6 new readings with the same flags, and run 2 becomes current', async () => {
    const device = 'trace-device-2493-rerun'
    const B2 = isoAt(B, 3_600_000)
    const flags = (outcomes: ProcessOutcome[]) =>
      outcomes.map((o) => [o.status, o.late, o.outOfOrder, o.currentStateUpdated])

    const run1 = await processAll(traceArrivals(B, device))
    const run2 = await processAll(traceArrivals(B2, device))

    expect(flags(run2)).toEqual(flags(run1))
    expect(run2.map((o) => o.deviceDiscovered)).toEqual(Array.from({ length: 7 }, () => false))
    const history = await storedReadings(pool(), device)
    expect(history).toHaveLength(12)
    expect(history.map((r) => [r.event_time, r.sequence, r.late, r.out_of_order])).toEqual(
      [B, B2].flatMap((base) => [
        [micros(isoAt(base, 0)), 0, false, false],
        [micros(isoAt(base, 1_000)), 4, false, true],
        [micros(isoAt(base, 2_000)), 1, false, false],
        [micros(isoAt(base, 3_000)), 2, false, false],
        [micros(isoAt(base, 4_000)), 3, false, false],
        [micros(isoAt(base, 5_000)), 5, false, false],
      ]),
    )
    expect(
      (await storedCurrentState(pool(), device)).map((s) => [
        s.metric,
        s.value,
        s.event_time,
        s.gateway_id,
        s.sequence,
      ]),
    ).toEqual([
      ['power_draw', 32.63, micros(isoAt(B2, 2_000)), GW_B, 1],
      ['status', 81.31, micros(isoAt(B2, 5_000)), GW_B, 5],
      ['temperature', 91.83, micros(isoAt(B2, 4_000)), GW_A, 3],
    ])
    expect(await storedDevices(pool(), device)).toHaveLength(1)
  })
})
