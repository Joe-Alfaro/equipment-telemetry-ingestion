import type {
  DeviceStatus,
  DeviceSummary,
  GatewaySummary,
  MetricState,
  Reading,
  StreamEvent,
} from '@telemetry/shared'
import { TELEMETRY_EVENTS_CHANNEL } from './events'
import type { Pool } from './pool'

export interface ReadOptions {
  /** Reference time for gateway staleness: stale when now - last_seen_at > lateThresholdMs. */
  now: Date
  lateThresholdMs: number
}

export interface ListDevicesOptions extends ReadOptions {
  status?: DeviceStatus
}

export type ClaimResult =
  | { outcome: 'claimed'; device: DeviceSummary }
  | { outcome: 'already-registered'; device: DeviceSummary }
  | { outcome: 'not-found' }

interface DeviceRow {
  device_id: string
  status: DeviceStatus
  name: string | null
  first_seen_at: Date
  first_seen_gateway_id: string
  gateways: string[]
  possibly_behind: boolean
}

interface CurrentStateRow {
  device_id: string
  metric: string
  value: number
  event_time: Date
  gateway_id: string
  sequence: string
  updated_at: Date
}

// Shared by gateway staleness everywhere: stale when now - last_seen_at > threshold (strictly).
const STALE = `$1::timestamptz - g.last_seen_at > $2::double precision * interval '1 millisecond'`

/**
 * Device summaries matching `where` ($3 onward), ordered by deviceId. Text is ordered with
 * COLLATE "C" so the API order matches a plain JS string sort regardless of database locale.
 */
async function queryDevices(
  pool: Pool,
  { now, lateThresholdMs }: ReadOptions,
  where: string,
  params: unknown[],
): Promise<DeviceSummary[]> {
  const { rows: devices } = await pool.query<DeviceRow>(
    `SELECT d.device_id, d.status, d.name, d.first_seen_at, d.first_seen_gateway_id,
            COALESCE(gw.gateways, '{}') AS gateways,
            COALESCE(gw.possibly_behind, false) AS possibly_behind
       FROM devices d
       LEFT JOIN LATERAL (
         SELECT array_agg(g.gateway_id ORDER BY g.gateway_id COLLATE "C") AS gateways,
                bool_or(${STALE}) AS possibly_behind
           FROM (SELECT DISTINCT gateway_id FROM readings r WHERE r.device_id = d.device_id) rg
           JOIN gateways g ON g.gateway_id = rg.gateway_id
       ) gw ON true
      WHERE ${where}
      ORDER BY d.device_id COLLATE "C"`,
    [now.toISOString(), lateThresholdMs, ...params],
  )
  if (devices.length === 0) {
    return []
  }

  const { rows: states } = await pool.query<CurrentStateRow>(
    `SELECT device_id, metric, value, event_time, gateway_id, sequence, updated_at
       FROM current_state WHERE device_id = ANY($1)
      ORDER BY metric COLLATE "C"`,
    [devices.map((device) => device.device_id)],
  )
  const metricsByDevice = states.reduce((acc, state) => {
    const metrics = acc.get(state.device_id) ?? {}
    const metric: MetricState = {
      value: state.value,
      eventTime: state.event_time.toISOString(),
      gatewayId: state.gateway_id,
      sequence: Number(state.sequence),
      updatedAt: state.updated_at.toISOString(),
    }
    return acc.set(state.device_id, { ...metrics, [state.metric]: metric })
  }, new Map<string, Record<string, MetricState>>())

  return devices.map((device) => ({
    deviceId: device.device_id,
    status: device.status,
    name: device.name,
    firstSeenAt: device.first_seen_at.toISOString(),
    firstSeenGatewayId: device.first_seen_gateway_id,
    gateways: device.gateways,
    possiblyBehind: device.possibly_behind,
    metrics: metricsByDevice.get(device.device_id) ?? {},
  }))
}

