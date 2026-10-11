import type { ReadingPublisher } from '@telemetry/broker'
import type { ReadingMessage } from '@telemetry/shared'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildApp } from './app'
import { loadConfig } from './config'

/*
 * CONTRACT (gateway clock check rules 2 and 4):
 *   - POST /ingest/readings publishes `naiveTime: true` on the envelope when event_time had no UTC
 *     offset (the api appended Z) and `naiveTime: false` when it had one (Z or +-hh:mm). The
 *     reading itself is unchanged; receivedAt is the injected `now`.
 *   - loadConfig() reads CLOCK_SKEW_THRESHOLD_MS into clockSkewThresholdMs, default 60000.
 */

const NOW = new Date('2026-10-10T12:00:00.000Z')

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

const valid = {
  gateway_id: 'gw-0',
  device_id: 'dev-1',
  metric: 'temperature',
  value: 70,
  sequence: 0,
}

async function publishedFor(eventTime: string): Promise<ReadingMessage | undefined> {
  const publisher = fakePublisher()
  const app = buildApp({ publisher, now: () => NOW })
  const response = await app.inject({
    method: 'POST',
    url: '/ingest/readings',
    payload: { ...valid, event_time: eventTime },
  })
  expect(response.statusCode).toBe(202)
  return publisher.published[0]
}

describe('POST /ingest/readings: the naive marker (rule 2)', () => {
  it.fails.each([
    ['2026-10-10T17:30:00', '2026-10-10T17:30:00Z'],
    ['2026-10-10T17:30:00.123456', '2026-10-10T17:30:00.123456Z'],
  ])('publishes naiveTime: true for %s', async (eventTime, published) => {
    const expected: ReadingMessage = {
      reading: { ...valid, event_time: published },
      receivedAt: NOW.toISOString(),
      naiveTime: true,
    }

    expect(await publishedFor(eventTime)).toStrictEqual(expected)
  })

  it.fails.each([
    '2026-10-10T12:00:00Z',
    '2026-10-10T12:00:00.123456+00:00',
    '2026-10-10T17:30:00+05:30',
    '2026-10-10T07:00:00-05:00',
  ])('publishes naiveTime: false for %s', async (eventTime) => {
    const expected: ReadingMessage = {
      reading: { ...valid, event_time: eventTime },
      receivedAt: NOW.toISOString(),
      naiveTime: false,
    }

    expect(await publishedFor(eventTime)).toStrictEqual(expected)
  })
})

describe('api config: CLOCK_SKEW_THRESHOLD_MS (rule 4)', () => {
  beforeEach(() => {
    vi.stubEnv('DATABASE_URL', 'postgres://localhost/telemetry')
    vi.stubEnv('AMQP_URL', 'amqp://localhost')
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it.fails('defaults clockSkewThresholdMs to 60000', () => {
    vi.stubEnv('CLOCK_SKEW_THRESHOLD_MS', undefined)

    expect(loadConfig()).toMatchObject({ clockSkewThresholdMs: 60_000 })
  })

  it.fails('reads clockSkewThresholdMs from CLOCK_SKEW_THRESHOLD_MS', () => {
    vi.stubEnv('CLOCK_SKEW_THRESHOLD_MS', '5000')

    expect(loadConfig()).toMatchObject({ clockSkewThresholdMs: 5_000 })
  })
})
