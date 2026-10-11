import { randomUUID } from 'node:crypto'
import type { StreamEvent } from '@telemetry/shared'
import {
  createTestDatabase,
  dateAt,
  isoAt,
  readingMessage,
  type ReadingOverrides,
  type TestDatabase,
} from '@telemetry/test-harness'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { TELEMETRY_EVENTS_CHANNEL } from './events'
import type { Pool, PoolClient } from './pool'
import { processReading } from './processing'
import { claimDevice } from './queries'

/*
 * CONTRACT: live-update notifications on TELEMETRY_EVENTS_CHANNEL ('telemetry_events').
 *
 * Payload: JSON.stringify(StreamEvent), i.e. {"event":"<name>","data":{...}}. Sent with pg_notify
 * INSIDE the writing transaction, so listeners only ever see committed changes.
 *
 * processReading, per message:
 *   - 'inserted' on a new device: device-discovered + device-updated (deviceId) + gateway-updated
 *   - 'inserted' on a known device (including out_of_order): device-updated + gateway-updated
 *   - 'duplicate' or 'conflict': gateway-updated only (last_seen_at moved; history did not)
 * claimDevice:
 *   - 'claimed': device-claimed
 *   - 'already-registered' / 'not-found': nothing
 *
 * The api's GET /api/stream relays these as SSE (see apps/api stream tests).
 */

const BASE = '2026-10-10T12:00:00.000Z'
const SENTINEL_PREFIX = '__sentinel__'

const ctx: { db?: TestDatabase; listener?: PoolClient; received: string[] } = { received: [] }

function pool(): Pool {
  return (ctx.db as TestDatabase).pool
}

/**
 * Sends a unique sentinel NOTIFY from a separate session and waits until the listener receives
 * it. Returns the sentinel so callers can find where it landed.
 */
async function flush(): Promise<string> {
  const sentinel = `${SENTINEL_PREFIX}${randomUUID()}`
  await pool().query('SELECT pg_notify($1, $2)', [TELEMETRY_EVENTS_CHANNEL, sentinel])
  const deadline = Date.now() + 5_000
  const waitForSentinel = async (): Promise<void> => {
    if (ctx.received.includes(sentinel)) {
      return
    }
    if (Date.now() > deadline) {
      throw new Error('sentinel notification never arrived')
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
    return waitForSentinel()
  }
  await waitForSentinel()
  return sentinel
}

/**
 * Collects exactly the notifications committed by `action`. Postgres delivers notifications in
 * commit order, so a sentinel before the action drains earlier ones (e.g. from test setup) and a
 * sentinel after it marks the end. Returned sorted for order-independent comparison.
 */
async function eventsFrom(action: () => Promise<unknown>): Promise<StreamEvent[]> {
  const start = await flush()
  await action()
  const end = await flush()
  return ctx.received
    .slice(ctx.received.indexOf(start) + 1, ctx.received.indexOf(end))
    .map((payload) => JSON.parse(payload) as StreamEvent)
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
}

function apply(overrides: ReadingOverrides) {
  return processReading(pool(), readingMessage(overrides), {
    now: dateAt(BASE, 1_000),
    lateThresholdMs: 30_000,
  })
}

beforeAll(async () => {
  ctx.db = await createTestDatabase({ poolSize: 4 })
  ctx.listener = await pool().connect()
  ctx.listener.on('notification', (notification) => {
    ctx.received.push(notification.payload ?? '')
  })
  await ctx.listener.query(`LISTEN ${TELEMETRY_EVENTS_CHANNEL}`)
})

afterAll(async () => {
  ctx.listener?.release()
  await ctx.db?.drop()
})

describe('NOTIFY telemetry_events', () => {
  it.fails('a new device emits device-discovered, device-updated and gateway-updated', async () => {
    const events = await eventsFrom(() => apply({ gateway_id: 'gw-n', device_id: 'n-new' }))

    expect(events).toEqual([
      { event: 'device-discovered', data: { deviceId: 'n-new' } },
      { event: 'device-updated', data: { deviceId: 'n-new' } },
      { event: 'gateway-updated', data: { gatewayId: 'gw-n' } },
    ])
  })

  it.fails(
    'a new reading for a known device, even out of order, emits device-updated and gateway-updated',
    async () => {
      await apply({ device_id: 'n-known', sequence: 0, event_time: isoAt(BASE, 5_000) })

      const events = await eventsFrom(() =>
        apply({ device_id: 'n-known', sequence: 1, event_time: isoAt(BASE, 1_000) }),
      )

      expect(events).toEqual([
        { event: 'device-updated', data: { deviceId: 'n-known' } },
        { event: 'gateway-updated', data: { gatewayId: 'gw-a' } },
      ])
    },
  )

  it.fails('a duplicate or a conflict emits gateway-updated only', async () => {
    await apply({ device_id: 'n-dup', value: 1 })

    const duplicate = await eventsFrom(() => apply({ device_id: 'n-dup', value: 1 }))
    const conflict = await eventsFrom(() => apply({ device_id: 'n-dup', value: 2 }))

    expect(duplicate).toEqual([{ event: 'gateway-updated', data: { gatewayId: 'gw-a' } }])
    expect(conflict).toEqual([{ event: 'gateway-updated', data: { gatewayId: 'gw-a' } }])
  })

  it.fails(
    'a successful claim emits device-claimed; a repeat claim and an unknown device emit nothing',
    async () => {
      await apply({ device_id: 'n-claim' })
      const options = { now: dateAt(BASE, 2_000), lateThresholdMs: 30_000 }

      const first = await eventsFrom(() => claimDevice(pool(), 'n-claim', 'Fan', options))
      const repeat = await eventsFrom(() => claimDevice(pool(), 'n-claim', 'Fan 2', options))
      const unknown = await eventsFrom(() => claimDevice(pool(), 'n-missing', 'Fan', options))

      expect(first).toEqual([{ event: 'device-claimed', data: { deviceId: 'n-claim' } }])
      expect(repeat).toEqual([])
      expect(unknown).toEqual([])
    },
  )
})
