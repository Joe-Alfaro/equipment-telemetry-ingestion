import type { ReadingMessage } from '@telemetry/shared'
import { createTestDatabase, dateAt, isoAt, type TestDatabase } from '@telemetry/test-harness'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Pool } from './pool'
import { processReading } from './processing'
import { listDevices, listGateways } from './queries'

/*
 * CONTRACT (gateway clock check rule 7): the generator's clean, replay and race scenarios and the
 * Joe-Alfaro trace raise NO clock warnings. Their skews are at most a few seconds (the replay
 * backlog is negative), and their event_times carry offsets, so naiveTime is false.
 *
 * The message shapes and arrival times are the ones in scenarios.integration.test.ts: each message
 * is received at its simulated send time and processed 3 ms later.
 */

const ctx: { db?: TestDatabase } = {}

function pool(): Pool {
  return (ctx.db as TestDatabase).pool
}

interface Arrival {
  message: ReadingMessage
  now: Date
}

function arrival(reading: ReadingMessage['reading'], base: string, sentAtMs: number): Arrival {
  return {
    message: { reading, receivedAt: isoAt(base, sentAtMs), naiveTime: false },
    now: dateAt(base, sentAtMs + 3),
  }
}

async function processAll(arrivals: Arrival[]) {
  await arrivals.reduce(async (previous, { message, now }) => {
    await previous
    await processReading(pool(), message, { now, lateThresholdMs: 30_000 })
  }, Promise.resolve())
}

/** ISO string `base` + `offsetMicros` µs with a +00:00 offset, like Python's isoformat(). */
function isoMicrosAt(base: string, offsetMicros: number): string {
  const ms = Math.floor(offsetMicros / 1_000)
  const rest = String(((offsetMicros % 1_000) + 1_000) % 1_000).padStart(3, '0')
  return isoAt(base, ms).replace(/\.(\d{3})Z$/, `.$1${rest}+00:00`)
}

function cleanArrivals(): Arrival[] {
  const base = '2026-10-10T12:00:00.000Z'
  const metrics = ['temperature', 'vibration', 'power_draw', 'status']
  return Array.from({ length: 3 }, (_, g) =>
    Array.from({ length: 5 }, (_, d) =>
      Array.from({ length: 10 }, (_, i) =>
        arrival(
          {
            gateway_id: `gw-clean-${g}`,
            device_id: `known-device-clean-${d}`,
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
}

function replayArrivals(): Arrival[] {
  const start = '2026-10-10T13:00:00.000Z'
  const device = 'known-device-replay'
  const live = Array.from({ length: 20 }, (_, i) =>
    arrival(
      {
        gateway_id: 'gw-0',
        device_id: device,
        metric: 'temperature',
        value: 60 + i,
        event_time: isoMicrosAt(start, i * 100_000),
        sequence: 1000 + i,
      },
      start,
      i * 100,
    ),
  )
  const backlog = Array.from({ length: 20 }, (_, i) => {
    const reading = {
      gateway_id: 'gw-1',
      device_id: device,
      metric: 'vibration',
      value: i * 0.25,
      event_time: isoMicrosAt(start, -(20 - i) * 1_000_000),
      sequence: i,
    }
    const sent = arrival(reading, start, 500 + i * 5)
    return i % 4 === 0 ? [sent, arrival(reading, start, 500 + i * 5 + 1)] : [sent]
  }).flat()
  return [...live, ...backlog].sort(
    (a, b) => Date.parse(a.message.receivedAt) - Date.parse(b.message.receivedAt),
  )
}

function raceArrivals(): Arrival[] {
  return Array.from({ length: 20 }, (_, r) => {
    const base = isoAt('2026-10-10T14:00:00.000Z', r * 1_000)
    return ['gw-race-0', 'gw-race-1'].map((gateway) =>
      arrival(
        {
          gateway_id: gateway,
          device_id: `new-device-${10000 + r}`,
          metric: 'status',
          value: 1,
          event_time: isoMicrosAt(base, gateway === 'gw-race-1' ? 137 : 0),
          sequence: 0,
        },
        base,
        2,
      ),
    )
  }).flat()
}

/** The Joe-Alfaro trace (TRACE.md), run three times an hour apart so both gateways have >= 5 readings. */
function traceArrivals(): Arrival[] {
  const events: [number, string, string, number, number][] = [
    [0, 'gw-a-Joe-Alfaro', 'power_draw', 90.94, 0],
    [1, 'gw-a-Joe-Alfaro', 'vibration', 56.07, 4],
    [2, 'gw-b-Joe-Alfaro', 'status', 83.48, 1],
    [3, 'gw-b-Joe-Alfaro', 'status', 85.86, 2],
    [4, 'gw-b-Joe-Alfaro', 'status', 82.05, 3],
    [5, 'gw-b-Joe-Alfaro', 'status', 58.44, 5],
    [5, 'gw-b-Joe-Alfaro', 'status', 58.44, 5],
  ]
  return ['2026-10-10T15:00:00.000Z', '2026-10-10T16:00:00.000Z', '2026-10-10T17:00:00.000Z']
    .map((base) =>
      events.map(([sequence, gateway, metric, value, offset], k) =>
        arrival(
          {
            gateway_id: gateway,
            device_id: 'trace-device-8720',
            metric,
            value,
            event_time: isoMicrosAt(base, offset * 1_000_000),
            sequence,
          },
          base,
          k * 50,
        ),
      ),
    )
    .flat()
}

beforeAll(async () => {
  ctx.db = await createTestDatabase({ poolSize: 4 })
  await processAll([...cleanArrivals(), ...replayArrivals(), ...raceArrivals(), ...traceArrivals()])
})

afterAll(async () => {
  await ctx.db?.drop()
})

describe('generator scenario shapes raise no clock warnings (rule 7)', () => {
  const options = { now: new Date('2026-10-10T18:00:00.000Z'), lateThresholdMs: 30_000 }

  it.fails('judges every scenario gateway ok, with the samples it has', async () => {
    const gateways = await listGateways(pool(), options)

    expect(gateways.map((gateway) => [gateway.gatewayId, gateway.clock])).toStrictEqual([
      ['gw-0', { status: 'ok', offsetMs: null, samples: 20 }],
      ['gw-1', { status: 'ok', offsetMs: null, samples: 20 }],
      ['gw-a-Joe-Alfaro', { status: 'ok', offsetMs: null, samples: 6 }],
      ['gw-b-Joe-Alfaro', { status: 'ok', offsetMs: null, samples: 12 }],
      ['gw-clean-0', { status: 'ok', offsetMs: null, samples: 20 }],
      ['gw-clean-1', { status: 'ok', offsetMs: null, samples: 20 }],
      ['gw-clean-2', { status: 'ok', offsetMs: null, samples: 20 }],
      ['gw-race-0', { status: 'ok', offsetMs: null, samples: 20 }],
      ['gw-race-1', { status: 'ok', offsetMs: null, samples: 20 }],
    ])
  })

  it.fails('gives every scenario device an empty clockWarnings array', async () => {
    const devices = await listDevices(pool(), options)

    expect(devices).toHaveLength(5 + 1 + 20 + 1)
    expect(devices.filter((device) => !Array.isArray(device.clockWarnings))).toEqual([])
    expect(devices.flatMap((device) => device.clockWarnings ?? [])).toEqual([])
  })
})
