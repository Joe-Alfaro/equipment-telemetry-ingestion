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

/*
 * CONTRACT (rule 2): anything Postgres cannot store gets a 400, never a 202.
 *   - event_time is ISO-8601. Without an offset it is treated as UTC and accepted; the published
 *     event_time then carries an explicit UTC offset with the same digits. The date must be a real
 *     calendar date (strict Y-M-D h:m:s round trip) with a year from 1 to 9999.
 *   - gateway_id, device_id and metric are non-empty, at most 256 characters, with no \u0000.
 *   - value is a finite number; sequence passes Number.isSafeInteger.
 */
describe('POST /ingest/readings: only storable readings are accepted (rule 2)', () => {
  const valid = {
    gateway_id: 'gw-0',
    device_id: 'dev-1',
    metric: 'temperature',
    value: 70,
    event_time: '2026-10-10T12:00:00Z',
    sequence: 0,
  }

  async function post(payload: unknown, raw = false) {
    const publisher = fakePublisher()
    const app = buildApp({ publisher })
    const response = await app.inject({
      method: 'POST',
      url: '/ingest/readings',
      headers: { 'content-type': 'application/json' },
      payload: raw ? (payload as string) : JSON.stringify(payload),
    })
    return { response, published: publisher.published }
  }

  it.fails.each([
    ['Feb 30', { ...valid, event_time: '2026-02-30T00:00:00Z' }],
    ['Feb 29 in a non-leap year', { ...valid, event_time: '2026-02-29T00:00:00Z' }],
    ['Apr 31', { ...valid, event_time: '2026-04-31T00:00:00Z' }],
    ['year 0000', { ...valid, event_time: '0000-01-01T00:00:00Z' }],
    ['hour 24', { ...valid, event_time: '2026-10-10T24:00:00Z' }],
    ['NUL in gateway_id', { ...valid, gateway_id: 'gw\u00000' }],
    ['NUL in device_id', { ...valid, device_id: 'dev\u00001' }],
    ['NUL in metric', { ...valid, metric: 'temp\u0000' }],
    ['a 257-character gateway_id', { ...valid, gateway_id: 'g'.repeat(257) }],
    ['a 257-character device_id', { ...valid, device_id: 'd'.repeat(257) }],
    ['a 257-character metric', { ...valid, metric: 'm'.repeat(257) }],
  ])('returns 400 and publishes nothing for %s', async (_label, payload) => {
    const { response, published } = await post(payload)

    expect(response.statusCode).toBe(400)
    expect(response.json()).toMatchObject({ error: 'invalid reading', details: expect.any(Array) })
    expect(published).toEqual([])
  })

  // Already rejected before rule 2; kept as guards.
  it.each([
    ['year 10000', JSON.stringify({ ...valid, event_time: '10000-01-01T00:00:00Z' })],
    [
      'an expanded year +010000',
      JSON.stringify({ ...valid, event_time: '+010000-01-01T00:00:00Z' }),
    ],
    ['value 1e309 (Infinity)', JSON.stringify(valid).replace('"value":70', '"value":1e309')],
    ['value -1e309', JSON.stringify(valid).replace('"value":70', '"value":-1e309')],
    ['sequence 2^53', JSON.stringify(valid).replace('"sequence":0', '"sequence":9007199254740992')],
    [
      'sequence -2^53',
      JSON.stringify(valid).replace('"sequence":0', '"sequence":-9007199254740992'),
    ],
  ])('returns 400 and publishes nothing for %s', async (_label, body) => {
    const { response, published } = await post(body, true)

    expect(response.statusCode).toBe(400)
    expect(published).toEqual([])
  })

  it.fails.each([
    ['2026-10-10T12:00:00', /^2026-10-10T12:00:00(Z|\+00:00)$/],
    ['2026-10-10T12:00:00.123456', /^2026-10-10T12:00:00\.123456(Z|\+00:00)$/],
  ])('accepts the naive timestamp %s as UTC', async (eventTime, published) => {
    const result = await post({ ...valid, event_time: eventTime })

    expect(result.response.statusCode).toBe(202)
    expect(result.published).toHaveLength(1)
    const stored = result.published[0]?.reading.event_time ?? ''
    expect(stored).toMatch(published)
    expect(new Date(stored).toISOString()).toBe(new Date(`${eventTime}Z`).toISOString())
  })

  // Already accepted before rule 2; kept as guards.
  it.each([
    [
      '256-character ids and metric',
      { gateway_id: 'g'.repeat(256), device_id: 'd'.repeat(256), metric: 'm'.repeat(256) },
    ],
    ['a +05:30 offset', { event_time: '2026-10-10T17:30:00+05:30' }],
    ['a -08:00 offset', { event_time: '2026-10-10T04:00:00.250-08:00' }],
    ['Feb 29 in a leap year', { event_time: '2028-02-29T23:59:59.999999Z' }],
    ['year 0001', { event_time: '0001-01-01T00:00:00Z' }],
    ['the last instant of year 9999', { event_time: '9999-12-31T23:59:59Z' }],
    ['the largest safe sequence', { sequence: Number.MAX_SAFE_INTEGER }],
  ])('returns 202 and publishes the reading unchanged for %s', async (_label, overrides) => {
    const payload = { ...valid, ...overrides }

    const { response, published } = await post(payload)

    expect(response.statusCode).toBe(202)
    expect(published.map((message) => message.reading)).toEqual([payload])
  })
})
