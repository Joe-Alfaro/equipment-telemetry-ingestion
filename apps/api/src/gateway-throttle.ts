/**
 * Per-key leading + trailing throttle: the first call for a key fires at once; further calls
 * within `intervalMs` collapse into one call when the window closes. Used for gateway-updated,
 * which the consumer emits for every message, so a replay can't flood SSE clients.
 */
export function createKeyedThrottle(intervalMs: number, fire: (key: string) => void) {
  const windows = new Map<string, { timer: NodeJS.Timeout; pending: boolean }>()

  function call(key: string) {
    const window = windows.get(key)
    if (window) {
      window.pending = true
      return
    }
    fire(key)
    const timer = setTimeout(() => {
      const pending = windows.get(key)?.pending ?? false
      windows.delete(key)
      if (pending) {
        call(key)
      }
    }, intervalMs)
    timer.unref()
    windows.set(key, { timer, pending: false })
  }

  function cancel() {
    windows.forEach(({ timer }) => clearTimeout(timer))
    windows.clear()
  }

  return { call, cancel }
}
