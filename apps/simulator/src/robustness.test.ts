import { describe, expect, it } from 'vitest'
import { T0, createHarness, firstAttempts, groupBy, runFor, sentReadings } from '../test/fakes'
import type { FakeHttp, FakeLogger, Responder } from '../test/fakes'

/** Applies `outcome` to the third distinct body the simulator sends; everything else gets 202. */
function failThirdBody(outcome: (attemptOfBody: number) => number | 'network-error'): Responder {
  const bodies: string[] = []
  return ({ body, attemptOfBody }) => {
    if (!bodies.includes(body)) {
      bodies.push(body)
    }
    return body === bodies[2] ? outcome(attemptOfBody) : 202
  }
}

function thirdBodyAttempts(http: FakeHttp) {
  const third = firstAttempts(sentReadings(http))[2]
  return http.posts.filter((post) => post.body === third?.body)
}

function expectEveryBodyAccepted(http: FakeHttp) {
  groupBy(http.posts, (post) => post.body).forEach((attempts) => {
    expect(attempts.some((attempt) => attempt.status !== null && attempt.status < 300)).toBe(true)
  })
}

function loggedProblems(logger: FakeLogger): number {
  return logger.warn.mock.calls.length + logger.error.mock.calls.length
}

describe('simulator: robustness (rule 5)', () => {
  it('logs a 5xx and retries the same body later until it is accepted', async () => {
    const { simulator, clock, http, logger } = createHarness(
      {},
      { responder: failThirdBody((attempt) => (attempt < 2 ? 503 : 202)) },
    )

    await runFor(simulator, clock, 60_000)

    const attempts = thirdBodyAttempts(http)
    expect(attempts.map((attempt) => attempt.status)).toEqual([503, 503, 202])
    // "Later": each retry waits at least one tick.
    expect(new Set(attempts.map((attempt) => attempt.at)).size).toBe(3)
    expect(loggedProblems(logger)).toBeGreaterThanOrEqual(2)
    expectEveryBodyAccepted(http)
  })

  it('logs a network error and retries the same body later until it is accepted', async () => {
    const { simulator, clock, http, logger } = createHarness(
      {},
      { responder: failThirdBody((attempt) => (attempt < 2 ? 'network-error' : 202)) },
    )

    await runFor(simulator, clock, 60_000)

    const attempts = thirdBodyAttempts(http)
    expect(attempts.map((attempt) => attempt.status)).toEqual([null, null, 202])
    expect(new Set(attempts.map((attempt) => attempt.at)).size).toBe(3)
    expect(loggedProblems(logger)).toBeGreaterThanOrEqual(2)
    expectEveryBodyAccepted(http)
  })

  it('logs a 4xx and drops the reading without retrying it', async () => {
    const { simulator, clock, http, logger } = createHarness(
      {},
      { responder: failThirdBody(() => 400) },
    )

    await runFor(simulator, clock, 60_000)

    const attempts = thirdBodyAttempts(http)
    expect(attempts.map((attempt) => attempt.status)).toEqual([400])
    expect(loggedProblems(logger)).toBeGreaterThanOrEqual(1)
    // Traffic carries on after the drop.
    expect(http.posts.filter((post) => post.at > (attempts[0]?.at ?? 0)).length).toBeGreaterThan(
      100,
    )
  })

  it('keeps retrying while the api is down at startup and delivers everything once it is up', async () => {
    const apiUpAt = T0 + 30_000
    const { simulator, clock, http, logger } = createHarness(
      {},
      { responder: ({ at }) => (at < apiUpAt ? 'network-error' : 202) },
    )

    await runFor(simulator, clock, 150_000)

    const generatedWhileDown = firstAttempts(sentReadings(http)).filter(
      (post) => post.eventTimeMs < apiUpAt,
    )
    // 6 devices x 15 readings in the first 30 s.
    expect(generatedWhileDown.length).toBeGreaterThanOrEqual(80)
    expect(loggedProblems(logger)).toBeGreaterThan(0)
    expectEveryBodyAccepted(http)
  })

  it('sends nothing after stop() resolves', async () => {
    const { simulator, clock, http } = createHarness()

    await runFor(simulator, clock, 10_000)
    expect(http.posts.length).toBeGreaterThan(0)
    await simulator.stop()
    const sentBeforeStop = http.posts.length
    await runFor(simulator, clock, 10_000)

    expect(http.posts).toHaveLength(sentBeforeStop)
  })
})
