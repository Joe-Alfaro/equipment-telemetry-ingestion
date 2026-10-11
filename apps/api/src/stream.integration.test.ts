import type { ReadingPublisher } from '@telemetry/broker'
import { processReading, type Pool } from '@telemetry/db'
import type { StreamEvent } from '@telemetry/shared'
import { createTestDatabase, readingMessage, type TestDatabase } from '@telemetry/test-harness'
import type { FastifyInstance } from 'fastify'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { buildApp } from './app'

/*
 * CONTRACT: GET /api/stream (Server-Sent Events).
 *
 *   - 200, Content-Type text/event-stream. The server is subscribed (LISTEN telemetry_events)
 *     BEFORE it sends the response headers, so any commit after the client sees the headers is
 *     delivered.
 *   - Each committed notification is relayed as one frame:  `event: <name>\ndata: <json>\n\n`
 *     where <name>/<json> are the StreamEvent's `event` and `data` (see packages/db notify tests
 *     for which writes emit which events). Comment lines (`:`) for keep-alive are allowed.
 *   - Every connected client receives every event.
 *   - app.close() ends open streams and releases the LISTEN connection.
 */

const ctx: { db?: TestDatabase; app?: FastifyInstance; baseUrl?: string; streams: Stream[] } = {
  streams: [],
}

function pool(): Pool {
  return (ctx.db as TestDatabase).pool
}

interface Stream {
  status: number
  contentType: string | null
  events: StreamEvent[]
  close(): void
}

function parseFrame(frame: string): StreamEvent | null {
  const fields = frame
    .split('\n')
    .filter((line) => !line.startsWith(':'))
    .reduce<Record<string, string>>((acc, line) => {
      const separator = line.indexOf(':')
      if (separator === -1) {
        return acc
      }
      const key = line.slice(0, separator)
      const value = line.slice(separator + 1).replace(/^ /, '')
      return { ...acc, [key]: acc[key] === undefined ? value : `${acc[key]}\n${value}` }
    }, {})
  if (fields.event === undefined || fields.data === undefined) {
    return null
  }
  return { event: fields.event, data: JSON.parse(fields.data) } as StreamEvent
}

async function openStream(): Promise<Stream> {
  const controller = new AbortController()
  const response = await fetch(`${ctx.baseUrl}/api/stream`, {
    headers: { accept: 'text/event-stream' },
    signal: controller.signal,
  })
  const stream: Stream = {
    status: response.status,
    contentType: response.headers.get('content-type'),
    events: [],
    close: () => controller.abort(),
  }
  ctx.streams.push(stream)

  if (response.ok && response.body) {
    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader()
    const state = { buffer: '' }
    const pump = async (): Promise<void> => {
      const { value, done } = await reader.read()
      if (done) {
        return
      }
      state.buffer += value.replaceAll('\r\n', '\n')
      const frames = state.buffer.split('\n\n')
      state.buffer = frames.pop() ?? ''
      frames.forEach((frame) => {
        const event = parseFrame(frame)
        if (event) {
          stream.events.push(event)
        }
      })
      return pump()
    }
    void pump().catch(() => {})
  } else {
    controller.abort()
  }
  return stream
}

async function waitForEvents(
  stream: Stream,
  count: number,
  timeoutMs = 5_000,
): Promise<StreamEvent[]> {
  const deadline = Date.now() + timeoutMs
  const poll = async (): Promise<StreamEvent[]> => {
    if (stream.events.length >= count || Date.now() > deadline) {
      return [...stream.events].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
    }
    await new Promise((resolve) => setTimeout(resolve, 20))
    return poll()
  }
  return poll()
}

function fakePublisher(): ReadingPublisher {
  return { publish: async () => {}, isReady: () => true, close: async () => {} }
}

function apply(deviceId: string, gatewayId = 'gw-s') {
  return processReading(pool(), readingMessage({ device_id: deviceId, gateway_id: gatewayId }), {
    now: new Date('2026-10-10T12:00:01.000Z'),
    lateThresholdMs: 30_000,
  })
}

beforeAll(async () => {
  ctx.db = await createTestDatabase({ poolSize: 6 })
})

afterAll(async () => {
  await ctx.db?.drop()
})

beforeEach(async () => {
  const app = buildApp({ publisher: fakePublisher(), pool: pool() })
  ctx.baseUrl = await app.listen({ host: '127.0.0.1', port: 0 })
  ctx.app = app
})

afterEach(async () => {
  ctx.streams.forEach((stream) => stream.close())
  ctx.streams = []
  await ctx.app?.close()
})

describe('GET /api/stream', () => {
  it('relays device-discovered, device-updated and gateway-updated after a reading commits', async () => {
    const stream = await openStream()
    expect(stream.status).toBe(200)
    expect(stream.contentType).toMatch(/^text\/event-stream/)

    await apply('s-new')

    expect(await waitForEvents(stream, 3)).toEqual([
      { event: 'device-discovered', data: { deviceId: 's-new' } },
      { event: 'device-updated', data: { deviceId: 's-new' } },
      { event: 'gateway-updated', data: { gatewayId: 'gw-s' } },
    ])
  })

  it('relays device-claimed after POST /api/devices/:id/claim', async () => {
    await apply('s-claim')
    const stream = await openStream()
    expect(stream.status).toBe(200)

    const claim = await fetch(`${ctx.baseUrl}/api/devices/s-claim/claim`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Cooling tower' }),
    })

    expect(claim.status).toBe(200)
    expect(await waitForEvents(stream, 1)).toEqual([
      { event: 'device-claimed', data: { deviceId: 's-claim' } },
    ])
  })

  it('delivers every event to every connected client', async () => {
    const streams = await Promise.all([openStream(), openStream()])
    expect(streams.map((s) => s.status)).toEqual([200, 200])

    await apply('s-fanout', 'gw-fanout')

    const received = await Promise.all(streams.map((s) => waitForEvents(s, 3)))
    received.forEach((events) => {
      expect(events.map((e) => e.event)).toEqual([
        'device-discovered',
        'device-updated',
        'gateway-updated',
      ])
    })
  })
})
