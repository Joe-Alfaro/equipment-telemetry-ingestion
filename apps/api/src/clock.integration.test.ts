import { createReadingPublisher, type ReadingPublisher } from '@telemetry/broker'
import { processReading, type Pool } from '@telemetry/db'
import type { ClockWarning, GatewayClock, ReadingMessage } from '@telemetry/shared'
import {
  createTestBroker,
  createTestDatabase,
  getOneMessage,
  isoAt,
  type TestBroker,
  type TestDatabase,
} from '@telemetry/test-harness'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildApp } from './app'

/*
 * CONTRACT (gateway clock check rules 2 and 5), end to end against real RabbitMQ and Postgres:
 *   POST /ingest/readings -> broker envelope { reading, receivedAt, naiveTime } -> processReading
 *   -> readings.naive_time -> GET /api/gateways `clock` and GET /api/devices `clockWarnings`.
 * The api's clock is injected (`now`), so receivedAt, and with it every skew, is exact.
 *
 *   GET /api/gateways -> each GatewaySummary has clock: { status, offsetMs, samples }
 *   GET /api/devices  -> each DeviceSummary has clockWarnings: { gatewayId, status, offsetMs }[]
 *   buildApp({ clockSkewThresholdMs }) sets the `ahead` threshold (default 60000).
 */

const BASE = '2026-10-10T12:00:00.000Z'
const UTC_PLUS_5_30 = 19_800_000

const ctx: { db?: TestDatabase; broker?: TestBroker; publisher?: ReadingPublisher } = {}

function pool(): Pool {
  return (ctx.db as TestDatabase).pool
}

/** An api whose clock reads `clock.now`; tests move it instead of sleeping. */
function app(clock: { now: Date }, options: { clockSkewThresholdMs?: number } = {}) {
  return buildApp({
    publisher: ctx.publisher as ReadingPublisher,
    pool: pool(),
    now: () => clock.now,
    lateThresholdMs: 30_000,
    ...options,
  })
}

/** POSTs each body at BASE + i s, then drains the queue through processReading in order. */
async function ingest(
  bodies: Record<string, unknown>[],
  options: { clockSkewThresholdMs?: number } = {},
) {
  const broker = ctx.broker as TestBroker
  const clock = { now: new Date(BASE) }
  const api = app(clock, options)

  const messages = await bodies.reduce<Promise<ReadingMessage[]>>(async (previous, body, i) => {
    const done = await previous
    clock.now = new Date(isoAt(BASE, i * 1_000))
    const response = await api.inject({ method: 'POST', url: '/ingest/readings', payload: body })
    expect(response.statusCode).toBe(202)
    const delivered = await getOneMessage(broker.connection, broker.queue)
    const message = JSON.parse(delivered?.content.toString('utf8') ?? 'null') as ReadingMessage
    await processReading(pool(), message, {
      now: new Date(Date.parse(message.receivedAt) + 5),
      lateThresholdMs: 30_000,
    })
    return [...done, message]
  }, Promise.resolve([]))

  clock.now = new Date(isoAt(BASE, 60_000))
  return { api, messages }
}

function body(gateway: string, deviceId: string, sequence: number, eventTime: string) {
  return {
    gateway_id: gateway,
    device_id: deviceId,
    metric: 'temperature',
    value: 20 + sequence,
    event_time: eventTime,
    sequence,
  }
}

/** event_time `seconds` after 17:30:00, i.e. UTC+5:30 local time when received at BASE + seconds. */
function istLocal(seconds: number): string {
  return `2026-10-10T17:30:${String(seconds).padStart(2, '0')}`
}

beforeEach(async () => {
  ctx.db = await createTestDatabase({ poolSize: 4 })
  ctx.broker = await createTestBroker()
  ctx.publisher = await createReadingPublisher(ctx.broker.connection, ctx.broker.queue)
})

afterEach(async () => {
  await ctx.publisher?.close()
  await ctx.broker?.close()
  await ctx.db?.drop()
})

