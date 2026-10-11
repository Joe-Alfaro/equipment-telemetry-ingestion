/** Read-API contract consumed by the web app. All timestamps are ISO-8601 strings. */

export type DeviceStatus = 'unregistered' | 'registered'

export interface MetricState {
  value: number
  eventTime: string
  gatewayId: string
  sequence: number
  updatedAt: string
}

/** GET /api/devices?status=... returns DeviceSummary[]. */
export interface DeviceSummary {
  deviceId: string
  status: DeviceStatus
  name: string | null
  firstSeenAt: string
  firstSeenGatewayId: string
  gateways: string[]
  /** True when any gateway reporting this device is stale. */
  possiblyBehind: boolean
  metrics: Record<string, MetricState>
  /**
   * One entry per gateway that has reported this device and whose clock status is `ahead` or
   * `local-time`, ordered by gatewayId; empty when there are none. Optional until the clock check
   * lands (existing literals predate it); the api always sends it.
   */
  clockWarnings?: ClockWarning[]
}

/** GET /api/devices/:deviceId/readings returns Reading[] ordered by eventTime. */
export interface Reading {
  gatewayId: string
  deviceId: string
  sequence: number
  metric: string
  value: number
  eventTime: string
  receivedAt: string
  processedAt: string
  late: boolean
  outOfOrder: boolean
  /** event_time - processed_at > FUTURE_SKEW_MS (default 60000). Flag only. */
  future: boolean
}

/** Body of POST /api/devices/:deviceId/claim. */
export interface ClaimRequest {
  name: string
}

/**
 * A gateway's clock, judged from its last 20 stored readings by received_at, where each reading's
 * skew = event_time - received_at. Detection only: stored timestamps are never corrected.
 *   - `local-time`: >= 5 naive readings, >= 80% of them within 5 min of the same non-zero multiple
 *     of 15 min; offsetMs is that multiple.
 *   - `ahead`: median skew > CLOCK_SKEW_THRESHOLD_MS; offsetMs is the median, rounded to the second.
 *   - `ok`: anything else (a negative median is never flagged).
 *   - `unknown`: fewer than 5 readings.
 */
export type ClockStatus = 'ok' | 'ahead' | 'local-time' | 'unknown'

export interface GatewayClock {
  status: ClockStatus
  offsetMs: number | null
  /** Readings in the window (at most 20). */
  samples: number
}

export interface ClockWarning {
  gatewayId: string
  status: 'ahead' | 'local-time'
  offsetMs: number
}

/** GET /api/gateways returns GatewaySummary[]. */
export interface GatewaySummary {
  gatewayId: string
  lastSeenAt: string
  stale: boolean
  /** Optional until the clock check lands (existing literals predate it); the api always sends it. */
  clock?: GatewayClock
}

export interface ApiError {
  error: string
  details?: string[]
}

/** Events sent on GET /api/stream (SSE `event:` name -> `data:` payload). */
export interface StreamEventMap {
  'device-updated': { deviceId: string }
  'device-discovered': { deviceId: string }
  'device-claimed': { deviceId: string }
  'gateway-updated': { gatewayId: string }
}

export type StreamEventName = keyof StreamEventMap

export type StreamEvent = {
  [K in StreamEventName]: { event: K; data: StreamEventMap[K] }
}[StreamEventName]

export const STREAM_EVENT_NAMES: readonly StreamEventName[] = [
  'device-updated',
  'device-discovered',
  'device-claimed',
  'gateway-updated',
]
