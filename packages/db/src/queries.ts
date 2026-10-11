import type { DeviceStatus, DeviceSummary, GatewaySummary, Reading } from '@telemetry/shared'
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

/** Devices ordered by deviceId. The contract is documented in queries.integration.test.ts. */
export async function listDevices(
  _pool: Pool,
  _options: ListDevicesOptions,
): Promise<DeviceSummary[]> {
  throw new Error('not implemented')
}

export async function getDevice(
  _pool: Pool,
  _deviceId: string,
  _options: ReadOptions,
): Promise<DeviceSummary | null> {
  throw new Error('not implemented')
}

/** History ordered by (event_time, gateway_id, sequence); null when the device is unknown. */
export async function listReadings(_pool: Pool, _deviceId: string): Promise<Reading[] | null> {
  throw new Error('not implemented')
}

/** Gateways ordered by gatewayId. */
export async function listGateways(_pool: Pool, _options: ReadOptions): Promise<GatewaySummary[]> {
  throw new Error('not implemented')
}

/** The contract is documented in claim.integration.test.ts. */
export async function claimDevice(
  _pool: Pool,
  _deviceId: string,
  _name: string,
  _options: ReadOptions,
): Promise<ClaimResult> {
  throw new Error('not implemented')
}
