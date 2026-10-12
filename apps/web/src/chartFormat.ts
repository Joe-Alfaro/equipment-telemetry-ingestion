const valueFormat = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2, useGrouping: false })

/** A metric value as charts print it: at most two decimals, no grouping ("72.4", "0.31"). */
export function formatValue(value: number) {
  return valueFormat.format(value)
}

const clockFormat = new Intl.DateTimeFormat(undefined, {
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
})

const tickFormat = new Intl.DateTimeFormat(undefined, {
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
})

/** Local wall-clock time with seconds, "11:59:20". */
export function formatClock(time: number) {
  return clockFormat.format(time)
}

/** Local wall-clock time for an x tick, "11:52". */
export function formatClockTick(time: number) {
  return tickFormat.format(time)
}

/** A y tick, with just enough decimals for its step ("0.25", "70"). */
export function formatTick(value: number, step: number) {
  const decimals = Math.max(0, Math.ceil(-Math.log10(step) - 1e-9))
  // A 2.5 step needs one decimal more than its magnitude suggests.
  const scaled = step * 10 ** decimals
  const fixed = Math.abs(scaled - Math.round(scaled)) < 1e-9 ? decimals : decimals + 1
  return new Intl.NumberFormat('en-US', {
    minimumFractionDigits: fixed,
    maximumFractionDigits: fixed,
    useGrouping: false,
  }).format(value)
}
