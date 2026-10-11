import type { DeviceSummary, GatewaySummary, Reading } from '@telemetry/shared'
import {
  createTestDatabase,
  dateAt,
  isoAt,
  readingMessage,
  type ReadingOverrides,
  type TestDatabase,
} from '@telemetry/test-harness'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Pool } from './pool'
import { processReading } from './processing'
import { getDevice, listDevices, listGateways, listReadings } from './queries'

/*
 * CONTRACT: read queries returning the @telemetry/shared read-API types verbatim (the api
 * serializes them as-is).
 *
 * Serialization:
 *   - Every timestamp is `Date#toISOString()` (UTC, millisecond precision, `Z`).
 *   - `value` and `sequence` are JS numbers (bigint sequence must not leak out as a string).
 *   - `name` is null until claimed.
 *
 * listDevices(pool, { status?, now, lateThresholdMs }): DeviceSummary[] ordered by deviceId.
 *   - firstSeenAt / firstSeenGatewayId from devices.
 *   - gateways: distinct gateway_ids that have a stored reading for the device, ascending.
 *   - metrics: one entry per current_state row, keyed by metric.
 *   - possiblyBehind: true when ANY of `gateways` is stale.
 * getDevice(pool, deviceId, options): the same DeviceSummary, or null when unknown.
 * listReadings(pool, deviceId): Reading[] ordered by (event_time, gateway_id, sequence), or null when
 *   the device is unknown.
 * listGateways(pool, { now, lateThresholdMs }): GatewaySummary[] ordered by gatewayId, where
 *   stale = now - last_seen_at > lateThresholdMs (strictly greater).
 */

const BASE = '2026-10-10T12:00:00.000Z'
const THRESHOLD = 30_000

const ctx: { db?: TestDatabase } = {}

function pool(): Pool {
  return (ctx.db as TestDatabase).pool
}

async function seed(messages: ReadingOverrides[], processedAt = dateAt(BASE, 1_000)) {
  await messages.reduce(async (previous, overrides) => {
    await previous
    await processReading(pool(), readingMessage(overrides), {
      now: processedAt,
      lateThresholdMs: THRESHOLD,
    })
  }, Promise.resolve())
}

beforeEach(async () => {
  ctx.db = await createTestDatabase({ poolSize: 4 })
})

afterEach(async () => {
  await ctx.db?.drop()
})

describe('listGateways: staleness', () => {
  it.fails(
    'is fresh at exactly the threshold and stale 1 ms past it, ordered by gatewayId',
    async () => {
      await seed([
        { gateway_id: 'gw-b', device_id: 'd', receivedAt: isoAt(BASE, 0) },
        { gateway_id: 'gw-a', device_id: 'd', receivedAt: isoAt(BASE, 1) },
      ])

      const gateways = await listGateways(pool(), {
        now: dateAt(BASE, THRESHOLD + 1),
        lateThresholdMs: THRESHOLD,
      })

      const expected: GatewaySummary[] = [
        {
          gatewayId: 'gw-a',
          lastSeenAt: isoAt(BASE, 1),
          stale: false,
          clock: { status: 'unknown', offsetMs: null, samples: 1 },
        },
        {
          gatewayId: 'gw-b',
          lastSeenAt: isoAt(BASE, 0),
          stale: true,
          clock: { status: 'unknown', offsetMs: null, samples: 1 },
        },
      ]
      expect(gateways).toStrictEqual(expected)
    },
  )
})

