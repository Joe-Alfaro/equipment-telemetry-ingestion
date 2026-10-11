import type { StreamEventMap, StreamEventName } from '@telemetry/shared'

type Listener = (event: MessageEvent<string>) => void

/**
 * Stand-in for the browser's EventSource, installed as the global `EventSource` for every web
 * test (see setup.ts). jsdom has no EventSource, and the SSE stream is the network boundary for
 * live updates, so tests replace it here rather than mocking app modules. The app just calls
 * `new EventSource('/api/stream')` as it would in a browser.
 *
 * Tests drive it with `latestEventSource().emit('device-updated', { deviceId })`, which
 * dispatches a MessageEvent whose `type` is the SSE event name and whose `data` is the JSON
 * payload, exactly like a real `event:`/`data:` frame.
 */
export class FakeEventSource {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSED = 2
  static instances: FakeEventSource[] = []

  readonly CONNECTING = 0
  readonly OPEN = 1
  readonly CLOSED = 2
  readonly url: string
  readonly withCredentials: boolean
  readyState = FakeEventSource.CONNECTING
  onopen: ((event: Event) => void) | null = null
  onmessage: Listener | null = null
  onerror: ((event: Event) => void) | null = null
  private readonly listeners = new Map<string, Set<Listener>>()

  constructor(url: string | URL, init?: EventSourceInit) {
    this.url = String(url)
    this.withCredentials = init?.withCredentials ?? false
    FakeEventSource.instances.push(this)
  }

  static reset() {
    FakeEventSource.instances = []
  }

  addEventListener(type: string, listener: Listener) {
    const set = this.listeners.get(type) ?? new Set<Listener>()
    set.add(listener)
    this.listeners.set(type, set)
  }

  removeEventListener(type: string, listener: Listener) {
    this.listeners.get(type)?.delete(listener)
  }

  close() {
    this.readyState = FakeEventSource.CLOSED
  }

  /** Simulates the connection opening. */
  open() {
    this.readyState = FakeEventSource.OPEN
    this.onopen?.(new Event('open'))
  }

  /** Simulates the server sending one named SSE event. Ignored once closed, like a real stream. */
  emit<K extends StreamEventName>(name: K, data: StreamEventMap[K]) {
    if (this.readyState === FakeEventSource.CLOSED) {
      return
    }
    const event = new MessageEvent(name, { data: JSON.stringify(data) })
    this.listeners.get(name)?.forEach((listener) => listener(event))
  }

  /** Simulates a dropped connection. */
  fail() {
    this.onerror?.(new Event('error'))
  }
}

/** The stream the app opened most recently that is still open. Throws if there is none. */
export function latestEventSource() {
  const open = FakeEventSource.instances.filter(
    (source) => source.readyState !== FakeEventSource.CLOSED,
  )
  const latest = open.at(-1)
  if (!latest) {
    throw new Error('the app has not opened an EventSource')
  }
  return latest
}
