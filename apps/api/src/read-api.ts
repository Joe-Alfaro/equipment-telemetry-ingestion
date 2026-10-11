import { claimDevice, listDevices, listGateways, listReadings, type Pool } from '@telemetry/db'
import type { ApiError, DeviceStatus } from '@telemetry/shared'
import type { FastifyInstance } from 'fastify'

export interface ReadApiDeps {
  pool: Pool
  now: () => Date
  lateThresholdMs: number
  clockSkewThresholdMs: number
}

interface DeviceParams {
  deviceId: string
}

const DEVICE_NOT_FOUND: ApiError = { error: 'device not found' }

function isDeviceStatus(value: unknown): value is DeviceStatus {
  return value === 'registered' || value === 'unregistered'
}

/** The read API consumed by the web app. Bodies are exactly the @telemetry/shared types. */
export function registerReadApi(
  app: FastifyInstance,
  { pool, now, lateThresholdMs, clockSkewThresholdMs }: ReadApiDeps,
) {
  const readOptions = () => ({ now: now(), lateThresholdMs, clockSkewThresholdMs })

  app.get<{ Querystring: { status?: unknown } }>('/api/devices', async (request, reply) => {
    const { status } = request.query
    if (status !== undefined && !isDeviceStatus(status)) {
      const body: ApiError = { error: "status must be 'registered' or 'unregistered'" }
      return reply.code(400).send(body)
    }
    return listDevices(pool, { ...readOptions(), status })
  })

  app.get<{ Params: DeviceParams }>('/api/devices/:deviceId/readings', async (request, reply) => {
    const readings = await listReadings(pool, request.params.deviceId)
    if (!readings) {
      return reply.code(404).send(DEVICE_NOT_FOUND)
    }
    return readings
  })

  app.post<{ Params: DeviceParams; Body: unknown }>(
    '/api/devices/:deviceId/claim',
    async (request, reply) => {
      const body = request.body
      const name =
        typeof body === 'object' && body !== null ? (body as { name?: unknown }).name : undefined
      if (typeof name !== 'string' || name.trim() === '') {
        const error: ApiError = { error: 'name must be a non-blank string' }
        return reply.code(400).send(error)
      }

      const result = await claimDevice(pool, request.params.deviceId, name.trim(), readOptions())
      if (result.outcome === 'not-found') {
        return reply.code(404).send(DEVICE_NOT_FOUND)
      }
      return reply.code(result.outcome === 'claimed' ? 200 : 409).send(result.device)
    },
  )

  app.get('/api/gateways', async () => listGateways(pool, readOptions()))
}
