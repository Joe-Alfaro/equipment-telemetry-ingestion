import type { ReadingMessage } from '@telemetry/shared'
import type { Pool } from './pool'

export type ProcessStatus = 'inserted' | 'duplicate' | 'conflict'

export interface ProcessOutcome {
  status: ProcessStatus
  /** Set only for `inserted`: processed_at - event_time > lateThresholdMs. */
  late: boolean
  /** Set only for `inserted`: event_time is older than the stored current_state for its (device, metric). */
  outOfOrder: boolean
  /** This transaction created the devices row (first sighting). */
  deviceDiscovered: boolean
  /** This reading replaced (or created) current_state for its (device, metric). */
  currentStateUpdated: boolean
}

export interface ProcessOptions {
  /** Processing time: stored as readings.processed_at and current_state.updated_at. */
  now: Date
  lateThresholdMs: number
}

/**
 * Applies one broker message in ONE transaction and resolves after COMMIT.
 * The full contract is documented in processing.integration.test.ts.
 */
export async function processReading(
  _pool: Pool,
  _message: ReadingMessage,
  _options: ProcessOptions,
): Promise<ProcessOutcome> {
  throw new Error('not implemented')
}
