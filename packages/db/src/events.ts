/**
 * Postgres LISTEN/NOTIFY channel for live updates. Each notification payload is a
 * JSON-encoded `StreamEvent` from @telemetry/shared: `{"event":"device-updated","data":{"deviceId":"..."}}`.
 * Writers send it with `pg_notify` inside their transaction, so it is delivered only on commit.
 */
export const TELEMETRY_EVENTS_CHANNEL = 'telemetry_events'
