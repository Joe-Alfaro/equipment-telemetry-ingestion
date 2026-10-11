import type { ClockWarning } from '@telemetry/shared'

const timestampFormat = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'short',
  timeStyle: 'medium',
})

export function formatTimestamp(iso: string) {
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? iso : timestampFormat.format(date)
}

const MINUTE_MS = 60_000
const HOUR_MS = 60 * MINUTE_MS

/** "+5:30", "−5" (U+2212 minus) or "+9" for a UTC offset in ms. */
function formatUtcOffset(offsetMs: number) {
  const sign = offsetMs < 0 ? '−' : '+'
  const hours = Math.floor(Math.abs(offsetMs) / HOUR_MS)
  const minutes = Math.round((Math.abs(offsetMs) % HOUR_MS) / MINUTE_MS)
  if (minutes === 0) {
    return `${sign}${hours}`
  }
  return `${sign}${hours}:${String(minutes).padStart(2, '0')}`
}

/** "Clock ahead ~2m", "Clock ahead ~45s" or "Local time? UTC+5:30" (rule 6). */
export function formatClockWarning({ status, offsetMs }: ClockWarning) {
  if (status === 'local-time') {
    return `Local time? UTC${formatUtcOffset(offsetMs)}`
  }
  const seconds = Math.round(offsetMs / 1_000)
  if (seconds < 60) {
    return `Clock ahead ~${seconds}s`
  }
  return `Clock ahead ~${Math.round(offsetMs / MINUTE_MS)}m`
}
