import { copyFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  createTestDatabase,
  dateAt,
  readingMessage,
  storedCurrentState,
  storedReadings,
  TEST_DATABASE_URL,
  type ReadingOverrides,
  type TestDatabase,
} from '@telemetry/test-harness'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { migrate, MIGRATIONS_DIR } from './migrate'
import { createPool, type Pool } from './pool'
import { processReading, type ProcessOutcome } from './processing'

/*
 * CONTRACT (rule 1): a reading's identity is (gateway_id, device_id, metric, sequence, event_time),
 * added by migration 003.
 *   - Several metrics sharing one gateway, device, sequence and event_time are separate readings:
 *     each is 'inserted' and each gets its own current_state row.
 *   - Same 5-part key, same value  -> 'duplicate' (a real resend).
 *   - Same 5-part key, other value -> 'conflict': the first copy is kept, the rejected one is
 *     recorded in reading_conflicts.
 *   - Migration 003 keeps every existing row in readings, current_state, devices, gateways and
 *     reading_conflicts unchanged.
 */

const BASE = '2026-10-10T12:00:00.000Z'
const NOW = dateAt(BASE, 1_000)
const OPTIONS = { now: NOW, lateThresholdMs: 30_000 }

const ctx: { db?: TestDatabase } = {}

function pool(): Pool {
  return (ctx.db as TestDatabase).pool
}

async function processInOrder(overrides: ReadingOverrides[]): Promise<ProcessOutcome[]> {
  return overrides.reduce<Promise<ProcessOutcome[]>>(
    async (previous, override) => [
      ...(await previous),
      await processReading(pool(), readingMessage(override), OPTIONS),
    ],
    Promise.resolve([]),
  )
}

async function conflictCount(deviceId: string): Promise<number> {
  const { rows } = await pool().query<{ n: number }>(
    'SELECT count(*)::int AS n FROM reading_conflicts WHERE device_id = $1',
    [deviceId],
  )
  return rows[0]?.n ?? -1
}

/** One gateway sample: three metrics sharing gateway, device, sequence and event_time. */
function sample(deviceId: string): ReadingOverrides[] {
  return [
    { device_id: deviceId, sequence: 7, metric: 'temperature', value: 21 },
    { device_id: deviceId, sequence: 7, metric: 'power_draw', value: 3.5 },
    { device_id: deviceId, sequence: 7, metric: 'vibration', value: 0.25 },
  ]
}

beforeAll(async () => {
  ctx.db = await createTestDatabase({ poolSize: 4 })
})

afterAll(async () => {
  await ctx.db?.drop()
})

describe('processReading: identity is (gateway_id, device_id, metric, sequence, event_time) (rule 1)', () => {
  it.fails(
    '3 metrics with the same gateway, device, sequence and event_time are 3 readings and 3 current_state rows',
    async () => {
      const outcomes = await processInOrder(sample('multi-metric'))

      expect(outcomes.map((o) => o.status)).toEqual(['inserted', 'inserted', 'inserted'])
      expect(
        (await storedReadings(pool(), 'multi-metric')).map((r) => [r.metric, r.value]).sort(),
      ).toEqual([
        ['power_draw', 3.5],
        ['temperature', 21],
        ['vibration', 0.25],
      ])
      expect(
        (await storedCurrentState(pool(), 'multi-metric')).map((s) => [
          s.metric,
          s.value,
          s.sequence,
        ]),
      ).toEqual([
        ['power_draw', 3.5, 7],
        ['temperature', 21, 7],
        ['vibration', 0.25, 7],
      ])
      expect(await conflictCount('multi-metric')).toBe(0)
    },
  )

  it.fails(
    'the same 5-part key with a different value is a conflict and keeps the first copy',
    async () => {
      const [temperature, powerDraw] = sample('multi-conflict')
      const changed = { ...powerDraw, value: 99 }

      const outcomes = await processInOrder([temperature, powerDraw, changed] as ReadingOverrides[])

      expect(outcomes.map((o) => o.status)).toEqual(['inserted', 'inserted', 'conflict'])
      expect(
        (await storedReadings(pool(), 'multi-conflict')).map((r) => [r.metric, r.value]).sort(),
      ).toEqual([
        ['power_draw', 3.5],
        ['temperature', 21],
      ])
      const { rows } = await pool().query<{ payload: unknown }>(
        'SELECT payload FROM reading_conflicts WHERE device_id = $1',
        ['multi-conflict'],
      )
      expect(rows.map((row) => row.payload)).toEqual([readingMessage(changed).reading])
    },
  )

  it.fails('a byte-identical resend of any metric in the sample is a duplicate', async () => {
    const readings = sample('multi-resend')

    const outcomes = await processInOrder([...readings, ...readings])

    expect(outcomes.map((o) => o.status)).toEqual([
      'inserted',
      'inserted',
      'inserted',
      'duplicate',
      'duplicate',
      'duplicate',
    ])
    expect(await storedReadings(pool(), 'multi-resend')).toHaveLength(3)
    expect(await conflictCount('multi-resend')).toBe(0)
  })
})

