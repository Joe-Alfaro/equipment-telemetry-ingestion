import { isIsoTimestampWithOffset, parseIngestReading } from '@telemetry/shared'
import { describe, expect, it } from 'vitest'
import { createHarness, isNewDevice, runFor, sentReadings } from '../test/fakes'

describe('simulator: wire contract (rule 1)', () => {
  it.fails(
    'sends only bodies that pass parseIngestReading, with an explicit offset on event_time',
    async () => {
      // Exercise every path: steady traffic, outage backlog and resends, and new devices.
      const { simulator, clock, http } = createHarness({
        intervalMs: 1000,
        outageEveryMs: 20_000,
        outageMs: 5000,
        newDeviceEveryMs: 15_000,
        maxNewDevices: 2,
      })

      await runFor(simulator, clock, 120_000)

      const sent = sentReadings(http)
      expect(sent.some((post) => isNewDevice(post.reading.device_id))).toBe(true)
      sent.forEach(({ body }) => {
        const raw = JSON.parse(body) as Record<string, unknown>
        expect(Object.keys(raw).sort()).toEqual(
          ['device_id', 'event_time', 'gateway_id', 'metric', 'sequence', 'value'].sort(),
        )
        expect(isIsoTimestampWithOffset(raw.event_time)).toBe(true)
        expect(raw.event_time).toMatch(/Z$/)
        // Already normalized: parsing changes nothing.
        expect(parseIngestReading(raw)).toEqual({ ok: true, value: raw })
      })
    },
  )
})
