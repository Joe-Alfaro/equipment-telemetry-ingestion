import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, beforeEach, vi } from 'vitest'
import { FakeEventSource } from './fakeEventSource'
import { server } from './server'

/** jsdom has no ResizeObserver; responsive charts only need it to exist. It never reports. */
class StubResizeObserver implements ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

// Any request without a handler fails the test, so network use is always explicit.
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
// jsdom has no EventSource; the SSE boundary is replaced with a controllable fake.
beforeEach(() => {
  vi.stubGlobal('EventSource', FakeEventSource)
  vi.stubGlobal('ResizeObserver', StubResizeObserver)
})
afterEach(() => {
  server.resetHandlers()
  cleanup()
  FakeEventSource.reset()
  vi.unstubAllGlobals()
  // jsdom keeps the URL between tests in a file; every test starts on the board unless it says so.
  window.history.replaceState(null, '', '/')
})
afterAll(() => server.close())
