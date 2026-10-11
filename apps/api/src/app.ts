import type { Pool } from '@telemetry/db'
import type { ReadingPublisher } from '@telemetry/broker'
import { parseIngestReading, type ApiError } from '@telemetry/shared'
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify'

export interface AppDeps {
  publisher: ReadingPublisher
  /** Optional so ingest-only tests need no database. The read API (phase 2) requires it. */
  pool?: Pool
  now?: () => Date
  /** Gateway staleness threshold for the read API (`possiblyBehind`, `stale`). Default 30000. */
  lateThresholdMs?: number
  logger?: FastifyServerOptions['logger']
}

export function buildApp({ publisher, pool, now = () => new Date(), logger = false }: AppDeps) {
  const app: FastifyInstance = Fastify({ logger })

  app.get('/healthz', async (_request, reply) => {
    const brokerOk = publisher.isReady()
    const dbOk = pool
      ? await pool.query('SELECT 1').then(
          () => true,
          () => false,
        )
      : true
    const body = { status: brokerOk && dbOk ? 'ok' : 'degraded', broker: brokerOk, db: dbOk }
    return reply.code(brokerOk && dbOk ? 200 : 503).send(body)
  })

  app.post('/ingest/readings', async (request, reply) => {
    const parsed = parseIngestReading(request.body)
    if (!parsed.ok) {
      const body: ApiError = { error: 'invalid reading', details: parsed.errors }
      return reply.code(400).send(body)
    }

    try {
      await publisher.publish({ reading: parsed.value, receivedAt: now().toISOString() })
    } catch (error) {
      request.log.error({ err: error }, 'failed to publish reading')
      const body: ApiError = { error: 'broker unavailable' }
      return reply.code(503).send(body)
    }

    return reply.code(202).send({ status: 'accepted' })
  })

  // TODO(phase 2A): read API (/api/devices, /api/devices/:id/readings, claim, /api/gateways)
  // and the SSE stream (/api/stream). Contract types live in @telemetry/shared.

  return app
}
