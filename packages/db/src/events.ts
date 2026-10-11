import type { StreamEvent } from '@telemetry/shared'
import type { PoolClient } from './pool'

/**
 * Postgres LISTEN/NOTIFY channel for live updates. Each notification payload is a
 * JSON-encoded `StreamEvent` from @telemetry/shared: `{"event":"device-updated","data":{"deviceId":"..."}}`.
 * Writers send it with `pg_notify` inside their transaction, so it is delivered only on commit.
 */
export const TELEMETRY_EVENTS_CHANNEL = 'telemetry_events'

/** Queues `events` on the client's current transaction; listeners receive them on COMMIT. */
export async function notifyEvents(client: PoolClient, events: StreamEvent[]): Promise<void> {
  if (events.length === 0) {
    return
  }
  await client.query('SELECT pg_notify($1, payload) FROM unnest($2::text[]) AS payload', [
    TELEMETRY_EVENTS_CHANNEL,
    events.map((event) => JSON.stringify(event)),
  ])
}
