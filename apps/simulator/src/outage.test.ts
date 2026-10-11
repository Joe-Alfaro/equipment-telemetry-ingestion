import { describe, expect, it } from 'vitest'
import { T0, createHarness, firstAttempts, groupBy, runFor, sentReadings } from '../test/fakes'
import type { SentReading } from '../test/fakes'

const TICK_MS = 100
const OUTAGE = { intervalMs: 2000, outageEveryMs: 300_000, outageMs: 60_000 }
const OUTAGE_START = T0 + OUTAGE.outageEveryMs
const OUTAGE_END = OUTAGE_START + OUTAGE.outageMs

function readingKey({ reading }: SentReading): string {
  return [reading.gateway_id, reading.device_id, reading.sequence, reading.event_time].join('|')
}

/** gw-demo-1's readings generated while it was silent, i.e. its backlog. */
function backlogOf(sent: SentReading[]): SentReading[] {
  return sent.filter(
    (post) =>
      post.reading.gateway_id === 'gw-demo-1' &&
      post.eventTimeMs >= OUTAGE_START &&
      post.eventTimeMs < OUTAGE_END,
  )
}

async function runFirstOutage(seed = 1) {
  const harness = createHarness(OUTAGE, { seed })
  // Through the first outage and 2 minutes past reconnect; the second outage starts at T0 + 600s.
  await runFor(harness.simulator, harness.clock, OUTAGE_END - T0 + 120_000, TICK_MS)
  return harness
}

describe('simulator: outage and backlog episodes (rule 3)', () => {
  it('silences gw-demo-1 for outageMs, starting outageEveryMs after start, while the others keep sending', async () => {
    const { http } = await runFirstOutage()

    const during = sentReadings(http).filter(
      (post) => post.at > OUTAGE_START + TICK_MS && post.at < OUTAGE_END - TICK_MS,
    )
    expect(during.filter((post) => post.reading.gateway_id === 'gw-demo-1')).toEqual([])
    const byGateway = groupBy(during, (post) => post.reading.gateway_id)
    expect(byGateway.get('gw-demo-2')?.length ?? 0).toBeGreaterThanOrEqual(50)
    expect(byGateway.get('gw-demo-3')?.length ?? 0).toBeGreaterThanOrEqual(50)
  })

  it('buffers the silent readings with their real event_times and sends them after reconnect', async () => {
    const { http, config } = await runFirstOutage()

    const backlog = firstAttempts(backlogOf(sentReadings(http)))
    const byDevice = groupBy(backlog, (post) => post.reading.device_id)
    expect(byDevice.size).toBe(2)
    byDevice.forEach((posts) => {
      // 60 s of silence at one reading per 2 s.
      expect(posts.length).toBeGreaterThanOrEqual(29)
      expect(posts.length).toBeLessThanOrEqual(31)
      posts.slice(1).forEach((post, index) => {
        const gap = post.eventTimeMs - (posts[index]?.eventTimeMs ?? 0)
        expect(gap).toBeGreaterThanOrEqual(config.intervalMs - TICK_MS)
        expect(gap).toBeLessThanOrEqual(config.intervalMs + TICK_MS)
      })
    })
    backlog.forEach((post) => {
      expect(post.at).toBeGreaterThanOrEqual(OUTAGE_END - TICK_MS)
    })
  })

  it('keeps the per-(gateway, device) sequence contiguous across the outage', async () => {
    const { http } = await runFirstOutage()

    const gw1 = firstAttempts(sentReadings(http)).filter(
      (post) => post.reading.gateway_id === 'gw-demo-1',
    )
    groupBy(gw1, (post) => post.reading.device_id).forEach((posts) => {
      const sequences = posts.map((post) => post.reading.sequence).sort((a, b) => a - b)
      expect(sequences).toEqual(sequences.map((_sequence, index) => index))
    })
  })

  it('sends the backlog in its original order, interleaved with live traffic, within outageMs of reconnect', async () => {
    const { http } = await runFirstOutage()

    const sent = sentReadings(http)
    const backlog = firstAttempts(backlogOf(sent))
    expect(backlog.length).toBeGreaterThanOrEqual(58)

    const eventTimes = backlog.map((post) => post.eventTimeMs)
    expect(eventTimes).toEqual([...eventTimes].sort((a, b) => a - b))
    groupBy(backlog, (post) => post.reading.device_id).forEach((posts) => {
      const sequences = posts.map((post) => post.reading.sequence)
      expect(sequences).toEqual([...sequences].sort((a, b) => a - b))
    })

    const firstIndex = sent.indexOf(backlog[0] as SentReading)
    const lastIndex = sent.indexOf(backlog[backlog.length - 1] as SentReading)
    const liveDuringBacklog = sent
      .slice(firstIndex, lastIndex)
      .filter((post) => post.reading.gateway_id === 'gw-demo-1' && post.eventTimeMs >= OUTAGE_END)
    expect(liveDuringBacklog.length).toBeGreaterThan(0)
    expect(backlog[backlog.length - 1]?.at).toBeLessThanOrEqual(OUTAGE_END + OUTAGE.outageMs)
  })

  it('resends about 1 in 4 backlog readings byte-identically', async () => {
    const seeds = [1, 2, 3, 4, 5, 6]
    const runs = await Promise.all(seeds.map((seed) => runFirstOutage(seed)))

    const totals = runs.reduce(
      (sum, { http }) => {
        const backlog = backlogOf(sentReadings(http))
        const distinct = new Set(backlog.map((post) => post.body))
        return {
          readings: sum.readings + distinct.size,
          resent:
            sum.resent +
            [...groupBy(backlog, (post) => post.body).values()].filter((posts) => posts.length > 1)
              .length,
        }
      },
      { readings: 0, resent: 0 },
    )

    expect(totals.readings).toBeGreaterThan(300)
    expect(totals.resent / totals.readings).toBeGreaterThanOrEqual(0.17)
    expect(totals.resent / totals.readings).toBeLessThanOrEqual(0.33)
  })

  it('never sends two different bodies for the same reading key, and resends only backlog', async () => {
    const { http } = await runFirstOutage()

    const sent = sentReadings(http)
    groupBy(sent, readingKey).forEach((posts) => {
      expect(new Set(posts.map((post) => post.body)).size).toBe(1)
    })
    const backlogBodies = new Set(backlogOf(sent).map((post) => post.body))
    groupBy(
      sent.filter((post) => !backlogBodies.has(post.body)),
      (post) => post.body,
    ).forEach((posts) => {
      expect(posts).toHaveLength(1)
    })
  })

  it('picks the silent gateway round robin', async () => {
    const { simulator, clock, http } = createHarness({
      intervalMs: 1000,
      outageEveryMs: 10_000,
      outageMs: 3000,
    })

    await runFor(simulator, clock, 45_000, TICK_MS)

    const sent = sentReadings(http)
    const expected = [
      { start: T0 + 10_000, gatewayId: 'gw-demo-1' },
      { start: T0 + 20_000, gatewayId: 'gw-demo-2' },
      { start: T0 + 30_000, gatewayId: 'gw-demo-3' },
      { start: T0 + 40_000, gatewayId: 'gw-demo-1' },
    ]
    expected.forEach(({ start, gatewayId }) => {
      const during = sent.filter(
        (post) => post.at > start + TICK_MS && post.at < start + 3000 - TICK_MS,
      )
      const gateways = new Set(during.map((post) => post.reading.gateway_id))
      expect(gateways.has(gatewayId), `${gatewayId} should be silent at ${start - T0}ms`).toBe(
        false,
      )
      expect(gateways.size).toBe(2)
    })
  })
})
