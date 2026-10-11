import type { ReadingMessage } from '@telemetry/shared'
import { describe, expect, it } from 'vitest'
import { decodeReadingMessage } from './handler'

/*
 * CONTRACT (gateway clock check rule 2): the consumer carries the api's naive marker from the
 * broker envelope to processReading. An envelope published before the marker existed decodes as
 * naiveTime: false.
 */

const reading = {
  gateway_id: 'gw-0',
  device_id: 'dev-1',
  metric: 'temperature',
  value: 70,
  event_time: '2026-10-10T17:30:00Z',
  sequence: 0,
}
const receivedAt = '2026-10-10T12:00:00.000Z'

function encode(envelope: Record<string, unknown>): Buffer {
  return Buffer.from(JSON.stringify(envelope), 'utf8')
}

describe('decodeReadingMessage: the naive marker (rule 2)', () => {
  it.fails.each([true, false])('keeps naiveTime: %s', (naiveTime) => {
    const expected: ReadingMessage = { reading, receivedAt, naiveTime }

    expect(decodeReadingMessage(encode({ reading, receivedAt, naiveTime }))).toStrictEqual(expected)
  })

  it.fails('decodes an envelope without the marker as naiveTime: false', () => {
    const expected: ReadingMessage = { reading, receivedAt, naiveTime: false }

    expect(decodeReadingMessage(encode({ reading, receivedAt }))).toStrictEqual(expected)
  })
})