describe('listDevices / getDevice', () => {
  it.fails('returns DeviceSummary objects with exactly the shared contract fields', async () => {
    await seed([
      {
        gateway_id: 'gw-b',
        device_id: 'dev-1',
        metric: 'temperature',
        value: 70.5,
        sequence: 4,
        event_time: isoAt(BASE, 200),
        receivedAt: isoAt(BASE, 10),
      },
      {
        gateway_id: 'gw-a',
        device_id: 'dev-1',
        metric: 'vibration',
        value: 0.25,
        sequence: 9,
        event_time: isoAt(BASE, 300),
        receivedAt: isoAt(BASE, 20),
      },
      {
        gateway_id: 'gw-a',
        device_id: 'dev-1',
        metric: 'temperature',
        value: 69,
        sequence: 10,
        event_time: isoAt(BASE, 100),
        receivedAt: isoAt(BASE, 30),
      },
      {
        gateway_id: 'gw-a',
        device_id: 'dev-0',
        metric: 'status',
        value: 1,
        sequence: 0,
        event_time: isoAt(BASE, 50),
        receivedAt: isoAt(BASE, 40),
      },
    ])

    const devices = await listDevices(pool(), {
      now: dateAt(BASE, 1_000),
      lateThresholdMs: THRESHOLD,
    })

    const expected: DeviceSummary[] = [
      {
        deviceId: 'dev-0',
        status: 'unregistered',
        name: null,
        firstSeenAt: isoAt(BASE, 40),
        firstSeenGatewayId: 'gw-a',
        gateways: ['gw-a'],
        possiblyBehind: false,
        metrics: {
          status: {
            value: 1,
            eventTime: isoAt(BASE, 50),
            gatewayId: 'gw-a',
            sequence: 0,
            updatedAt: isoAt(BASE, 1_000),
          },
        },
        clockWarnings: [],
      },
      {
        deviceId: 'dev-1',
        status: 'unregistered',
        name: null,
        firstSeenAt: isoAt(BASE, 10),
        firstSeenGatewayId: 'gw-b',
        gateways: ['gw-a', 'gw-b'],
        possiblyBehind: false,
        metrics: {
          temperature: {
            value: 70.5,
            eventTime: isoAt(BASE, 200),
            gatewayId: 'gw-b',
            sequence: 4,
            updatedAt: isoAt(BASE, 1_000),
          },
          vibration: {
            value: 0.25,
            eventTime: isoAt(BASE, 300),
            gatewayId: 'gw-a',
            sequence: 9,
            updatedAt: isoAt(BASE, 1_000),
          },
        },
        clockWarnings: [],
      },
    ]
    expect(devices).toStrictEqual(expected)
    expect(
      await getDevice(pool(), 'dev-1', { now: dateAt(BASE, 1_000), lateThresholdMs: THRESHOLD }),
    ).toStrictEqual(expected[1])
  })

  it('filters by status', async () => {
    await seed([{ device_id: 'inbox' }, { device_id: 'board' }])
    await pool().query(
      `UPDATE devices SET status = 'registered', name = 'Boiler', claimed_at = now() WHERE device_id = 'board'`,
    )
    const options = { now: dateAt(BASE, 1_000), lateThresholdMs: THRESHOLD }

    const ids = async (status?: 'registered' | 'unregistered') =>
      (await listDevices(pool(), { ...options, status })).map((d) => [d.deviceId, d.status, d.name])

    expect(await ids('registered')).toEqual([['board', 'registered', 'Boiler']])
    expect(await ids('unregistered')).toEqual([['inbox', 'unregistered', null]])
    expect(await ids()).toEqual([
      ['board', 'registered', 'Boiler'],
      ['inbox', 'unregistered', null],
    ])
  })

  it('possiblyBehind is true when any reporting gateway is stale', async () => {
    await seed([
      { gateway_id: 'gw-fresh', device_id: 'mixed', receivedAt: isoAt(BASE, 40_000) },
      { gateway_id: 'gw-old', device_id: 'mixed', sequence: 1, receivedAt: isoAt(BASE, 0) },
      { gateway_id: 'gw-fresh', device_id: 'fresh-only', receivedAt: isoAt(BASE, 40_000) },
    ])

    const devices = await listDevices(pool(), {
      now: dateAt(BASE, 40_001),
      lateThresholdMs: THRESHOLD,
    })

    expect(devices.map((d) => [d.deviceId, d.possiblyBehind])).toEqual([
      ['fresh-only', false],
      ['mixed', true],
    ])
  })

  it('getDevice returns null for an unknown device', async () => {
    expect(
      await getDevice(pool(), 'nope', { now: dateAt(BASE, 0), lateThresholdMs: THRESHOLD }),
    ).toBeNull()
  })
})

describe('listReadings', () => {
  it('returns the full history ordered by event_time with late and outOfOrder flags', async () => {
    await processReading(
      pool(),
      readingMessage({
        gateway_id: 'gw-a',
        device_id: 'hist',
        sequence: 2,
        value: 3,
        event_time: isoAt(BASE, 5_000),
        receivedAt: isoAt(BASE, 5_100),
      }),
      { now: dateAt(BASE, 5_200), lateThresholdMs: THRESHOLD },
    )
    await processReading(
      pool(),
      readingMessage({
        gateway_id: 'gw-b',
        device_id: 'hist',
        sequence: 1,
        value: 1,
        event_time: isoAt(BASE, -40_000),
        receivedAt: isoAt(BASE, 6_000),
      }),
      { now: dateAt(BASE, 6_100), lateThresholdMs: THRESHOLD },
    )
    await processReading(
      pool(),
      readingMessage({
        gateway_id: 'gw-a',
        device_id: 'hist',
        sequence: 7,
        metric: 'vibration',
        value: 0.5,
        event_time: '2026-10-10T14:00:01.000+02:00',
        receivedAt: isoAt(BASE, 7_000),
      }),
      { now: dateAt(BASE, 7_100), lateThresholdMs: THRESHOLD },
    )

    const readings = await listReadings(pool(), 'hist')

    const expected: Reading[] = [
      {
        gatewayId: 'gw-b',
        deviceId: 'hist',
        sequence: 1,
        metric: 'temperature',
        value: 1,
        eventTime: isoAt(BASE, -40_000),
        receivedAt: isoAt(BASE, 6_000),
        processedAt: isoAt(BASE, 6_100),
        late: true,
        outOfOrder: true,
        future: false,
      },
      {
        gatewayId: 'gw-a',
        deviceId: 'hist',
        sequence: 7,
        metric: 'vibration',
        value: 0.5,
        eventTime: isoAt(BASE, 1_000),
        receivedAt: isoAt(BASE, 7_000),
        processedAt: isoAt(BASE, 7_100),
        late: false,
        outOfOrder: false,
        future: false,
      },
      {
        gatewayId: 'gw-a',
        deviceId: 'hist',
        sequence: 2,
        metric: 'temperature',
        value: 3,
        eventTime: isoAt(BASE, 5_000),
        receivedAt: isoAt(BASE, 5_100),
        processedAt: isoAt(BASE, 5_200),
        late: false,
        outOfOrder: false,
        future: false,
      },
    ]
    expect(readings).toStrictEqual(expected)
  })

  it('breaks equal event_time by gateway_id then sequence', async () => {
    await seed([
      { gateway_id: 'gw-b', device_id: 'hist-tie', sequence: 0 },
      { gateway_id: 'gw-a', device_id: 'hist-tie', sequence: 10 },
      { gateway_id: 'gw-a', device_id: 'hist-tie', sequence: 9 },
    ])

    expect((await listReadings(pool(), 'hist-tie'))?.map((r) => [r.gatewayId, r.sequence])).toEqual(
      [
        ['gw-a', 9],
        ['gw-a', 10],
        ['gw-b', 0],
      ],
    )
  })

  it('returns null for an unknown device', async () => {
    expect(await listReadings(pool(), 'nope')).toBeNull()
  })
})
