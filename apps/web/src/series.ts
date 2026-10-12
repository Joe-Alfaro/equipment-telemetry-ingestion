import type { Reading } from '@telemetry/shared'

/** The charts show the last 10 minutes (metric charts, rule 2). */
export const WINDOW_MS = 600_000

/** No reading for over 30 s is a gap; the same value as LATE_THRESHOLD_MS (rule 5). */
export const GAP_MS = 30_000

/** `status` is a state, not a trend: it keeps its plain value and never gets a chart (rule 15). */
export function isCharted(metric: string) {
  return metric !== 'status'
}

/** One plotted reading: `time` is its event time in epoch ms. */
export interface Point {
  time: number
  value: number
  reading: Reading
}

export interface Series {
  /** Runs of readings with no gap over gapMs between neighbours, in event-time order. */
  segments: Point[][]
  /** Greatest (event_time, gateway_id, sequence), like current state; null when empty. */
  latest: Reading | null
  min: number | null
  max: number | null
}

export interface SeriesOptions {
  /** Epoch ms. */
  now: number
  windowMs: number
  gapMs: number
}

/** Event-time order with the current-state tie-break: gateway_id (code units), then sequence. */
function comparePoints(a: Point, b: Point) {
  if (a.time !== b.time) {
    return a.time - b.time
  }
  if (a.reading.gatewayId !== b.reading.gatewayId) {
    return a.reading.gatewayId < b.reading.gatewayId ? -1 : 1
  }
  return a.reading.sequence - b.reading.sequence
}

/** Rule 5: one metric's readings in the window, split into segments at gaps. */
export function buildSeries(
  readings: Reading[],
  metric: string,
  { now, windowMs, gapMs }: SeriesOptions,
): Series {
  const start = now - windowMs
  const points = readings
    .filter((reading) => reading.metric === metric)
    .map((reading) => ({ time: Date.parse(reading.eventTime), value: reading.value, reading }))
    // Readings beyond now (future) are kept, so the x domain can stretch to show them (rule 4).
    .filter((point) => point.time >= start)
    .sort(comparePoints)

  const last = points.at(-1)
  if (!last) {
    return { segments: [], latest: null, min: null, max: null }
  }
  const segments = points.reduce<Point[][]>((runs, point, index) => {
    const previous = points[index - 1]
    if (!previous || point.time - previous.time > gapMs) {
      runs.push([point])
      return runs
    }
    runs.at(-1)?.push(point)
    return runs
  }, [])
  const values = points.map((point) => point.value)
  return {
    segments,
    latest: last.reading,
    min: Math.min(...values),
    max: Math.max(...values),
  }
}

/** Rule 6: the x domain in epoch ms, `[now - windowMs, max(now, latest event_time)]`. */
export function xDomain(
  series: Series,
  { now, windowMs }: Pick<SeriesOptions, 'now' | 'windowMs'>,
): [number, number] {
  const latest = series.latest ? Date.parse(series.latest.eventTime) : now
  return [now - windowMs, Math.max(now, latest)]
}

/** One x domain shared by several charts: the window, stretched to the latest future reading. */
export function chartDomain(series: Series[], now: number): [number, number] {
  return series.reduce<[number, number]>(
    ([start, end], one) => [start, Math.max(end, xDomain(one, { now, windowMs: WINDOW_MS })[1])],
    [now - WINDOW_MS, now],
  )
}

/** The y extent is padded by this share of the range on each side. */
const Y_PAD = 0.1

/** Rule 6: the y domain, the data's extent padded by about 10% (never zero-based). */
export function yDomain(series: Series): [number, number] {
  const { min, max } = series
  if (min === null || max === null) {
    return [0, 1]
  }
  // A flat series has no range to pad by, so it is padded by 10% of its value (or 1 at zero).
  const pad = max > min ? (max - min) * Y_PAD : Math.abs(min) * Y_PAD || 1
  return [min - pad, max + pad]
}

/** Integers from `first` to `last` inclusive (empty when last < first). */
function range(first: number, last: number) {
  return Array.from({ length: Math.max(0, last - first + 1) }, (_, index) => first + index)
}

interface YTicks {
  values: number[]
  step: number
  /** The y domain to draw with: the given one, or widened to whole steps (see yTicks). */
  domain: [number, number]
}

/**
 * Clean y ticks for the history page: 4-5 ticks on a 1/2/2.5/5 step. When no step fits 4-5 ticks
 * inside the padded domain, the domain is widened outward to whole steps (a "nice" domain).
 */
export function yTicks([low, high]: [number, number]): YTicks {
  const base = 10 ** Math.floor(Math.log10((high - low) / 5))
  const steps = [1, 2, 2.5, 5, 10, 20, 25, 50].map((multiple) => multiple * base)
  const ticksFor = (from: number, to: number, step: number) =>
    range(Math.ceil(from / step - 1e-9), Math.floor(to / step + 1e-9)).map((index) =>
      // Rounded so 0.1 * 3 prints as 0.3, not 0.30000000000000004.
      Number((index * step).toPrecision(12)),
    )
  const fits = (count: number) => count >= 4 && count <= 5
  const inside = steps.find((step) => fits(ticksFor(low, high, step).length))
  if (inside !== undefined) {
    return { values: ticksFor(low, high, inside), step: inside, domain: [low, high] }
  }
  const nice = (step: number): [number, number] => [
    Math.floor(low / step) * step,
    Math.ceil(high / step) * step,
  ]
  const step =
    steps.find((candidate) => fits(ticksFor(...nice(candidate), candidate).length)) ??
    steps.at(-1) ??
    1
  const domain = nice(step)
  return { values: ticksFor(...domain, step), step, domain }
}

/** X ticks on the history page: every `everyMs` (2 minutes) of clock time inside the domain. */
export function xTicks([start, end]: [number, number], everyMs = 120_000) {
  return range(Math.ceil(start / everyMs), Math.floor(end / everyMs)).map(
    (index) => index * everyMs,
  )
}
