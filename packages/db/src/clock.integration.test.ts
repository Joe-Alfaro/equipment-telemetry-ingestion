import type { ClockWarning, GatewayClock, ReadingMessage } from '@telemetry/shared'
import {
  createTestDatabase,
  dateAt,
  isoAt,
  micros,
  readingMessage,
  storedCurrentState,
  storedReadings,
  type ReadingOverrides,
  type TestDatabase,
} from '@telemetry/test-harness'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { listMigrations } from './migrate'
import type { Pool } from './pool'
import { processReading } from './processing'
import { getDevice, listDevices, listGateways } from './queries'

/*
 * CONTRACT: gateway clock check in the database (rules 1-4, 7). Detect, never correct.
 *
 * Migration 004:
 *   - readings.naive_time boolean NOT NULL DEFAULT false.
 *   - An index on readings (gateway_id, received_at DESC).
 * processReading stores ReadingMessage.naiveTime as readings.naive_time (absent -> false) and
 *   stores event_time, received_at, late, out_of_order, future and current_state exactly as before.
 * listGateways(pool, { now, lateThresholdMs, clockSkewThresholdMs = 60000 }) adds
 *   `clock: GatewayClock` to every gateway, computed over that gateway's last 20 stored readings by
 *   received_at (all devices), with skew = event_time - received_at (rules in clock.test.ts).
 * listDevices / getDevice add `clockWarnings: ClockWarning[]`: one entry for each gateway that has
 *   a stored reading for the device and whose clock is `ahead` or `local-time`, ordered by
 *   gatewayId; [] when there are none.
 *
 * Skew is built exactly: each message has a fixed receivedAt and event_time = receivedAt + skew,
 * and processing happens at receivedAt + 5 ms. Nothing sleeps.
 */

const BASE = '2026-10-10T12:00:00.000Z'
const THRESHOLD = 30_000
const MINUTE = 60_000
const UTC_PLUS_5_30 = 19_800_000
const UTC_MINUS_5 = -18_000_000

const ctx: { db?: TestDatabase } = {}

function pool(): Pool {
  return (ctx.db as TestDatabase).pool
}

interface SkewedReading extends ReadingOverrides {
  /** receivedAt = BASE + receivedOffsetMs. */
  receivedOffsetMs: number
  /** event_time = receivedAt + skewMs. */
  skewMs: number
  naiveTime?: boolean
}

function skewed({ receivedOffsetMs, skewMs, naiveTime, ...overrides }: SkewedReading) {
  const message = readingMessage({
    ...overrides,
    receivedAt: isoAt(BASE, receivedOffsetMs),
    event_time: isoAt(BASE, receivedOffsetMs + skewMs),
  })
  const withMarker: ReadingMessage = naiveTime === undefined ? message : { ...message, naiveTime }
  return { message: withMarker, now: dateAt(BASE, receivedOffsetMs + 5) }
}

async function seed(readings: SkewedReading[]) {
  await readings.reduce(async (previous, spec) => {
    await previous
    const { message, now } = skewed(spec)
    await processReading(pool(), message, { now, lateThresholdMs: THRESHOLD })
  }, Promise.resolve())
}

/** `count` readings from one gateway, sequences from `firstSequence`, received 1 s apart. */
function series(
  count: number,
  {
    gateway,
    device = 'dev-1',
    skewMs,
    naiveTime,
    startMs = 0,
    firstSequence = 0,
  }: {
    gateway: string
    device?: string
    skewMs: number | ((i: number) => number)
    naiveTime?: boolean
    startMs?: number
    firstSequence?: number
  },
): SkewedReading[] {
  return Array.from({ length: count }, (_, i) => ({
    gateway_id: gateway,
    device_id: device,
    sequence: firstSequence + i,
    receivedOffsetMs: startMs + i * 1_000,
    skewMs: typeof skewMs === 'function' ? skewMs(i) : skewMs,
    naiveTime,
  }))
}

async function clocks(
  options: { clockSkewThresholdMs?: number } = {},
): Promise<[string, GatewayClock | undefined][]> {
  const gateways = await listGateways(pool(), {
    now: dateAt(BASE, 60_000),
    lateThresholdMs: THRESHOLD,
    ...options,
  })
  return gateways.map((gateway) => [gateway.gatewayId, gateway.clock])
}

async function naiveFlags(deviceId: string): Promise<[number, boolean][]> {
  const { rows } = await pool().query<{ sequence: number; naive_time: boolean }>(
    `SELECT sequence::int AS sequence, naive_time FROM readings
      WHERE device_id = $1 ORDER BY sequence`,
    [deviceId],
  )
  return rows.map((row) => [row.sequence, row.naive_time])
}

