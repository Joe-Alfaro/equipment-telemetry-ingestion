/**
 * Wire contract for POST /ingest/readings. Field names are snake_case because
 * that is what gateways (and telemetry_generator.py) send.
 */
export interface IngestReading {
  gateway_id: string
  device_id: string
  metric: string
  value: number
  /** ISO-8601 timestamp with an explicit offset (`Z` or `±hh:mm`). */
  event_time: string
  sequence: number
}

/** Envelope the api publishes to the broker and the consumer receives. */
export interface ReadingMessage {
  reading: IngestReading
  /** ISO-8601 time the api accepted the reading. */
  receivedAt: string
}

export type ParseResult<T> = { ok: true; value: T } | { ok: false; errors: string[] }

const ISO_8601_WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

export function isIsoTimestampWithOffset(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    ISO_8601_WITH_OFFSET.test(value) &&
    !Number.isNaN(Date.parse(value))
  )
}

/** Validates an untrusted request body against the ingest contract. */
export function parseIngestReading(body: unknown): ParseResult<IngestReading> {
  if (!isRecord(body)) {
    return { ok: false, errors: ['body must be a JSON object'] }
  }

  const errors = [
    isNonEmptyString(body.gateway_id) ? null : 'gateway_id must be a non-empty string',
    isNonEmptyString(body.device_id) ? null : 'device_id must be a non-empty string',
    isNonEmptyString(body.metric) ? null : 'metric must be a non-empty string',
    typeof body.value === 'number' && Number.isFinite(body.value)
      ? null
      : 'value must be a finite number',
    isIsoTimestampWithOffset(body.event_time)
      ? null
      : 'event_time must be an ISO-8601 timestamp with an offset',
    Number.isSafeInteger(body.sequence) ? null : 'sequence must be an integer',
  ].filter((error): error is string => error !== null)

  if (errors.length > 0) {
    return { ok: false, errors }
  }

  return {
    ok: true,
    value: {
      gateway_id: body.gateway_id as string,
      device_id: body.device_id as string,
      metric: body.metric as string,
      value: body.value as number,
      event_time: body.event_time as string,
      sequence: body.sequence as number,
    },
  }
}
