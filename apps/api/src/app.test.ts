import type { ReadingPublisher } from '@telemetry/broker'
import type { ReadingMessage } from '@telemetry/shared'
import { describe, expect, it } from 'vitest'
import { buildApp } from './app'

function fakePublisher(): ReadingPublisher & { published: ReadingMessage[] } {
  const published: ReadingMessage[] = []
  return {
    published,
    publish: async (message) => {
      published.push(message)
    },
    isReady: () => true,
    close: async () => {},
  }
}

describe('api (smoke)', () => {
  it('reports healthy', async () => {
    const app = buildApp({ publisher: fakePublisher() })

    const response = await app.inject({ method: 'GET', url: '/healthz' })

    expect(response.statusCode).toBe(200)
  })

  it('accepts a valid reading and publishes it', async () => {
    const publisher = fakePublisher()
    const app = buildApp({ publisher })

    const response = await app.inject({
      method: 'POST',
      url: '/ingest/readings',
      payload: {
        gateway_id: 'gw-0',
        device_id: 'dev-1',
        metric: 'temperature',
        value: 70,
        event_time: '2026-10-10T12:00:00+00:00',
        sequence: 0,
      },
    })

    expect(response.statusCode).toBe(202)
    expect(publisher.published).toHaveLength(1)
  })
})

describe('POST /ingest/readings validation', () => {
  const valid = {
    gateway_id: 'gw-0',
    device_id: 'dev-1',
    metric: 'temperature',
    value: 70,
    event_time: '2026-10-10T12:00:00.123456+00:00',
    sequence: 0,
  }

  it.each([
    ['a missing field', { ...valid, metric: undefined }],
    ['an empty gateway_id', { ...valid, gateway_id: '' }],
    ['a numeric device_id', { ...valid, device_id: 7 }],
    ['a string value', { ...valid, value: '70' }],
    ['a fractional sequence', { ...valid, sequence: 1.5 }],
    ['a string sequence', { ...valid, sequence: '1' }],
    ['an event_time without an offset', { ...valid, event_time: '2026-10-10T12:00:00' }],
    ['a non-date event_time', { ...valid, event_time: 'yesterday' }],
    ['an array body', [valid]],
  ])('returns 400 and publishes nothing for %s', async (_label, payload) => {
    const publisher = fakePublisher()
    const app = buildApp({ publisher })

    const response = await app.inject({ method: 'POST', url: '/ingest/readings', payload })

    expect(response.statusCode).toBe(400)
    expect(response.json()).toMatchObject({ error: 'invalid reading', details: expect.any(Array) })
    expect(publisher.published).toEqual([])
  })

  it('accepts the generator shapes: int status value, Z and offset event_times', async () => {
    const publisher = fakePublisher()
    const app = buildApp({ publisher })
    const bodies = [
      { ...valid, metric: 'status', value: 1 },
      { ...valid, event_time: '2026-10-10T12:00:00Z' },
      { ...valid, event_time: '2026-10-10T14:00:00.5+02:00', value: -3.25 },
    ]

    const responses = await bodies.reduce<Promise<{ statusCode: number }[]>>(
      async (previous, payload) => [
        ...(await previous),
        await app.inject({ method: 'POST', url: '/ingest/readings', payload }),
      ],
      Promise.resolve([]),
    )

    expect(responses.map((r) => r.statusCode)).toEqual([202, 202, 202])
    expect(publisher.published.map((m) => m.reading)).toEqual(bodies)
  })

  it('returns 503 when the broker does not confirm the publish', async () => {
    const app = buildApp({
      publisher: { ...fakePublisher(), publish: async () => Promise.reject(new Error('nack')) },
    })

    const response = await app.inject({ method: 'POST', url: '/ingest/readings', payload: valid })

    expect(response.statusCode).toBe(503)
  })
})
