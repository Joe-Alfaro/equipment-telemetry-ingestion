import type { Reading } from '@telemetry/shared'

/** The charts show the last 10 minutes (metric charts, rule 2). */
export const WINDOW_MS = 600_000

/** No reading for over 30 s is a gap; the same value as LATE_THRESHOLD_MS (rule 5). */
export const GAP_MS = 30_000

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

/** Rule 5: one metric's readings in the window, split into segments at gaps. */
export function buildSeries(
  _readings: Reading[],
  _metric: string,
  _options: SeriesOptions,
): Series {
  throw new Error('not implemented')
}

/** Rule 6: the x domain in epoch ms, `[now - windowMs, max(now, latest event_time)]`. */
export function xDomain(
  _series: Series,
  _options: Pick<SeriesOptions, 'now' | 'windowMs'>,
): [number, number] {
  throw new Error('not implemented')
}

/** Rule 6: the y domain, the data's extent padded by about 10% (never zero-based). */
export function yDomain(_series: Series): [number, number] {
  throw new Error('not implemented')
}
