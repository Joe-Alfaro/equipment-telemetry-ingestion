import type { Pool } from '@telemetry/db'
import type { ReadingPublisher } from '@telemetry/broker'
import { parseIngestReading, type ApiError } from '@telemetry/shared'
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify'
import { registerReadApi } from './read-api'
import { registerStream } from './stream'

export interface AppDeps {
  publisher: ReadingPublisher
  /** Optional so ingest-only tests need no database. The read API (phase 2) requires it. */
  pool?: Pool
  now?: () => Date
  /** Gateway staleness threshold for the read API (`possiblyBehind`, `stale`). Default 30000. */
  lateThresholdMs?: number
  /** Gateway clock `ahead` threshold for the read API (`clock`, `clockWarnings`). Default 60000. */
  clockSkewThresholdMs?: number
  /** Minimum interval between relayed gateway-updated events per gateway. Default 1000. */
  gatewayEventIntervalMs?: number
  logger?: FastifyServerOptions['logger']
}

export function buildApp({
  publisher,
  pool,
  now = () => new Date(),
  lateThresholdMs = 30_000,
  clockSkewThresholdMs = 60_000,
  gatewayEventIntervalMs = 1_000,
  logger = false,
}: AppDeps) {
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

    // Validation appends Z to a naive event_time and leaves one with an offset unchanged.
    const naiveTime =
      parsed.value.event_time !== (request.body as { event_time: unknown }).event_time
    try {
      await publisher.publish({ reading: parsed.value, receivedAt: now().toISOString(), naiveTime })
    } catch (error) {
      request.log.error({ err: error }, 'failed to publish reading')
      const body: ApiError = { error: 'broker unavailable' }
      return reply.code(503).send(body)
    }

    return reply.code(202).send({ status: 'accepted' })
  })

  if (pool) {
    registerReadApi(app, { pool, now, lateThresholdMs, clockSkewThresholdMs })
    registerStream(app, { pool, gatewayEventIntervalMs })
  }

  return app
}
