import { TELEMETRY_EVENTS_CHANNEL, type Pool, type PoolClient } from '@telemetry/db'
import { STREAM_EVENT_NAMES, type StreamEvent } from '@telemetry/shared'
import { createKeyedThrottle } from './gateway-throttle'

export type StreamListener = (event: StreamEvent) => void

export interface EventRelay {
  /**
   * Subscribes `listener` to committed events. Resolves once the server is LISTENing, so any
   * commit after that is delivered. Returns the unsubscribe function.
   */
  subscribe(listener: StreamListener, onReset: () => void): Promise<() => void>
  /** Releases the LISTEN connection and pending timers. */
  close(): Promise<void>
}

export interface EventRelayOptions {
  /**
   * gateway-updated fires for every ingested message. Per gateway, relay the first one at once and
   * then at most one more per interval (trailing), so replays don't flood clients. 0 disables it.
   */
  gatewayEventIntervalMs: number
}

function parseEvent(payload: string | undefined): StreamEvent | null {
  try {
    const parsed: unknown = JSON.parse(payload ?? '')
    if (typeof parsed !== 'object' || parsed === null) {
      return null
    }
    const { event, data } = parsed as Record<string, unknown>
    const known = STREAM_EVENT_NAMES.some((name) => name === event)
    return known && typeof data === 'object' && data !== null ? (parsed as StreamEvent) : null
  } catch {
    return null
  }
}

/**
 * One shared LISTEN connection fanned out to every SSE client. It is opened lazily by the first
 * subscriber and kept open. If it fails, every subscriber is reset (their streams end and the
 * browser's EventSource reconnects and refetches) and the next subscriber opens a new one.
 */
export function createEventRelay(pool: Pool, { gatewayEventIntervalMs }: EventRelayOptions) {
  const listeners = new Map<StreamListener, () => void>()
  const state: {
    client: Promise<PoolClient> | null
    connected: PoolClient | null
    closed: boolean
  } = { client: null, connected: null, closed: false }

  function broadcast(event: StreamEvent) {
    listeners.forEach((_reset, listener) => listener(event))
  }

  const gatewayThrottle = createKeyedThrottle(gatewayEventIntervalMs, (gatewayId) =>
    broadcast({ event: 'gateway-updated', data: { gatewayId } }),
  )

  function relay(payload: string | undefined) {
    const event = parseEvent(payload)
    if (!event) {
      return
    }
    if (event.event === 'gateway-updated' && gatewayEventIntervalMs > 0) {
      gatewayThrottle.call(event.data.gatewayId)
      return
    }
    broadcast(event)
  }

  function reset(client: PoolClient, error: Error) {
    if (state.connected !== client) {
      return
    }
    state.client = null
    state.connected = null
    client.release(error)
    const resets = [...listeners.values()]
    listeners.clear()
    resets.forEach((onReset) => onReset())
  }

  async function connect(): Promise<PoolClient> {
    const client = await pool.connect()
    client.on('notification', (notification) => relay(notification.payload))
    client.on('error', (error) => reset(client, error))
    try {
      await client.query(`LISTEN ${TELEMETRY_EVENTS_CHANNEL}`)
    } catch (error) {
      client.release(error instanceof Error ? error : true)
      throw error
    }
    state.connected = client
    return client
  }

  async function subscribe(listener: StreamListener, onReset: () => void) {
    if (state.closed) {
      throw new Error('event relay is closed')
    }
    if (!state.client) {
      state.client = connect()
      // A failed connect must not poison later subscribers.
      state.client.catch(() => {
        state.client = null
      })
    }
    await state.client
    listeners.set(listener, onReset)
    return () => {
      listeners.delete(listener)
    }
  }

  async function close() {
    state.closed = true
    listeners.clear()
    gatewayThrottle.cancel()
    const client = state.client
    state.client = null
    state.connected = null
    if (!client) {
      return
    }
    await client.then(
      async (connected) => {
        await connected.query(`UNLISTEN ${TELEMETRY_EVENTS_CHANNEL}`).catch(() => {})
        connected.release()
      },
      () => {},
    )
  }

  return { subscribe, close } satisfies EventRelay
}
