/**
 * Wire contract for POST /ingest/readings. Field names are snake_case because
 * that is what gateways (and telemetry_generator.py) send.
 */
export interface IngestReading {
  gateway_id: string
  device_id: string
  metric: string
  value: number
  /**
   * ISO-8601 timestamp. Accepted without an offset (treated as UTC), but always published with
   * one (`Z` or `±hh:mm`).
   */
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

/** Longest gateway_id, device_id or metric accepted (rule 2). */
export const MAX_ID_LENGTH = 256

// Year 0001-9999 only: Postgres and JS agree on that range, and year 0000 does not exist in ISO-8601
// as Postgres reads it. The offset is optional; a naive timestamp is treated as UTC.
const ISO_8601 =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d+)?(Z|([+-])(\d{2}):(\d{2}))?$/

// Postgres rejects a UTC offset beyond +-15:59 ("time zone displacement out of range").
const MAX_OFFSET_HOURS = 15

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

/**
 * Non-empty, at most MAX_ID_LENGTH UTF-16 code units, no NUL (Postgres text cannot hold \u0000).
 * Counting code units bounds each value at 3 UTF-8 bytes per unit, which keeps the 5-part
 * readings key under the btree index row limit.
 */
function isStorableId(value: unknown): value is string {
  return isNonEmptyString(value) && value.length <= MAX_ID_LENGTH && !value.includes('\u0000')
}

/** True when the Y-M-D h:m:s fields name a real calendar instant (no Feb 30, no hour 24). */
function isRealDateTime(fields: number[]): boolean {
  const [year, month, day, hour, minute, second] = fields as [
    number,
    number,
    number,
    number,
    number,
    number,
  ]
  // setUTCFullYear, unlike Date.UTC, does not map years 0-99 to 1900-1999.
  const date = new Date(0)
  date.setUTCFullYear(year, month - 1, day)
  date.setUTCHours(hour, minute, second)
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day &&
    date.getUTCHours() === hour &&
    date.getUTCMinutes() === minute &&
    date.getUTCSeconds() === second
  )
}

/**
 * Parses a strict ISO-8601 timestamp that Postgres can store. Returns it with an explicit offset
 * (a naive timestamp gains `Z`, its digits unchanged) or null when it is not a real instant.
 */
export function normalizeIsoTimestamp(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null
  }
  const match = ISO_8601.exec(value)
  if (!match) {
    return null
  }
  const fields = match.slice(1, 7).map(Number)
  if ((fields[0] ?? 0) < 1 || !isRealDateTime(fields)) {
    return null
  }
  const [, , , , , , , , zone, , offsetHours, offsetMinutes] = match
  if (zone === undefined) {
    return `${value}Z`
  }
  if (Number(offsetHours ?? 0) > MAX_OFFSET_HOURS || Number(offsetMinutes ?? 0) > 59) {
    return null
  }
  return value
}

export function isIsoTimestampWithOffset(value: unknown): value is string {
  return normalizeIsoTimestamp(value) === value
}

/** Validates an untrusted request body against the ingest contract. */
export function parseIngestReading(body: unknown): ParseResult<IngestReading> {
  if (!isRecord(body)) {
    return { ok: false, errors: ['body must be a JSON object'] }
  }

  const eventTime = normalizeIsoTimestamp(body.event_time)
  const idError = (field: string) =>
    `${field} must be a non-empty string of at most ${MAX_ID_LENGTH} characters without NUL`
  const errors = [
    isStorableId(body.gateway_id) ? null : idError('gateway_id'),
    isStorableId(body.device_id) ? null : idError('device_id'),
    isStorableId(body.metric) ? null : idError('metric'),
    typeof body.value === 'number' && Number.isFinite(body.value)
      ? null
      : 'value must be a finite number',
    eventTime !== null
      ? null
      : 'event_time must be a real ISO-8601 date-time with a year from 0001 to 9999',
    Number.isSafeInteger(body.sequence) ? null : 'sequence must be a safe integer',
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
      event_time: eventTime as string,
      sequence: body.sequence as number,
    },
  }
}