/** Devices ordered by deviceId. The contract is documented in queries.integration.test.ts. */
export async function listDevices(
  pool: Pool,
  { status, ...options }: ListDevicesOptions,
): Promise<DeviceSummary[]> {
  if (!status) {
    return queryDevices(pool, options, 'true', [])
  }
  return queryDevices(pool, options, 'd.status = $3', [status])
}

export async function getDevice(
  pool: Pool,
  deviceId: string,
  options: ReadOptions,
): Promise<DeviceSummary | null> {
  const [device] = await queryDevices(pool, options, 'd.device_id = $3', [deviceId])
  return device ?? null
}

interface ReadingRow {
  gateway_id: string
  device_id: string
  sequence: string
  metric: string
  value: number
  event_time: Date
  received_at: Date
  processed_at: Date
  late: boolean
  out_of_order: boolean
}

/** History ordered by (event_time, gateway_id, sequence); null when the device is unknown. */
export async function listReadings(pool: Pool, deviceId: string): Promise<Reading[] | null> {
  const { rows } = await pool.query<ReadingRow>(
    `SELECT gateway_id, device_id, sequence, metric, value, event_time, received_at,
            processed_at, late, out_of_order
       FROM readings WHERE device_id = $1
      ORDER BY event_time, gateway_id COLLATE "C", sequence`,
    [deviceId],
  )
  // Every stored reading references its device, so no rows means unknown or (never) empty.
  if (rows.length === 0) {
    const { rowCount } = await pool.query('SELECT 1 FROM devices WHERE device_id = $1', [deviceId])
    return rowCount === 0 ? null : []
  }
  return rows.map((row) => ({
    gatewayId: row.gateway_id,
    deviceId: row.device_id,
    sequence: Number(row.sequence),
    metric: row.metric,
    value: row.value,
    eventTime: row.event_time.toISOString(),
    receivedAt: row.received_at.toISOString(),
    processedAt: row.processed_at.toISOString(),
    late: row.late,
    outOfOrder: row.out_of_order,
  }))
}

/** Gateways ordered by gatewayId. */
export async function listGateways(
  pool: Pool,
  { now, lateThresholdMs }: ReadOptions,
): Promise<GatewaySummary[]> {
  const { rows } = await pool.query<{ gateway_id: string; last_seen_at: Date; stale: boolean }>(
    `SELECT g.gateway_id, g.last_seen_at, ${STALE} AS stale
       FROM gateways g ORDER BY g.gateway_id COLLATE "C"`,
    [now.toISOString(), lateThresholdMs],
  )
  return rows.map((row) => ({
    gatewayId: row.gateway_id,
    lastSeenAt: row.last_seen_at.toISOString(),
    stale: row.stale,
  }))
}

/**
 * The contract is documented in claim.integration.test.ts. A single conditional UPDATE
 * decides the winner: concurrent claims block on the row lock, then re-check
 * `status = 'unregistered'` and match nothing. The NOTIFY is part of the same statement,
 * so it is sent only if this call registered the device.
 */
export async function claimDevice(
  pool: Pool,
  deviceId: string,
  name: string,
  options: ReadOptions,
): Promise<ClaimResult> {
  const claimedEvent: StreamEvent = { event: 'device-claimed', data: { deviceId } }
  const { rowCount } = await pool.query(
    `WITH claimed AS (
       UPDATE devices SET status = 'registered', name = $2, claimed_at = $3
        WHERE device_id = $1 AND status = 'unregistered'
       RETURNING device_id
     )
     SELECT pg_notify($4, $5) FROM claimed`,
    [
      deviceId,
      name,
      options.now.toISOString(),
      TELEMETRY_EVENTS_CHANNEL,
      JSON.stringify(claimedEvent),
    ],
  )
  const device = await getDevice(pool, deviceId, options)
  if (!device) {
    return { outcome: 'not-found' }
  }
  return { outcome: rowCount === 1 ? 'claimed' : 'already-registered', device }
}
