import type { GatewayClock } from '@telemetry/shared'

/** One stored reading as the clock check sees it. */
export interface ClockSample {
  /** ISO-8601 event_time as stored. */
  eventTime: string
  /** ISO-8601 time the api received the reading. */
  receivedAt: string
  /** The gateway sent event_time with no UTC offset. */
  naiveTime: boolean
}

export interface ClockOptions {
  /** `ahead` when the median skew is strictly greater. Default DEFAULT_CLOCK_SKEW_THRESHOLD_MS. */
  thresholdMs?: number
}

/** Default CLOCK_SKEW_THRESHOLD_MS; the same as the consumer's FUTURE_SKEW_MS default. */
export const DEFAULT_CLOCK_SKEW_THRESHOLD_MS = 60_000

/** Rule 3: the window is the last WINDOW_SIZE readings by received_at; fewer than MIN_SAMPLES is unknown. */
export const CLOCK_WINDOW_SIZE = 20
const MIN_SAMPLES = 5

const QUARTER_HOUR_MS = 15 * 60_000
const LOCAL_TIME_TOLERANCE_MS = 5 * 60_000
const LOCAL_TIME_SHARE = 0.8

function skewMs({ eventTime, receivedAt }: ClockSample): number {
  return Date.parse(eventTime) - Date.parse(receivedAt)
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  if (sorted.length % 2 === 1) {
    return sorted[middle] as number
  }
  return ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2
}

/**
 * The non-zero multiple of 15 min that at least 80% of the naive skews sit within 5 min of, or
 * null. The tolerance is under half of 15 min, so each skew is near at most one multiple.
 */
function localTimeOffset(naiveSkews: number[]): number | null {
  if (naiveSkews.length < MIN_SAMPLES) {
    return null
  }
  const counts = naiveSkews.reduce((acc, skew) => {
    const multiple = Math.round(skew / QUARTER_HOUR_MS) * QUARTER_HOUR_MS
    if (multiple === 0 || Math.abs(skew - multiple) > LOCAL_TIME_TOLERANCE_MS) {
      return acc
    }
    return acc.set(multiple, (acc.get(multiple) ?? 0) + 1)
  }, new Map<number, number>())
  const best = [...counts.entries()].reduce<[number, number] | null>(
    (top, entry) => (top === null || entry[1] > top[1] ? entry : top),
    null,
  )
  if (best === null || best[1] < LOCAL_TIME_SHARE * naiveSkews.length) {
    return null
  }
  return best[0]
}

/**
 * A gateway's clock status from its readings (any order). The contract is documented in
 * clock.test.ts. Detection only: nothing is corrected.
 */
export function computeGatewayClock(
  samples: ClockSample[],
  { thresholdMs = DEFAULT_CLOCK_SKEW_THRESHOLD_MS }: ClockOptions = {},
): GatewayClock {
  const window = [...samples]
    .sort((a, b) => Date.parse(b.receivedAt) - Date.parse(a.receivedAt))
    .slice(0, CLOCK_WINDOW_SIZE)
  if (window.length < MIN_SAMPLES) {
    return { status: 'unknown', offsetMs: null, samples: window.length }
  }

  const offset = localTimeOffset(window.filter((sample) => sample.naiveTime).map(skewMs))
  if (offset !== null) {
    return { status: 'local-time', offsetMs: offset, samples: window.length }
  }

  // A negative median is never flagged: a replayed backlog and network delay look the same.
  const medianSkew = median(window.map(skewMs))
  if (medianSkew > thresholdMs) {
    return {
      status: 'ahead',
      offsetMs: Math.round(medianSkew / 1_000) * 1_000,
      samples: window.length,
    }
  }
  return { status: 'ok', offsetMs: null, samples: window.length }
}
