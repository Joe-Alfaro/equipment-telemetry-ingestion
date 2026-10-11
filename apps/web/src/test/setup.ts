import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, beforeEach, vi } from 'vitest'
import { FakeEventSource } from './fakeEventSource'
import { server } from './server'

// Any request without a handler fails the test, so network use is always explicit.
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
// jsdom has no EventSource; the SSE boundary is replaced with a controllable fake.
beforeEach(() => {
  vi.stubGlobal('EventSource', FakeEventSource)
})
afterEach(() => {
  server.resetHandlers()
  cleanup()
  FakeEventSource.reset()
  vi.unstubAllGlobals()
})
afterAll(() => server.close())
