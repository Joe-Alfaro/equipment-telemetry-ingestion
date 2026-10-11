import { vi } from 'vitest'
import type { Mock } from 'vitest'
import type { IngestReading } from '@telemetry/shared'
import type { SimulatorConfig } from '../src/config'
import type { Rng } from '../src/rng'
import { createSimulator } from '../src/simulator'
import type { Clock, HttpClient, HttpResponse, Logger, Simulator } from '../src/simulator'

export const T0 = Date.parse('2026-10-11T12:00:00.000Z')

/** Effectively "never" for episode intervals a test doesn't exercise. */
export const NEVER_MS = 1e12

export interface FakeClock extends Clock {
  advance(ms: number): void
}

export function createFakeClock(start = T0): FakeClock {
  const state = { now: start }
  return {
    now: () => state.now,
    advance: (ms) => {
      state.now += ms
    },
  }
}

/** mulberry32: a tiny seeded PRNG, so tests don't depend on the simulator's own createRng. */
export function createSeededRng(seed: number): Rng {
  const state = { a: seed >>> 0 }
  return {
    next: () => {
      state.a = (state.a + 0x6d2b79f5) >>> 0
      const t1 = Math.imul(state.a ^ (state.a >>> 15), state.a | 1)
      const t2 = (t1 + Math.imul(t1 ^ (t1 >>> 7), t1 | 61)) ^ t1
      return ((t2 ^ (t2 >>> 14)) >>> 0) / 4294967296
    },
  }
}

export interface PostRecord {
  url: string
  body: string
  /** Fake-clock time of the attempt. */
  at: number
  /** HTTP status, or null when the attempt failed with a network error. */
  status: number | null
}

/** What the fake api does with one attempt: an HTTP status, or 'network-error' to reject. */
export type Responder = (attempt: {
  body: string
  at: number
  attemptOfBody: number
}) => number | 'network-error'

export interface FakeHttp extends HttpClient {
  posts: PostRecord[]
}

export function createFakeHttp(clock: Clock, responder: Responder = () => 202): FakeHttp {
  const posts: PostRecord[] = []
  return {
    posts,
    post: async (url, body): Promise<HttpResponse> => {
      const attemptOfBody = posts.filter((post) => post.body === body).length
      const outcome = responder({ body, at: clock.now(), attemptOfBody })
      if (outcome === 'network-error') {
        posts.push({ url, body, at: clock.now(), status: null })
        throw new Error('connect ECONNREFUSED')
      }
      posts.push({ url, body, at: clock.now(), status: outcome })
      return { status: outcome }
    },
  }
}

export interface FakeLogger extends Logger {
  info: Mock<Logger['info']>
  warn: Mock<Logger['warn']>
  error: Mock<Logger['error']>
}

export function createFakeLogger(): FakeLogger {
  return {
    info: vi.fn<Logger['info']>(),
    warn: vi.fn<Logger['warn']>(),
    error: vi.fn<Logger['error']>(),
  }
}

export function testConfig(overrides: Partial<SimulatorConfig> = {}): SimulatorConfig {
  return {
    apiUrl: 'http://api.test:8080',
    intervalMs: 2000,
    outageEveryMs: NEVER_MS,
    outageMs: 60_000,
    newDeviceEveryMs: NEVER_MS,
    maxNewDevices: 10,
    seed: 'test',
    ...overrides,
  }
}

/** Calls tick() at T, T+step, ... for `durationMs`, advancing the fake clock between ticks. */
export async function runFor(
  simulator: Simulator,
  clock: FakeClock,
  durationMs: number,
  stepMs = 100,
): Promise<void> {
  const steps = Math.floor(durationMs / stepMs)
  await Array.from({ length: steps }).reduce<Promise<void>>(async (previous) => {
    await previous
    await simulator.tick()
    clock.advance(stepMs)
  }, Promise.resolve())
}

export interface SentReading extends PostRecord {
  reading: IngestReading
  eventTimeMs: number
}

export function sentReadings(http: FakeHttp): SentReading[] {
  return http.posts.map((post) => {
    const reading = JSON.parse(post.body) as IngestReading
    return { ...post, reading, eventTimeMs: Date.parse(reading.event_time) }
  })
}

/** First attempt of each distinct body, in send order. */
export function firstAttempts(sent: SentReading[]): SentReading[] {
  const seen = new Set<string>()
  return sent.filter((post) => {
    if (seen.has(post.body)) {
      return false
    }
    seen.add(post.body)
    return true
  })
}

export function groupBy<T>(items: T[], key: (item: T) => string): Map<string, T[]> {
  return items.reduce((groups, item) => {
    const k = key(item)
    const group = groups.get(k) ?? []
    group.push(item)
    groups.set(k, group)
    return groups
  }, new Map<string, T[]>())
}

export function isNewDevice(deviceId: string): boolean {
  return /^demo-new-\d+$/.test(deviceId)
}

export interface HarnessOptions {
  seed?: number
  responder?: Responder
}

export function createHarness(
  overrides: Partial<SimulatorConfig> = {},
  options: HarnessOptions = {},
) {
  const clock = createFakeClock()
  const http = createFakeHttp(clock, options.responder)
  const logger = createFakeLogger()
  const config = testConfig(overrides)
  const simulator = createSimulator({
    config,
    clock,
    rng: createSeededRng(options.seed ?? 1),
    http,
    logger,
  })
  return { clock, http, logger, config, simulator }
}
