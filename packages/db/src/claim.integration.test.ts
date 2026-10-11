import {
  createTestDatabase,
  dateAt,
  isoAt,
  micros,
  readingMessage,
  storedCurrentState,
  storedDevices,
  storedReadings,
  type TestDatabase,
} from '@telemetry/test-harness'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Pool } from './pool'
import { processReading } from './processing'
import { claimDevice, listDevices } from './queries'

/*
 * CONTRACT: claimDevice(pool, deviceId, name, { now, lateThresholdMs }): Promise<ClaimResult>
 *
 *   - Unknown device              -> { outcome: 'not-found' }; no row is created.
 *   - Unregistered device         -> { outcome: 'claimed', device } where device is the DeviceSummary
 *                                    after the claim (status 'registered', name). claimed_at = now.
 *   - Already registered device   -> { outcome: 'already-registered', device } with the CURRENT
 *                                    summary; name and claimed_at are never overwritten.
 *   - Implemented as a single conditional UPDATE ... WHERE status = 'unregistered' (decision g), so
 *     K concurrent claims produce exactly one 'claimed' and K-1 'already-registered', all reporting
 *     the winner's name.
 *   - Claiming keeps the device's history and current_state.
 *   - `device` has the same shape and values as listDevices/getDevice return for it at `now`.
 */

const BASE = '2026-10-10T12:00:00.000Z'
const READ = { now: dateAt(BASE, 5_000), lateThresholdMs: 30_000 }

const ctx: { db?: TestDatabase } = {}

function pool(): Pool {
  return (ctx.db as TestDatabase).pool
}

async function seedDevice(deviceId: string) {
  await processReading(
    pool(),
    readingMessage({ device_id: deviceId, value: 42, receivedAt: isoAt(BASE, 100) }),
    { now: dateAt(BASE, 200), lateThresholdMs: 30_000 },
  )
}

beforeAll(async () => {
  ctx.db = await createTestDatabase({ poolSize: 12 })
})

afterAll(async () => {
  await ctx.db?.drop()
})

describe('claimDevice', () => {
  it('returns not-found for an unknown device and creates nothing', async () => {
    const result = await claimDevice(pool(), 'claim-unknown', 'Pump', READ)

    expect(result).toEqual({ outcome: 'not-found' })
    expect(await storedDevices(pool(), 'claim-unknown')).toEqual([])
  })

  it('registers an unregistered device and keeps its history and current state', async () => {
    await seedDevice('claim-first')
    const historyBefore = await storedReadings(pool(), 'claim-first')
    const stateBefore = await storedCurrentState(pool(), 'claim-first')

    const result = await claimDevice(pool(), 'claim-first', 'Chiller 1', READ)

    expect(result).toEqual({
      outcome: 'claimed',
      device: {
        deviceId: 'claim-first',
        status: 'registered',
        name: 'Chiller 1',
        firstSeenAt: isoAt(BASE, 100),
        firstSeenGatewayId: 'gw-a',
        gateways: ['gw-a'],
        possiblyBehind: false,
        metrics: {
          temperature: {
            value: 42,
            eventTime: BASE,
            gatewayId: 'gw-a',
            sequence: 0,
            updatedAt: isoAt(BASE, 200),
          },
        },
      },
    })
    expect(await storedDevices(pool(), 'claim-first')).toMatchObject([
      { status: 'registered', name: 'Chiller 1', claimed_at: micros(READ.now.toISOString()) },
    ])
    expect(await storedReadings(pool(), 'claim-first')).toEqual(historyBefore)
    expect(await storedCurrentState(pool(), 'claim-first')).toEqual(stateBefore)
  })

  it('is idempotent: a second claim reports already-registered and keeps the first name', async () => {
    await seedDevice('claim-twice')
    await claimDevice(pool(), 'claim-twice', 'First', READ)

    const second = await claimDevice(pool(), 'claim-twice', 'Second', {
      ...READ,
      now: dateAt(BASE, 9_000),
    })

    expect(second.outcome).toBe('already-registered')
    expect(second).toMatchObject({ device: { status: 'registered', name: 'First' } })
    expect(await storedDevices(pool(), 'claim-twice')).toMatchObject([
      { name: 'First', claimed_at: micros(READ.now.toISOString()) },
    ])
  })

  it('10 concurrent claims: exactly one claimed, the rest already-registered with the winner name', async () => {
    await seedDevice('claim-race')
    const names = Array.from({ length: 10 }, (_, i) => `Name ${i}`)

    const results = await Promise.all(
      names.map((name) => claimDevice(pool(), 'claim-race', name, READ)),
    )

    const claimed = results.filter((r) => r.outcome === 'claimed')
    expect(claimed).toHaveLength(1)
    expect(results.filter((r) => r.outcome === 'already-registered')).toHaveLength(9)
    const winner = claimed[0]?.outcome === 'claimed' ? claimed[0].device.name : null
    expect(names).toContain(winner)
    results.forEach((r) => {
      expect(r).toMatchObject({ device: { name: winner, status: 'registered' } })
    })
    expect(await storedDevices(pool(), 'claim-race')).toMatchObject([{ name: winner }])
  })

  it('moves the device from the unregistered list to the registered list', async () => {
    await seedDevice('claim-move')
    const inInbox = async () =>
      (await listDevices(pool(), { ...READ, status: 'unregistered' })).some(
        (d) => d.deviceId === 'claim-move',
      )
    const onBoard = async () =>
      (await listDevices(pool(), { ...READ, status: 'registered' })).some(
        (d) => d.deviceId === 'claim-move',
      )
    expect([await inInbox(), await onBoard()]).toEqual([true, false])

    await claimDevice(pool(), 'claim-move', 'AHU-2', READ)

    expect([await inInbox(), await onBoard()]).toEqual([false, true])
  })
})
