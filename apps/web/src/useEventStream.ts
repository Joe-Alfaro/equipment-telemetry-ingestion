import type { StreamEvent, StreamEventMap } from '@telemetry/shared'
import { STREAM_EVENT_NAMES } from '@telemetry/shared'
import { useEffect, useRef, useState } from 'react'

export type StreamStatus = 'connecting' | 'live' | 'reconnecting'

export interface StreamHandlers {
  /** Events received during one batching window, in arrival order. */
  onEvents(events: StreamEvent[]): void
  /** The stream reconnected; events may have been missed while it was down. */
  onReconnect(): void
}

/**
 * Bursts (a gateway replaying its backlog) send many events in a few milliseconds. Delivering
 * them in short batches keeps refetches to a handful per second instead of one per reading.
 */
const BATCH_MS = 100

/** Subscribes to GET /api/stream for the lifetime of the component. */
export function useEventStream(handlers: StreamHandlers): StreamStatus {
  const [status, setStatus] = useState<StreamStatus>('connecting')
  const handlersRef = useRef(handlers)

  useEffect(() => {
    handlersRef.current = handlers
  })

  useEffect(() => {
    const source = new EventSource('/api/stream')
    const batch: StreamEvent[] = []
    const timer: { id?: ReturnType<typeof setTimeout> } = {}
    const connection = { dropped: false }

    function flush() {
      timer.id = undefined
      handlersRef.current.onEvents(batch.splice(0))
    }

    STREAM_EVENT_NAMES.forEach((name) => {
      source.addEventListener(name, (message: MessageEvent<string>) => {
        const data = JSON.parse(message.data) as StreamEventMap[typeof name]
        batch.push({ event: name, data } as StreamEvent)
        timer.id ??= setTimeout(flush, BATCH_MS)
      })
    })
    source.onopen = () => {
      setStatus('live')
      if (connection.dropped) {
        connection.dropped = false
        handlersRef.current.onReconnect()
      }
    }
    // EventSource reconnects on its own; this only tracks that it happened.
    source.onerror = () => {
      connection.dropped = true
      setStatus('reconnecting')
    }

    return () => {
      clearTimeout(timer.id)
      source.close()
    }
  }, [])

  return status
}
