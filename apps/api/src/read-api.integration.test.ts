import type { ReadingPublisher } from '@telemetry/broker'
import { processReading, type Pool } from '@telemetry/db'
import type { ApiError, DeviceSummary, GatewaySummary, Reading } from '@telemetry/shared'
import {
  createTestDatabase,
  dateAt,
  isoAt,
  readingMessage,
  type ReadingOverrides,
  type TestDatabase,
} from '@telemetry/test-harness'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildApp } from './app'

/*
 * CONTRACT: read API over HTTP (buildApp({ publisher, pool, now, lateThresholdMs })).
 * Bodies are exactly the @telemetry/shared types (see packages/db queries tests for semantics);
 * staleness uses the injected `now` and `lateThresholdMs` (default 30000).
 *
 *   GET  /api/devices[?status=registered|unregistered] -> 200 DeviceSummary[] ordered by deviceId
 *                                                        400 ApiError for any other status value
 *   GET  /api/devices/:deviceId/readings               -> 200 Reading[] ordered by event_time
 *                                                        404 { error: 'device not found' } for an unknown device
 *   POST /api/devices/:deviceId/claim  { name }        -> 200 DeviceSummary on the first claim
 *                                                        409 current DeviceSummary if already registered
 *                                                        404 { error: 'device not found' } for an unknown device
 *                                                        400 ApiError unless name is a non-blank string
 *   GET  /api/gateways                                 -> 200 GatewaySummary[] ordered by gatewayId
 */

const BASE = '2026-10-10T12:00:00.000Z'
const NOW = dateAt(BASE, 40_001)
const THRESHOLD = 30_000

const ctx: { db?: TestDatabase } = {}

function pool(): Pool {
  return (ctx.db as TestDatabase).pool
}

function fakePublisher(): ReadingPublisher {
  return { publish: async () => {}, isReady: () => true, close: async () => {} }
}

function app() {
  return buildApp({
    publisher: fakePublisher(),
    pool: pool(),
    now: () => NOW,
    lateThresholdMs: THRESHOLD,
  })
}

async function seed(messages: ReadingOverrides[]) {
  await messages.reduce(async (previous, overrides) => {
    await previous
    await processReading(pool(), readingMessage(overrides), {
      now: dateAt(BASE, 40_000),
      lateThresholdMs: THRESHOLD,
    })
  }, Promise.resolve())
}

/** gw-old was last seen at BASE (stale at NOW); gw-new at BASE+40s (fresh). */
async function seedTwoDevices() {
  await seed([
    {
      gateway_id: 'gw-old',
      device_id: 'ahu-1',
      metric: 'temperature',
      value: 18.5,
      sequence: 3,
      event_time: isoAt(BASE, -1_000),
      receivedAt: BASE,
    },
    {
      gateway_id: 'gw-new',
      device_id: 'ahu-1',
      metric: 'temperature',
      value: 19,
      sequence: 7,
      event_time: isoAt(BASE, -2_000),
      receivedAt: isoAt(BASE, 39_000),
    },
    {
      gateway_id: 'gw-new',
      device_id: 'pump-2',
      metric: 'power_draw',
      value: 3.2,
      sequence: 1,
      event_time: isoAt(BASE, 39_500),
      receivedAt: isoAt(BASE, 40_000),
    },
  ])
}

const AHU_1: DeviceSummary = {
  deviceId: 'ahu-1',
  status: 'unregistered',
  name: null,
  firstSeenAt: BASE,
  firstSeenGatewayId: 'gw-old',
  gateways: ['gw-new', 'gw-old'],
  possiblyBehind: true,
  metrics: {
    temperature: {
      value: 18.5,
      eventTime: isoAt(BASE, -1_000),
      gatewayId: 'gw-old',
      sequence: 3,
      updatedAt: isoAt(BASE, 40_000),
    },
  },
}

const PUMP_2: DeviceSummary = {
  deviceId: 'pump-2',
  status: 'unregistered',
  name: null,
  firstSeenAt: isoAt(BASE, 40_000),
  firstSeenGatewayId: 'gw-new',
  gateways: ['gw-new'],
  possiblyBehind: false,
  metrics: {
    power_draw: {
      value: 3.2,
      eventTime: isoAt(BASE, 39_500),
      gatewayId: 'gw-new',
      sequence: 1,
      updatedAt: isoAt(BASE, 40_000),
    },
  },
}

beforeEach(async () => {
  ctx.db = await createTestDatabase({ poolSize: 12 })
})

afterEach(async () => {
  await ctx.db?.drop()
})

describe('GET /api/devices', () => {
  it('returns DeviceSummary[] JSON exactly matching the shared type', async () => {
    await seedTwoDevices()

    const response = await app().inject({ method: 'GET', url: '/api/devices' })

    expect(response.statusCode).toBe(200)
    expect(response.headers['content-type']).toMatch(/^application\/json/)
    expect(response.json()).toStrictEqual([AHU_1, PUMP_2])
  })

  it('filters by status', async () => {
    await seedTwoDevices()
    await app().inject({
      method: 'POST',
      url: '/api/devices/pump-2/claim',
      payload: { name: 'Pump 2' },
    })

    const registered = await app().inject({ method: 'GET', url: '/api/devices?status=registered' })
    const unregistered = await app().inject({
      method: 'GET',
      url: '/api/devices?status=unregistered',
    })

    expect(registered.statusCode).toBe(200)
    expect(registered.json()).toStrictEqual([{ ...PUMP_2, status: 'registered', name: 'Pump 2' }])
    expect(unregistered.json()).toStrictEqual([AHU_1])
  })

  it('rejects an unknown status with 400', async () => {
    const response = await app().inject({ method: 'GET', url: '/api/devices?status=archived' })

    expect(response.statusCode).toBe(400)
    expect(response.json<ApiError>().error).toEqual(expect.any(String))
  })
})

