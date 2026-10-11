import { describe, expect, it } from 'vitest'
import { parseIngestReading } from './ingest'

describe('parseIngestReading (smoke)', () => {
  it('accepts a generator-shaped body', () => {
    const result = parseIngestReading({
      gateway_id: 'gw-0',
      device_id: 'dev-1',
      metric: 'temperature',
      value: 71.5,
      event_time: '2026-10-10T12:00:00.123456+00:00',
      sequence: 3,
    })

    expect(result.ok).toBe(true)
  })

  it('rejects a non-object body', () => {
    expect(parseIngestReading('nope')).toEqual({
      ok: false,
      errors: ['body must be a JSON object'],
    })
  })
})
