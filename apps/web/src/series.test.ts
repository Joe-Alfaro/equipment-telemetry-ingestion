import type { Reading } from '@telemetry/shared'
import { describe, expect, it } from 'vitest'
import { buildSeries, GAP_MS, WINDOW_MS, xDomain, yDomain, type Series } from './series'
import { reading } from './test/fakeApi'

// Metric charts, rules 4-6. `now` is injected, so nothing here depends on the real clock.
const NOW = Date.parse('2026-10-10T12:00:00.000Z')
const OPTIONS = { now: NOW, windowMs: WINDOW_MS, gapMs: GAP_MS }

/** A temperature reading `secondsAgo` before NOW (negative = in the future). */
function at(secondsAgo: number, overrides: Partial<Reading> = {}): Reading {
  return reading({
    deviceId: 'dev-1',
    eventTime: new Date(NOW - Math.round(secondsAgo * 1_000)).toISOString(),
    ...overrides,
  })
}

function times(series: Series) {
  return series.segments.map((segment) => segment.map((point) => (NOW - point.time) / 1_000))
}

describe('the window and gap constants', () => {
  it('are 10 minutes and 30 seconds', () => {
    expect(WINDOW_MS).toBe(600_000)
    expect(GAP_MS).toBe(30_000)
  })
})

describe('buildSeries (rule 5)', () => {
  it('keeps only the requested metric, sorted by event time', () => {
    const series = buildSeries(
      [
        at(10, { value: 3, sequence: 3 }),
        at(30, { value: 1, sequence: 1 }),
        at(20, { metric: 'vibration', value: 99 }),
        at(20, { value: 2, sequence: 2 }),
      ],
      'temperature',
      OPTIONS,
    )

    expect(times(series)).toEqual([[30, 20, 10]])
    expect(series.segments.flat().map((point) => point.value)).toEqual([1, 2, 3])
    expect(series.segments.flat().map((point) => point.reading.sequence)).toEqual([1, 2, 3])
  })

  it('does not split when consecutive readings are exactly gapMs apart', () => {
    const series = buildSeries([at(100), at(70), at(40)], 'temperature', OPTIONS)

    expect(times(series)).toEqual([[100, 70, 40]])
  })

  it('splits wherever consecutive readings are more than gapMs apart', () => {
    const series = buildSeries(
      [at(200), at(190), at(159.999), at(129.999), at(50)],
      'temperature',
      OPTIONS,
    )

    expect(times(series)).toEqual([[200, 190], [159.999, 129.999], [50]])
  })

  it('splits at gapMs + 1 ms', () => {
    const series = buildSeries(
      [
        reading({ deviceId: 'dev-1', eventTime: new Date(NOW - 60_000).toISOString() }),
        reading({
          deviceId: 'dev-1',
          eventTime: new Date(NOW - 60_000 + GAP_MS + 1).toISOString(),
        }),
      ],
      'temperature',
      OPTIONS,
    )

    expect(series.segments).toHaveLength(2)
    expect(series.segments.map((segment) => segment.length)).toEqual([1, 1])
  })

  it('keeps a lone reading as a one-point segment', () => {
    const series = buildSeries([at(300, { value: 7 })], 'temperature', OPTIONS)

    expect(series.segments).toEqual([[expect.objectContaining({ value: 7, time: NOW - 300_000 })]])
    expect(series.latest?.value).toBe(7)
    expect(series.min).toBe(7)
    expect(series.max).toBe(7)
  })

  it('clips to the window, keeping a reading exactly windowMs old', () => {
    const series = buildSeries(
      [at(600.001, { value: 100 }), at(600, { value: 1 }), at(590, { value: 2 })],
      'temperature',
      OPTIONS,
    )

    expect(times(series)).toEqual([[600, 590]])
    expect(series.min).toBe(1)
    expect(series.max).toBe(2)
  })

  it('keeps readings beyond now (future) instead of dropping them', () => {
    const series = buildSeries(
      [at(10, { value: 1 }), at(-90, { value: 2, future: true, sequence: 2 })],
      'temperature',
      OPTIONS,
    )

    expect(times(series)).toEqual([[10], [-90]])
    expect(series.latest?.value).toBe(2)
    expect(series.max).toBe(2)
  })

  it('reports the min and max of the windowed readings', () => {
    const series = buildSeries(
      [at(30, { value: 68.1 }), at(20, { value: 75.2 }), at(10, { value: 72.4 })],
      'temperature',
      OPTIONS,
    )

    expect(series.min).toBe(68.1)
    expect(series.max).toBe(75.2)
  })

  it('breaks event-time ties for latest by gateway_id, then sequence (like current state)', () => {
    const tied = [
      at(5, { gatewayId: 'gw-b', sequence: 1, value: 2 }),
      at(5, { gatewayId: 'gw-b', sequence: 9, value: 3 }),
      at(5, { gatewayId: 'gw-a', sequence: 50, value: 1 }),
    ]

    expect(buildSeries(tied, 'temperature', OPTIONS).latest?.value).toBe(3)
    expect(buildSeries([...tied].reverse(), 'temperature', OPTIONS).latest?.value).toBe(3)
  })

  it('is empty when nothing is in the window', () => {
    expect(buildSeries([at(601)], 'temperature', OPTIONS)).toEqual({
      segments: [],
      latest: null,
      min: null,
      max: null,
    })
  })
})

describe('xDomain (rules 4 and 6)', () => {
  it('spans the window ending now', () => {
    const series = buildSeries([at(10)], 'temperature', OPTIONS)

    expect(xDomain(series, OPTIONS)).toEqual([NOW - WINDOW_MS, NOW])
  })

  it('extends past now to the latest future reading', () => {
    const series = buildSeries([at(10), at(-90, { future: true })], 'temperature', OPTIONS)

    expect(xDomain(series, OPTIONS)).toEqual([NOW - WINDOW_MS, NOW + 90_000])
  })
})

describe('yDomain (rule 6)', () => {
  it('pads the data extent by about 10% and is not zero-based', () => {
    const series = buildSeries(
      [at(20, { value: 70 }), at(10, { value: 80 })],
      'temperature',
      OPTIONS,
    )

    const [low, high] = yDomain(series)

    expect(low).toBeLessThan(70)
    expect(high).toBeGreaterThan(80)
    expect(low).toBeGreaterThan(60)
    expect(70 - low).toBeGreaterThanOrEqual(0.5)
    expect(70 - low).toBeLessThanOrEqual(1.5)
    expect(high - 80).toBeGreaterThanOrEqual(0.5)
    expect(high - 80).toBeLessThanOrEqual(1.5)
  })

  it.each([72.4, 0, -3])('gives a flat series at %d a finite symmetric pad', (value) => {
    const series = buildSeries([at(20, { value }), at(10, { value })], 'temperature', OPTIONS)

    const [low, high] = yDomain(series)

    expect(Number.isFinite(low)).toBe(true)
    expect(Number.isFinite(high)).toBe(true)
    expect(low).toBeLessThan(value)
    expect(high).toBeGreaterThan(value)
    expect(high - value).toBeCloseTo(value - low)
  })
})