describe('GET /api/devices/:deviceId/readings', () => {
  it('returns Reading[] JSON ordered by event_time with flags', async () => {
    await seedTwoDevices()

    const response = await app().inject({ method: 'GET', url: '/api/devices/ahu-1/readings' })

    const expected: Reading[] = [
      {
        gatewayId: 'gw-new',
        deviceId: 'ahu-1',
        sequence: 7,
        metric: 'temperature',
        value: 19,
        eventTime: isoAt(BASE, -2_000),
        receivedAt: isoAt(BASE, 39_000),
        processedAt: isoAt(BASE, 40_000),
        late: true,
        outOfOrder: true,
        future: false,
      },
      {
        gatewayId: 'gw-old',
        deviceId: 'ahu-1',
        sequence: 3,
        metric: 'temperature',
        value: 18.5,
        eventTime: isoAt(BASE, -1_000),
        receivedAt: BASE,
        processedAt: isoAt(BASE, 40_000),
        late: true,
        outOfOrder: false,
        future: false,
      },
    ]
    expect(response.statusCode).toBe(200)
    expect(response.json()).toStrictEqual(expected)
  })

  // Rule 4: future = event_time - processed_at > FUTURE_SKEW_MS (default 60000).
  it.fails('exposes the future flag on each Reading', async () => {
    await seed([
      { device_id: 'skewed', sequence: 0, event_time: isoAt(BASE, 100_001) },
      { device_id: 'skewed', sequence: 1, event_time: isoAt(BASE, 45_000) },
    ])

    const response = await app().inject({ method: 'GET', url: '/api/devices/skewed/readings' })

    expect(response.statusCode).toBe(200)
    expect(
      (response.json() as Reading[]).map((reading) => [reading.sequence, reading.future]),
    ).toEqual([
      [1, false],
      [0, true],
    ])
  })

  it('returns 404 for an unknown device', async () => {
    const response = await app().inject({ method: 'GET', url: '/api/devices/ghost/readings' })

    expect(response.statusCode).toBe(404)
    expect(response.json()).toStrictEqual({ error: 'device not found' })
  })
})

describe('POST /api/devices/:deviceId/claim', () => {
  it('returns 200 with the registered DeviceSummary, then 409 with the unchanged summary', async () => {
    await seedTwoDevices()

    const first = await app().inject({
      method: 'POST',
      url: '/api/devices/ahu-1/claim',
      payload: { name: 'AHU 1' },
    })
    const second = await app().inject({
      method: 'POST',
      url: '/api/devices/ahu-1/claim',
      payload: { name: 'Other' },
    })

    const claimed: DeviceSummary = { ...AHU_1, status: 'registered', name: 'AHU 1' }
    expect(first.statusCode).toBe(200)
    expect(first.json()).toStrictEqual(claimed)
    expect(second.statusCode).toBe(409)
    expect(second.json()).toStrictEqual(claimed)
  })

  it('8 concurrent claims: exactly one 200, seven 409, all reporting the same name', async () => {
    await seedTwoDevices()
    const server = app()

    const responses = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        server.inject({
          method: 'POST',
          url: '/api/devices/pump-2/claim',
          payload: { name: `Pump ${i}` },
        }),
      ),
    )

    expect(responses.map((r) => r.statusCode).sort()).toEqual([
      200, 409, 409, 409, 409, 409, 409, 409,
    ])
    const names = new Set(responses.map((r) => r.json<DeviceSummary>().name))
    expect(names.size).toBe(1)
  })

  it('returns 404 for an unknown device', async () => {
    const response = await app().inject({
      method: 'POST',
      url: '/api/devices/ghost/claim',
      payload: { name: 'X' },
    })

    expect(response.statusCode).toBe(404)
    expect(response.json()).toStrictEqual({ error: 'device not found' })
  })

  it('returns 400 unless name is a non-blank string, and does not register the device', async () => {
    await seedTwoDevices()
    const server = app()

    const responses = await Promise.all(
      [{}, { name: '' }, { name: '   ' }, { name: 42 }].map((payload) =>
        server.inject({ method: 'POST', url: '/api/devices/ahu-1/claim', payload }),
      ),
    )

    expect(responses.map((r) => r.statusCode)).toEqual([400, 400, 400, 400])
    const devices = await server.inject({
      method: 'GET',
      url: '/api/devices?status=unregistered',
    })
    expect(devices.json<DeviceSummary[]>().map((d) => d.deviceId)).toContain('ahu-1')
  })
})

describe('GET /api/gateways', () => {
  it('returns GatewaySummary[] with staleness relative to the injected clock', async () => {
    await seedTwoDevices()

    const response = await app().inject({ method: 'GET', url: '/api/gateways' })

    const expected: GatewaySummary[] = [
      { gatewayId: 'gw-new', lastSeenAt: isoAt(BASE, 40_000), stale: false },
      { gatewayId: 'gw-old', lastSeenAt: BASE, stale: true },
    ]
    expect(response.statusCode).toBe(200)
    expect(response.json()).toStrictEqual(expected)
  })
})