describe('migration 003: identity gains metric (rule 1)', () => {
  const migration: { pool?: Pool; name?: string; legacyDir?: string } = {}

  function legacyPool(): Pool {
    return migration.pool as Pool
  }

  /** Every row of a table as JSON, in a stable order, for before/after comparison. */
  async function snapshot(table: string, orderBy: string): Promise<unknown[]> {
    const { rows } = await legacyPool().query<{ row: unknown }>(
      `SELECT to_jsonb(t) AS row FROM ${table} t ORDER BY ${orderBy}`,
    )
    return rows.map((r) => r.row)
  }

  interface Snapshot {
    devices: unknown[]
    gateways: unknown[]
    readings: unknown[]
    current_state: unknown[]
    reading_conflicts: unknown[]
  }

  async function snapshotAll(): Promise<Snapshot> {
    return {
      devices: await snapshot('devices', 'device_id'),
      gateways: await snapshot('gateways', 'gateway_id'),
      readings: await snapshot('readings', 'id'),
      current_state: await snapshot('current_state', 'device_id, metric'),
      reading_conflicts: await snapshot('reading_conflicts', 'id'),
    }
  }

  beforeAll(async () => {
    // A database migrated only to 002, i.e. a volume created before migration 003 existed.
    migration.name = `it_${randomUUID().replaceAll('-', '')}`
    const admin = createPool(TEST_DATABASE_URL, 1)
    try {
      await admin.query(`CREATE DATABASE ${migration.name}`)
    } finally {
      await admin.end()
    }
    const url = new URL(TEST_DATABASE_URL)
    url.pathname = `/${migration.name}`
    migration.pool = createPool(url.toString(), 2)

    migration.legacyDir = await mkdtemp(join(tmpdir(), 'migrations-002-'))
    await Promise.all(
      ['001_init.sql', '002_reading_identity_event_time.sql'].map((file) =>
        copyFile(join(MIGRATIONS_DIR, file), join(migration.legacyDir as string, file)),
      ),
    )
    await migrate(legacyPool(), migration.legacyDir)

    await legacyPool().query(`
      INSERT INTO gateways (gateway_id, first_seen_at, last_seen_at)
        VALUES ('gw-a', '2026-10-10T11:00:00Z', '2026-10-10T12:00:00Z');
      INSERT INTO devices (device_id, status, name, first_seen_at, first_seen_gateway_id, claimed_at)
        VALUES ('legacy-1', 'registered', 'AHU 1', '2026-10-10T11:00:00Z', 'gw-a', '2026-10-10T11:30:00Z'),
               ('legacy-2', 'unregistered', NULL, '2026-10-10T11:10:00Z', 'gw-a', NULL);
      INSERT INTO readings (gateway_id, device_id, sequence, metric, value, event_time,
                            received_at, processed_at, late, out_of_order)
        VALUES ('gw-a', 'legacy-1', 1, 'temperature', 20.5, '2026-10-10T11:00:00.123456Z',
                '2026-10-10T11:00:01Z', '2026-10-10T11:00:02Z', false, false),
               ('gw-a', 'legacy-1', 2, 'temperature', 19.5, '2026-10-10T10:59:00Z',
                '2026-10-10T11:00:03Z', '2026-10-10T11:00:04Z', true, true),
               ('gw-a', 'legacy-2', 1, 'power_draw', 3.25, '2026-10-10T11:10:00Z',
                '2026-10-10T11:10:01Z', '2026-10-10T11:10:02Z', false, false);
      INSERT INTO current_state (device_id, metric, value, event_time, gateway_id, sequence, updated_at)
        VALUES ('legacy-1', 'temperature', 20.5, '2026-10-10T11:00:00.123456Z', 'gw-a', 1,
                '2026-10-10T11:00:02Z'),
               ('legacy-2', 'power_draw', 3.25, '2026-10-10T11:10:00Z', 'gw-a', 1,
                '2026-10-10T11:10:02Z');
      INSERT INTO reading_conflicts (gateway_id, device_id, sequence, payload, received_at)
        VALUES ('gw-a', 'legacy-2', 1, '{"metric":"vibration","value":0.5}', '2026-10-10T11:10:05Z');
    `)
  })

  afterAll(async () => {
    await migration.pool?.end()
    if (migration.legacyDir) {
      await rm(migration.legacyDir, { recursive: true, force: true })
    }
    if (migration.name) {
      const cleanup = createPool(TEST_DATABASE_URL, 1)
      try {
        await cleanup.query(`DROP DATABASE IF EXISTS ${migration.name} WITH (FORCE)`)
      } finally {
        await cleanup.end()
      }
    }
  })

  it.fails(
    'applies 003 over existing data, keeps every row, and the unique key includes metric',
    async () => {
      const before = await snapshotAll()

      const applied = await migrate(legacyPool())

      expect(applied).toHaveLength(1)
      expect(applied[0]).toMatch(/^003_.*\.sql$/)
      // 003 also adds readings.future (rule 4); existing rows get false and nothing else changes.
      expect(await snapshotAll()).toEqual({
        ...before,
        readings: before.readings.map((row) => Object.assign({}, row, { future: false })),
      })

      const { rows } = await legacyPool().query<{ columns: string[] }>(
        `SELECT array_agg(a.attname::text ORDER BY a.attname) AS columns
         FROM pg_constraint c
         JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
        WHERE c.conrelid = 'readings'::regclass AND c.contype = 'u'
        GROUP BY c.oid`,
      )
      expect(rows.map((row) => row.columns)).toEqual([
        ['device_id', 'event_time', 'gateway_id', 'metric', 'sequence'],
      ])

      // A second metric of an existing legacy sample is now a new reading, not a conflict.
      const outcome = await processReading(
        legacyPool(),
        readingMessage({
          device_id: 'legacy-2',
          sequence: 1,
          metric: 'vibration',
          value: 0.5,
          event_time: '2026-10-10T11:10:00Z',
        }),
        OPTIONS,
      )
      expect(outcome.status).toBe('inserted')
    },
  )
})
