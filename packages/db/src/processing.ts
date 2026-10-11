import type { ReadingMessage, StreamEvent } from '@telemetry/shared'
import { notifyEvents } from './events'
import type { Pool, PoolClient } from './pool'
import { withTransaction } from './transaction'

export type ProcessStatus = 'inserted' | 'duplicate' | 'conflict'

export interface ProcessOutcome {
  status: ProcessStatus
  /** Set only for `inserted`: processed_at - event_time > lateThresholdMs. */
  late: boolean
  /** Set only for `inserted`: event_time is older than the stored current_state for its (device, metric). */
  outOfOrder: boolean
  /** This transaction created the devices row (first sighting). */
  deviceDiscovered: boolean
  /** This reading replaced (or created) current_state for its (device, metric). */
  currentStateUpdated: boolean
}

export interface ProcessOptions {
  /** Processing time: stored as readings.processed_at and current_state.updated_at. */
  now: Date
  lateThresholdMs: number
  /** readings.future = event_time - now > futureSkewMs (strictly). Default 60000 (rule 4). */
  futureSkewMs?: number
}

/*
 * Every step relies on a constraint or a row lock, never on timing:
 *   devices        PK + ON CONFLICT DO NOTHING      -> one row however many first sightings race
 *   readings       5-part UNIQUE + ON CONFLICT      -> one row however often a reading is resent
 *   current_state  PK + conditional ON CONFLICT DO UPDATE -> only a strictly greater
 *                  (event_time, gateway_id, sequence) replaces the row, in any arrival order
 * Locks are always taken in the order devices -> readings -> current_state -> gateways, so
 * concurrent transactions cannot deadlock. The hot gateways row is locked last to hold it briefly.
 * Text columns are compared with COLLATE "C" so the tie-break is byte order, independent of the
 * database locale.
 */

async function registerDevice(client: PoolClient, message: ReadingMessage): Promise<boolean> {
  const { rowCount } = await client.query(
    `INSERT INTO devices (device_id, first_seen_at, first_seen_gateway_id)
     VALUES ($1, $2, $3)
     ON CONFLICT (device_id) DO NOTHING`,
    [message.reading.device_id, message.receivedAt, message.reading.gateway_id],
  )
  return rowCount === 1
}

/** Default for ProcessOptions.futureSkewMs (rule 4). */
export const DEFAULT_FUTURE_SKEW_MS = 60_000

interface InsertedReading {
  id: string
  late: boolean
}

async function insertReading(
  client: PoolClient,
  { reading, receivedAt }: ReadingMessage,
  { now, lateThresholdMs, futureSkewMs = DEFAULT_FUTURE_SKEW_MS }: ProcessOptions,
): Promise<InsertedReading | null> {
  // `late` and `future` are computed in SQL so event_time keeps its microseconds (a JS Date would not).
  const { rows } = await client.query<InsertedReading>(
    `INSERT INTO readings
       (gateway_id, device_id, sequence, metric, value, event_time, received_at, processed_at,
        late, future)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8,
             $8::timestamptz - $6::timestamptz > $9::double precision * interval '1 millisecond',
             $6::timestamptz - $8::timestamptz > $10::double precision * interval '1 millisecond')
     ON CONFLICT (gateway_id, device_id, metric, sequence, event_time) DO NOTHING
     RETURNING id, late`,
    [
      reading.gateway_id,
      reading.device_id,
      reading.sequence,
      reading.metric,
      reading.value,
      reading.event_time,
      receivedAt,
      now.toISOString(),
      lateThresholdMs,
      futureSkewMs,
    ],
  )
  return rows[0] ?? null
}

/** The key already exists: a byte-identical resend is a duplicate, anything else a conflict. */
async function classifyExisting(
  client: PoolClient,
  { reading, receivedAt }: ReadingMessage,
): Promise<'duplicate' | 'conflict'> {
  const { rows } = await client.query<{ value: number }>(
    `SELECT value FROM readings
      WHERE gateway_id = $1 AND device_id = $2 AND metric = $3 AND sequence = $4
        AND event_time = $5`,
    [reading.gateway_id, reading.device_id, reading.metric, reading.sequence, reading.event_time],
  )
  const existing = rows[0]
  if (existing && existing.value === reading.value) {
    return 'duplicate'
  }
  await client.query(
    `INSERT INTO reading_conflicts (gateway_id, device_id, sequence, payload, received_at)
     VALUES ($1, $2, $3, $4, $5)`,
    [reading.gateway_id, reading.device_id, reading.sequence, JSON.stringify(reading), receivedAt],
  )
  return 'conflict'
}