describe('naive marker: api -> broker -> database (rule 2)', () => {
  it('marks the envelope and the stored reading naive only when event_time had no offset', async () => {
    const { messages } = await ingest([
      body('gw-ist', 'dev-1', 0, istLocal(0)),
      body('gw-ist', 'dev-1', 1, '2026-10-10T17:30:01+05:30'),
      body('gw-ist', 'dev-1', 2, '2026-10-10T12:00:02Z'),
    ])

    expect(messages.map((message) => message.naiveTime)).toEqual([true, false, false])
    expect(messages.map((message) => message.receivedAt)).toEqual([
      BASE,
      isoAt(BASE, 1_000),
      isoAt(BASE, 2_000),
    ])
    const { rows } = await pool().query<{ sequence: number; naive_time: boolean }>(
      `SELECT sequence::int AS sequence, naive_time FROM readings ORDER BY sequence`,
    )
    expect(rows).toEqual([
      { sequence: 0, naive_time: true },
      { sequence: 1, naive_time: false },
      { sequence: 2, naive_time: false },
    ])
  })
})

describe('GET /api/gateways and GET /api/devices: clock fields (rule 5)', () => {
  it('reports a UTC+5:30 gateway sending naive local time as local-time, and warns its devices', async () => {
    const { api } = await ingest([
      ...[0, 1, 2, 3, 4].map((i) => body('gw-ist', i < 3 ? 'dev-1' : 'dev-2', i, istLocal(i))),
      ...[5, 6, 7, 8, 9].map((i) => body('gw-utc', 'dev-3', i, `2026-10-10T12:00:0${i}.250+00:00`)),
    ])

    const gateways = await api.inject({ method: 'GET', url: '/api/gateways' })
    expect(gateways.statusCode).toBe(200)
    const clocks: [string, GatewayClock][] = [
      ['gw-ist', { status: 'local-time', offsetMs: UTC_PLUS_5_30, samples: 5 }],
      ['gw-utc', { status: 'ok', offsetMs: null, samples: 5 }],
    ]
    expect(
      gateways
        .json<{ gatewayId: string; clock: GatewayClock }[]>()
        .map((gateway) => [gateway.gatewayId, gateway.clock]),
    ).toStrictEqual(clocks)

    const devices = await api.inject({ method: 'GET', url: '/api/devices' })
    expect(devices.statusCode).toBe(200)
    const warning: ClockWarning = {
      gatewayId: 'gw-ist',
      status: 'local-time',
      offsetMs: UTC_PLUS_5_30,
    }
    expect(
      devices
        .json<{ deviceId: string; clockWarnings: ClockWarning[] }[]>()
        .map((device) => [device.deviceId, device.clockWarnings]),
    ).toStrictEqual([
      ['dev-1', [warning]],
      ['dev-2', [warning]],
      ['dev-3', []],
    ])
  })

  it('reports a gateway whose clock runs 90 s fast as ahead, using clockSkewThresholdMs', async () => {
    const fast = [0, 1, 2, 3, 4].map((i) =>
      body('gw-fast', 'dev-1', i, isoAt(BASE, i * 1_000 + 90_000)),
    )

    const { api } = await ingest(fast)
    const relaxedApi = app(
      { now: new Date(isoAt(BASE, 60_000)) },
      { clockSkewThresholdMs: 120_000 },
    )

    const ahead = await api.inject({ method: 'GET', url: '/api/gateways' })
    expect(ahead.json()).toMatchObject([
      { gatewayId: 'gw-fast', clock: { status: 'ahead', offsetMs: 90_000, samples: 5 } },
    ])
    const devices = await api.inject({ method: 'GET', url: '/api/devices?status=unregistered' })
    expect(devices.json()).toMatchObject([
      {
        deviceId: 'dev-1',
        clockWarnings: [{ gatewayId: 'gw-fast', status: 'ahead', offsetMs: 90_000 }],
      },
    ])

    const relaxed = await relaxedApi.inject({ method: 'GET', url: '/api/gateways' })
    expect(relaxed.json()).toMatchObject([
      { gatewayId: 'gw-fast', clock: { status: 'ok', offsetMs: null, samples: 5 } },
    ])
  })
})
