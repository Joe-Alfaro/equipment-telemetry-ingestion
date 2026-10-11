import { useEffect, useState } from 'react'

export type Fetcher<T> = (url: string, signal: AbortSignal) => Promise<T>

interface FetchState<T> {
  url: string
  data?: T
  failed: boolean
}

export interface FetchResult<T> {
  data?: T
  /** The latest request failed. Data from an earlier successful request is kept. */
  failed: boolean
  /** Nothing has come back yet for this URL. */
  loading: boolean
}

/**
 * Fetches `url` and refetches whenever `version` changes. Earlier data stays on screen while a
 * refetch is in flight, so live updates don't flash a loading state; a newer request aborts the
 * older one, so responses can't land out of order.
 */
export function useFetch<T>(url: string, version: number, fetcher: Fetcher<T>): FetchResult<T> {
  const [state, setState] = useState<FetchState<T> | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    fetcher(url, controller.signal).then(
      (data) => {
        if (!controller.signal.aborted) {
          setState({ url, data, failed: false })
        }
      },
      () => {
        if (!controller.signal.aborted) {
          setState((previous) => ({
            url,
            data: previous?.url === url ? previous.data : undefined,
            failed: true,
          }))
        }
      },
    )
    return () => controller.abort()
  }, [url, version, fetcher])

  if (state?.url !== url) {
    return { failed: false, loading: true }
  }
  return { data: state.data, failed: state.failed, loading: false }
}
