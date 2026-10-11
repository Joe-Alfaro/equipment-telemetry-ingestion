import {
  createTestDatabase,
  dateAt,
  isoAt,
  micros,
  readingMessage,
  storedCurrentState,
  type ReadingOverrides,
  type TestDatabase,
} from '@telemetry/test-harness'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Pool } from './pool'
import { processReading, type ProcessOptions } from './processing'

/*
 * CONTRACT (rule 4): readings.future = event_time - processed_at > futureSkewMs (strictly),
 * where processed_at = options.now and futureSkewMs defaults to 60000.
 *   - Flag only: a future reading is stored and applied to current_state like any other.
 *   - The trace's +5 s offsets are never flagged.
 */

const BASE = '2026-10-10T12:00:00.000Z'
const NOW = dateAt(BASE, 0)

const ctx: { db?: TestDatabase } = {}

function pool(): Pool {
  return (ctx.db as TestDatabase).pool
}

async function apply(overrides: ReadingOverrides, options: Partial<ProcessOptions> = {}) {
  return processReading(pool(), readingMessage(overrides), {
    now: NOW,
    lateThresholdMs: 30_000,
    ...options,
  })
}

/** [sequence, future] for every stored reading of the device, by sequence. */
async function futureFlags(deviceId: string): Promise<[number, boolean][]> {
  const { rows } = await pool().query<{ sequence: number; future: boolean }>(
    `SELECT sequence::int AS sequence, future FROM readings
      WHERE device_id = $1 ORDER BY sequence`,
    [deviceId],
  )
  return rows.map((row) => [row.sequence, row.future])
}

beforeAll(async () => {
  ctx.db = await createTestDatabase({ poolSize: 4 })
})

afterAll(async () => {
  await ctx.db?.drop()
})

describe('processReading: future flag (event_time - processed_at > futureSkewMs) (rule 4)', () => {
  it('defaults to 60 s: set 1 ms past it, not at exactly 60 s, not at +5 s, not in the past', async () => {
    await apply({ device_id: 'future-default', sequence: 0, event_time: isoAt(BASE, 60_001) })
    await apply({ device_id: 'future-default', sequence: 1, event_time: isoAt(BASE, 60_000) })
    await apply({ device_id: 'future-default', sequence: 2, event_time: isoAt(BASE, 5_000) })
    await apply({ device_id: 'future-default', sequence: 3, event_time: isoAt(BASE, -1_000) })

    expect(await futureFlags('future-default')).toEqual([
      [0, true],
      [1, false],
      [2, false],
      [3, false],
    ])
  })

  it('honours the configured futureSkewMs', async () => {
    await apply(
      { device_id: 'future-config', sequence: 0, event_time: isoAt(BASE, 1_001) },
      { futureSkewMs: 1_000 },
    )
    await apply(
      { device_id: 'future-config', sequence: 1, event_time: isoAt(BASE, 1_000) },
      { futureSkewMs: 1_000 },
    )

    expect(await futureFlags('future-config')).toEqual([
      [0, true],
      [1, false],
    ])
  })

  it('is a flag only: the future reading is stored, becomes current, and is not late', async () => {
    const future = isoAt(BASE, 365 * 24 * 3_600_000)

    const outcome = await apply({ device_id: 'future-current', value: 99, event_time: future })
    await apply({ device_id: 'future-current', sequence: 1, value: 20, event_time: BASE })

    expect(outcome).toMatchObject({ status: 'inserted', late: false, currentStateUpdated: true })
    expect(await futureFlags('future-current')).toEqual([
      [0, true],
      [1, false],
    ])
    expect(
      (await storedCurrentState(pool(), 'future-current')).map((s) => [s.value, s.event_time]),
    ).toEqual([[99, micros(future)]])
  })
})
