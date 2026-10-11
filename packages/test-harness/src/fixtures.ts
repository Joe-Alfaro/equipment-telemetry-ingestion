import type { IngestReading, ReadingMessage } from '@telemetry/shared'
import type { Pool } from '@telemetry/db'

export interface ReadingOverrides extends Partial<IngestReading> {
  receivedAt?: string
}

/** A broker message with sensible defaults; override any wire field or receivedAt. */
export function readingMessage({
  receivedAt = '2026-10-10T12:00:00.100Z',
  ...reading
}: ReadingOverrides = {}): ReadingMessage {
  return {
    reading: {
      gateway_id: 'gw-a',
      device_id: 'dev-1',
      metric: 'temperature',
      value: 20,
      event_time: '2026-10-10T12:00:00.000Z',
      sequence: 0,
      ...reading,
    },
    receivedAt,
  }
}

/** `base` shifted by `offsetMs`, as an ISO string (millisecond precision, UTC). */
export function isoAt(base: string, offsetMs: number): string {
  return new Date(Date.parse(base) + offsetMs).toISOString()
}

/** `base` shifted by `offsetMs`, as a Date. */
export function dateAt(base: string, offsetMs: number): Date {
  return new Date(Date.parse(base) + offsetMs)
}

/** SQL expression rendering a timestamptz column as UTC ISO-8601 with microseconds. */
export function isoMicros(column: string): string {
  return `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`
}

export interface StoredReading {
  gateway_id: string
  device_id: string
  sequence: number
  metric: string
  value: number
  event_time: string
  received_at: string
  processed_at: string
  late: boolean
  out_of_order: boolean
}

/** Raw readings rows for a device, ordered by (event_time, gateway_id, sequence). */
export async function storedReadings(pool: Pool, deviceId: string): Promise<StoredReading[]> {
  const { rows } = await pool.query<StoredReading>(
    `SELECT gateway_id, device_id, sequence::int AS sequence, metric, value,
            ${isoMicros('event_time')} AS event_time,
            ${isoMicros('received_at')} AS received_at,
            ${isoMicros('processed_at')} AS processed_at,
            late, out_of_order
       FROM readings WHERE device_id = $1
      ORDER BY event_time, gateway_id, sequence`,
    [deviceId],
  )
  return rows
}

export interface StoredCurrentState {
  metric: string
  value: number
  event_time: string
  gateway_id: string
  sequence: number
  updated_at: string
}

/** Raw current_state rows for a device, ordered by metric. */
export async function storedCurrentState(
  pool: Pool,
  deviceId: string,
): Promise<StoredCurrentState[]> {
  const { rows } = await pool.query<StoredCurrentState>(
    `SELECT metric, value, ${isoMicros('event_time')} AS event_time, gateway_id,
            sequence::int AS sequence, ${isoMicros('updated_at')} AS updated_at
       FROM current_state WHERE device_id = $1 ORDER BY metric`,
    [deviceId],
  )
  return rows
}

export interface StoredDevice {
  device_id: string
  status: string
  name: string | null
  first_seen_at: string
  first_seen_gateway_id: string
  claimed_at: string | null
}

/** Raw devices rows with the given id (an array, so tests can assert exactly one). */
export async function storedDevices(pool: Pool, deviceId: string): Promise<StoredDevice[]> {
  const { rows } = await pool.query<StoredDevice>(
    `SELECT device_id, status, name, ${isoMicros('first_seen_at')} AS first_seen_at,
            first_seen_gateway_id, ${isoMicros('claimed_at')} AS claimed_at
       FROM devices WHERE device_id = $1`,
    [deviceId],
  )
  return rows
}

/** Renders a millisecond ISO string the way `isoMicros` does, for comparisons. */
export function micros(iso: string): string {
  return new Date(iso).toISOString().replace('Z', '000Z')
}
