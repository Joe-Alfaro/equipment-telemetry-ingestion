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

/**
 * A gateway's clock status from its readings (any order). The contract is documented in
 * clock.test.ts. Detection only: nothing is corrected.
 */
export function computeGatewayClock(
  samples: ClockSample[],
  options: ClockOptions = {},
): GatewayClock {
  void samples
  void options
  throw new Error('computeGatewayClock is not implemented yet')
}
