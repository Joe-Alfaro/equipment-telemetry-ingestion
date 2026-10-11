import type { Pool } from '@telemetry/db'
import type { StreamEvent } from '@telemetry/shared'
import type { FastifyInstance } from 'fastify'
import type { ServerResponse } from 'node:http'
import { createEventRelay } from './event-relay'

export interface StreamDeps {
  pool: Pool
  gatewayEventIntervalMs: number
}

const KEEP_ALIVE_MS = 15_000

function frame({ event, data }: StreamEvent): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}

/** GET /api/stream: Server-Sent Events relaying committed NOTIFYs (see event-relay.ts). */
export function registerStream(app: FastifyInstance, { pool, gatewayEventIntervalMs }: StreamDeps) {
  const relay = createEventRelay(pool, { gatewayEventIntervalMs })
  const open = new Set<ServerResponse>()

  app.get('/api/stream', async (request, reply) => {
    const response = reply.raw
    // Writes can race the stream ending (app shutdown, relay reset); drop them instead of erroring.
    const send = (chunk: string) => {
      if (!response.writableEnded) {
        response.write(chunk)
      }
    }
    const end = () => response.end()

    // LISTEN first: the headers tell the client it is subscribed. Everything after this await
    // runs synchronously, so no notification can be relayed before the headers are written.
    const unsubscribe = await relay
      .subscribe((event) => send(frame(event)), end)
      .catch((error: unknown) => {
        request.log.error({ err: error }, 'could not subscribe to live updates')
        return null
      })
    if (!unsubscribe) {
      const body = { error: 'live updates unavailable' }
      return reply.code(503).send(body)
    }

    reply.hijack()
    response.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    })
    send(': connected\n\n')
    open.add(response)

    const keepAlive = setInterval(() => send(': keep-alive\n\n'), KEEP_ALIVE_MS)
    response.on('close', () => {
      clearInterval(keepAlive)
      unsubscribe()
      open.delete(response)
    })
  })

  // End open streams before the server waits for connections to drain.
  app.addHook('preClose', async () => {
    open.forEach((response) => response.end())
  })
  app.addHook('onClose', async () => {
    await relay.close()
  })
}