beforeEach(async () => {
  ctx.db = await createTestDatabase({ poolSize: 4 })
})

afterEach(async () => {
  await ctx.db?.drop()
})

describe('migration 004 (rule 2)', () => {
  it('ships as the fourth migration', async () => {
    expect((await listMigrations()).filter((name) => /^004_.+\.sql$/.test(name))).toHaveLength(1)
  })

  it('adds readings.naive_time boolean NOT NULL DEFAULT false', async () => {
    const { rows } = await pool().query<{
      data_type: string
      is_nullable: string
      column_default: string | null
    }>(
      `SELECT data_type, is_nullable, column_default FROM information_schema.columns
        WHERE table_name = 'readings' AND column_name = 'naive_time'`,
    )

    expect(rows).toEqual([{ data_type: 'boolean', is_nullable: 'NO', column_default: 'false' }])
  })

  it('adds an index on readings (gateway_id, received_at DESC)', async () => {
    const { rows } = await pool().query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes WHERE tablename = 'readings'`,
    )

    expect(
      rows.filter((row) => /\(gateway_id, received_at DESC\)$/.test(row.indexdef)),
    ).toHaveLength(1)
  })
})

describe('processReading: the naive marker (rule 2)', () => {
  it('stores naiveTime true and false, and false when the envelope predates the marker', async () => {
    await seed([
      { device_id: 'dev-n', sequence: 0, receivedOffsetMs: 0, skewMs: 0, naiveTime: true },
      { device_id: 'dev-n', sequence: 1, receivedOffsetMs: 1_000, skewMs: 0, naiveTime: false },
      { device_id: 'dev-n', sequence: 2, receivedOffsetMs: 2_000, skewMs: 0 },
    ])

    expect(await naiveFlags('dev-n')).toEqual([
      [0, true],
      [1, false],
      [2, false],
    ])
  })

  it('never corrects a naive local-time reading: timestamps, flags and current state are as received', async () => {
    // A UTC+5:30 gateway sent 17:30 local with no offset; the api appended Z.
    await seed([
      {
        device_id: 'dev-local',
        sequence: 0,
        value: 42,
        receivedOffsetMs: 0,
        skewMs: UTC_PLUS_5_30,
        naiveTime: true,
      },
    ])

    const [stored] = await storedReadings(pool(), 'dev-local')
    expect(stored).toMatchObject({
      event_time: micros('2026-10-10T17:30:00.000Z'),
      received_at: micros(BASE),
      late: false,
      out_of_order: false,
    })
    const { rows } = await pool().query<{ future: boolean; naive_time: boolean }>(
      `SELECT future, naive_time FROM readings WHERE device_id = 'dev-local'`,
    )
    expect(rows).toEqual([{ future: true, naive_time: true }])
    expect(await storedCurrentState(pool(), 'dev-local')).toMatchObject([
      { metric: 'temperature', value: 42, event_time: micros('2026-10-10T17:30:00.000Z') },
    ])
  })
})

describe('listGateways: clock (rules 1, 3, 4, 5)', () => {
  it('reports local-time, ahead, ok-for-backlog and unknown gateways side by side', async () => {
    await seed([
      ...series(5, {
        gateway: 'gw-ist',
        skewMs: (i) => UTC_PLUS_5_30 + i * 1_000,
        naiveTime: true,
      }),
      ...series(5, { gateway: 'gw-est', skewMs: UTC_MINUS_5 + 2_000, naiveTime: true }),
      ...series(5, { gateway: 'gw-fast', skewMs: 2 * MINUTE + 300 }),
      ...series(20, { gateway: 'gw-replay', skewMs: (i) => -(20 - i) * 1_000 - 500 }),
      ...series(4, { gateway: 'gw-new', skewMs: 60 * MINUTE }),
      ...series(5, { gateway: 'gw-good', skewMs: (i) => (i % 2 === 0 ? 3_000 : -2_000) }),
    ])

    expect(await clocks()).toStrictEqual([
      ['gw-est', { status: 'local-time', offsetMs: UTC_MINUS_5, samples: 5 }],
      ['gw-fast', { status: 'ahead', offsetMs: 2 * MINUTE, samples: 5 }],
      ['gw-good', { status: 'ok', offsetMs: null, samples: 5 }],
      ['gw-ist', { status: 'local-time', offsetMs: UTC_PLUS_5_30, samples: 5 }],
      ['gw-new', { status: 'unknown', offsetMs: null, samples: 4 }],
      ['gw-replay', { status: 'ok', offsetMs: null, samples: 20 }],
    ])
  })

  it('windows the last 20 readings by received_at, across devices, whatever the processing order', async () => {
    // Processed first: 20 accurate readings received from BASE+10s. Processed last: 5 readings an
    // hour ahead but received earlier (a delayed batch), so their ids and event_times are the
    // greatest. Only received_at may decide the window.
    await seed([
      ...series(10, { gateway: 'gw-w', device: 'dev-a', skewMs: 0, startMs: 10_000 }),
      ...series(10, {
        gateway: 'gw-w',
        device: 'dev-b',
        skewMs: 0,
        startMs: 20_000,
        firstSequence: 10,
      }),
      ...series(5, {
        gateway: 'gw-w',
        device: 'dev-a',
        skewMs: 60 * MINUTE,
        startMs: 0,
        firstSequence: 100,
      }),
    ])

    expect(await clocks()).toStrictEqual([['gw-w', { status: 'ok', offsetMs: null, samples: 20 }]])
  })

  it('honors clockSkewThresholdMs', async () => {
    await seed(series(5, { gateway: 'gw-6s', skewMs: 6_000 }))

    expect(await clocks()).toStrictEqual([['gw-6s', { status: 'ok', offsetMs: null, samples: 5 }]])
    expect(await clocks({ clockSkewThresholdMs: 5_000 })).toStrictEqual([
      ['gw-6s', { status: 'ahead', offsetMs: 6_000, samples: 5 }],
    ])
  })
})

describe('listDevices / getDevice: clockWarnings (rule 5)', () => {
  it('lists each warned gateway that reported the device, ordered by gatewayId, and [] otherwise', async () => {
    await seed([
      // gw-ist and gw-fast are judged on all their readings; dev-1 gets one reading from each.
      ...series(4, {
        gateway: 'gw-ist',
        device: 'dev-2',
        skewMs: UTC_PLUS_5_30,
        naiveTime: true,
      }),
      ...series(1, {
        gateway: 'gw-ist',
        device: 'dev-1',
        skewMs: UTC_PLUS_5_30,
        naiveTime: true,
        startMs: 10_000,
        firstSequence: 50,
      }),
      ...series(4, { gateway: 'gw-fast', device: 'dev-2', skewMs: 3 * MINUTE }),
      ...series(1, {
        gateway: 'gw-fast',
        device: 'dev-1',
        skewMs: 3 * MINUTE,
        startMs: 10_000,
        firstSequence: 50,
      }),
      ...series(5, { gateway: 'gw-good', device: 'dev-1', skewMs: 1_000, startMs: 20_000 }),
      ...series(5, { gateway: 'gw-good', device: 'dev-3', skewMs: 1_000, startMs: 30_000 }),
      ...series(2, { gateway: 'gw-new', device: 'dev-3', skewMs: 60 * MINUTE, startMs: 40_000 }),
    ])

    const options = { now: dateAt(BASE, 60_000), lateThresholdMs: THRESHOLD }
    const devices = await listDevices(pool(), options)
    const expectedDev1: ClockWarning[] = [
      { gatewayId: 'gw-fast', status: 'ahead', offsetMs: 3 * MINUTE },
      { gatewayId: 'gw-ist', status: 'local-time', offsetMs: UTC_PLUS_5_30 },
    ]

    expect(devices.map((device) => [device.deviceId, device.clockWarnings])).toStrictEqual([
      ['dev-1', expectedDev1],
      ['dev-2', expectedDev1],
      ['dev-3', []],
    ])
    expect((await getDevice(pool(), 'dev-1', options))?.clockWarnings).toStrictEqual(expectedDev1)
    expect(
      (await listDevices(pool(), { ...options, status: 'unregistered' })).map(
        (device) => device.clockWarnings,
      ),
    ).toStrictEqual([expectedDev1, expectedDev1, []])
  })

  it('uses clockSkewThresholdMs for the ahead warning', async () => {
    await seed(series(5, { gateway: 'gw-6s', skewMs: 6_000 }))
    const options = { now: dateAt(BASE, 60_000), lateThresholdMs: THRESHOLD }

    expect((await getDevice(pool(), 'dev-1', options))?.clockWarnings).toStrictEqual([])
    expect(
      (await getDevice(pool(), 'dev-1', { ...options, clockSkewThresholdMs: 5_000 }))
        ?.clockWarnings,
    ).toStrictEqual([{ gatewayId: 'gw-6s', status: 'ahead', offsetMs: 6_000 }])
  })
})