interface CurrentStateResult {
  updated: boolean
  outOfOrder: boolean
}

async function applyToCurrentState(
  client: PoolClient,
  { reading }: ReadingMessage,
  readingId: string,
  now: Date,
): Promise<CurrentStateResult> {
  const { rowCount } = await client.query(
    `INSERT INTO current_state AS cs
       (device_id, metric, value, event_time, gateway_id, sequence, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (device_id, metric) DO UPDATE SET
       value = EXCLUDED.value,
       event_time = EXCLUDED.event_time,
       gateway_id = EXCLUDED.gateway_id,
       sequence = EXCLUDED.sequence,
       updated_at = EXCLUDED.updated_at
     WHERE (EXCLUDED.event_time, EXCLUDED.gateway_id COLLATE "C", EXCLUDED.sequence)
         > (cs.event_time, cs.gateway_id COLLATE "C", cs.sequence)`,
    [
      reading.device_id,
      reading.metric,
      reading.value,
      reading.event_time,
      reading.gateway_id,
      reading.sequence,
      now.toISOString(),
    ],
  )
  if (rowCount === 1) {
    return { updated: true, outOfOrder: false }
  }

  // ON CONFLICT locked the current_state row even though it was not replaced, so it cannot
  // change before this transaction ends. Losing only the tie-break is not out of order.
  const { rowCount: flagged } = await client.query(
    `UPDATE readings SET out_of_order = true
      WHERE id = $1
        AND EXISTS (SELECT 1 FROM current_state
                     WHERE device_id = $2 AND metric = $3 AND event_time > $4::timestamptz)`,
    [readingId, reading.device_id, reading.metric, reading.event_time],
  )
  return { updated: false, outOfOrder: flagged === 1 }
}

async function touchGateway(client: PoolClient, message: ReadingMessage): Promise<void> {
  // GREATEST semantics: a redelivered old message never moves last_seen_at backwards.
  await client.query(
    `INSERT INTO gateways AS g (gateway_id, first_seen_at, last_seen_at)
     VALUES ($1, $2, $2)
     ON CONFLICT (gateway_id) DO UPDATE SET last_seen_at = EXCLUDED.last_seen_at
     WHERE g.last_seen_at < EXCLUDED.last_seen_at`,
    [message.reading.gateway_id, message.receivedAt],
  )
}

const NO_CHANGE = {
  late: false,
  outOfOrder: false,
  deviceDiscovered: false,
  currentStateUpdated: false,
}

async function applyReading(
  client: PoolClient,
  message: ReadingMessage,
  options: ProcessOptions,
): Promise<ProcessOutcome> {
  // The device row must exist before the reading (foreign key). For a resend it already does,
  // so a duplicate or conflict can never be the discovering transaction.
  const deviceDiscovered = await registerDevice(client, message)
  const inserted = await insertReading(client, message, options)
  if (!inserted) {
    return { status: await classifyExisting(client, message), ...NO_CHANGE }
  }

  const state = await applyToCurrentState(client, message, inserted.id, options.now)
  return {
    status: 'inserted',
    late: inserted.late,
    outOfOrder: state.outOfOrder,
    deviceDiscovered,
    currentStateUpdated: state.updated,
  }
}

/**
 * Applies one broker message in ONE transaction and resolves after COMMIT.
 * The full contract is documented in processing.integration.test.ts.
 */
export async function processReading(
  pool: Pool,
  message: ReadingMessage,
  options: ProcessOptions,
): Promise<ProcessOutcome> {
  const { device_id: deviceId, gateway_id: gatewayId } = message.reading

  return withTransaction(pool, async (client) => {
    const outcome = await applyReading(client, message, options)

    await touchGateway(client, message)

    const events: StreamEvent[] = [
      ...(outcome.deviceDiscovered
        ? [{ event: 'device-discovered' as const, data: { deviceId } }]
        : []),
      ...(outcome.status === 'inserted'
        ? [{ event: 'device-updated' as const, data: { deviceId } }]
        : []),
      { event: 'gateway-updated', data: { gatewayId } },
    ]
    await notifyEvents(client, events)

    return outcome
  })
}
