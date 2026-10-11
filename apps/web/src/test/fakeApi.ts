import type {
  ApiError,
  ClaimRequest,
  DeviceStatus,
  DeviceSummary,
  GatewaySummary,
  MetricState,
  Reading,
} from '@telemetry/shared'
import { delay, http, HttpResponse } from 'msw'
import { server } from './server'

export function metric(overrides: Partial<MetricState> = {}): MetricState {
  return {
    value: 0,
    eventTime: '2026-10-10T11:59:50.000Z',
    gatewayId: 'gw-1',
    sequence: 1,
    updatedAt: '2026-10-10T11:59:50.500Z',
    ...overrides,
  }
}

export function registeredDevice(
  deviceId: string,
  name: string,
  overrides: Partial<DeviceSummary> = {},
): DeviceSummary {
  return {
    deviceId,
    status: 'registered',
    name,
    firstSeenAt: '2026-10-10T11:00:00.000Z',
    firstSeenGatewayId: 'gw-1',
    gateways: ['gw-1'],
    possiblyBehind: false,
    metrics: {},
    clockWarnings: [],
    ...overrides,
  }
}

export function unregisteredDevice(
  deviceId: string,
  overrides: Partial<DeviceSummary> = {},
): DeviceSummary {
  return {
    deviceId,
    status: 'unregistered',
    name: null,
    firstSeenAt: '2026-10-10T11:58:00.000Z',
    firstSeenGatewayId: 'gw-1',
    gateways: ['gw-1'],
    possiblyBehind: false,
    metrics: {},
    clockWarnings: [],
    ...overrides,
  }
}

export function gatewaySummary(
  gatewayId: string,
  overrides: Partial<GatewaySummary> = {},
): GatewaySummary {
  return {
    gatewayId,
    lastSeenAt: '2026-10-10T11:59:50.000Z',
    stale: false,
    clock: { status: 'ok', offsetMs: null, samples: 20 },
    ...overrides,
  }
}

export function reading(overrides: Partial<Reading> & Pick<Reading, 'deviceId'>): Reading {
  return {
    gatewayId: 'gw-1',
    sequence: 1,
    metric: 'temperature',
    value: 0,
    eventTime: '2026-10-10T11:59:00.000Z',
    receivedAt: '2026-10-10T11:59:00.200Z',
    processedAt: '2026-10-10T11:59:00.300Z',
    late: false,
    outOfOrder: false,
    future: false,
    ...overrides,
  }
}

export interface FakeApiSeed {
  devices?: DeviceSummary[]
  readings?: Reading[]
  gateways?: GatewaySummary[]
}

export interface RecordedRequest {
  method: string
  path: string
  search: string
  body: unknown
}

/**
 * In-memory backend behind MSW, implementing the read-API contract in @telemetry/shared on the
 * exact routes the api serves. Tests mutate `state` to simulate the backend changing (for example
 * before emitting an SSE event) and inspect `requests` to see what the app sent.
 */
export interface FakeApi {
  state: { devices: DeviceSummary[]; readings: Reading[]; gateways: GatewaySummary[] }
  requests: RecordedRequest[]
  /** Replace or add a device by deviceId. */
  upsertDevice(device: DeviceSummary): void
  /** Pause every claim response until the returned function is called. */
  holdClaims(): () => void
}

function byEventTime(a: Reading, b: Reading) {
  return a.eventTime.localeCompare(b.eventTime)
}

function isClaimRequest(body: unknown): body is ClaimRequest {
  return (
    typeof body === 'object' &&
    body !== null &&
    'name' in body &&
    typeof body.name === 'string' &&
    body.name.trim().length > 0
  )
}

function isDeviceStatus(value: string | null): value is DeviceStatus {
  return value === 'registered' || value === 'unregistered'
}

function errorBody(error: string): ApiError {
  return { error }
}

export function installFakeApi(seed: FakeApiSeed = {}): FakeApi {
  const state = {
    devices: [...(seed.devices ?? [])],
    readings: [...(seed.readings ?? [])],
    gateways: [...(seed.gateways ?? [])],
  }
  const requests: RecordedRequest[] = []
  const pendingClaimGates: Promise<void>[] = []

  async function record(request: Request) {
    const url = new URL(request.url)
    const text = request.method === 'GET' ? '' : await request.clone().text()
    requests.push({
      method: request.method,
      path: url.pathname,
      search: url.search,
      body: text ? JSON.parse(text) : undefined,
    })
  }

  function findDevice(deviceId: string) {
    return state.devices.find((device) => device.deviceId === deviceId)
  }

  function upsertDevice(device: DeviceSummary) {
    state.devices = [...state.devices.filter((d) => d.deviceId !== device.deviceId), device]
  }

  server.use(
    http.get('/api/devices', async ({ request }) => {
      await record(request)
      const status = new URL(request.url).searchParams.get('status')
      if (status !== null && !isDeviceStatus(status)) {
        return HttpResponse.json(errorBody('invalid status'), { status: 400 })
      }
      const devices = status ? state.devices.filter((d) => d.status === status) : state.devices
      return HttpResponse.json<DeviceSummary[]>(devices)
    }),

    http.get<{ deviceId: string }>(
      '/api/devices/:deviceId/readings',
      async ({ request, params }) => {
        await record(request)
        if (!findDevice(params.deviceId)) {
          return HttpResponse.json(errorBody('device not found'), { status: 404 })
        }
        const history = state.readings
          .filter((r) => r.deviceId === params.deviceId)
          .sort(byEventTime)
        return HttpResponse.json<Reading[]>(history)
      },
    ),

    http.post<{ deviceId: string }>('/api/devices/:deviceId/claim', async ({ request, params }) => {
      await record(request)
      const body: unknown = await request.json()
      await Promise.all(pendingClaimGates)
      if (!isClaimRequest(body)) {
        return HttpResponse.json(errorBody('name is required'), { status: 400 })
      }
      const device = findDevice(params.deviceId)
      if (!device) {
        return HttpResponse.json(errorBody('device not found'), { status: 404 })
      }
      if (device.status === 'registered') {
        return HttpResponse.json<DeviceSummary>(device, { status: 409 })
      }
      const claimed: DeviceSummary = { ...device, status: 'registered', name: body.name.trim() }
      upsertDevice(claimed)
      return HttpResponse.json<DeviceSummary>(claimed)
    }),

    http.get('/api/gateways', async ({ request }) => {
      await record(request)
      return HttpResponse.json<GatewaySummary[]>(state.gateways)
    }),
  )

  return {
    state,
    requests,
    upsertDevice(device) {
      upsertDevice(device)
    },
    holdClaims() {
      let release = () => {}
      pendingClaimGates.push(
        new Promise<void>((resolve) => {
          release = resolve
        }),
      )
      return () => release()
    },
  }
}

/** Every /api route answers 500, for error-state tests. */
export function installFailingApi() {
  const failure = () => HttpResponse.json(errorBody('internal error'), { status: 500 })
  server.use(
    http.get('/api/devices', failure),
    http.get('/api/devices/:deviceId/readings', failure),
    http.get('/api/gateways', failure),
  )
}

/** Every GET /api route hangs until the test ends, for loading-state tests. */
export function installPendingApi() {
  const never = async () => {
    await delay('infinite')
    return HttpResponse.json([])
  }
  server.use(
    http.get('/api/devices', never),
    http.get('/api/devices/:deviceId/readings', never),
    http.get('/api/gateways', never),
  )
}
