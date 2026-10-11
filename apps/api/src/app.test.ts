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
