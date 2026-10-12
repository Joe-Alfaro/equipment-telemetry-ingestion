import { useEffect, useState } from 'react'

/** How often charts slide with the clock when no new data arrives (rule 2). */
export const CLOCK_TICK_MS = 5_000

/** The current time in epoch ms, refreshed every CLOCK_TICK_MS. */
export function useNow() {
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), CLOCK_TICK_MS)
    return () => clearInterval(id)
  }, [])

  return now
}
