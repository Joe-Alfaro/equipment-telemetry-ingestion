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

/** GET /api/gateways returns GatewaySummary[]. */
export interface GatewaySummary {
  gatewayId: string
  lastSeenAt: string
  stale: boolean
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
