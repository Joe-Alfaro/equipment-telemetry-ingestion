import { describe, expect, it } from 'vitest'
import { T0, createHarness, groupBy, isNewDevice, runFor, sentReadings } from '../test/fakes'

const METRICS = ['temperature', 'vibration', 'power_draw', 'status']
const GATEWAYS = ['gw-demo-1', 'gw-demo-2', 'gw-demo-3']
const TICK_MS = 100

describe('simulator: steady traffic (rule 2)', () => {
  it.fails('POSTs every reading to ${apiUrl}/ingest/readings', async () => {
    const { simulator, clock, http, config } = createHarness()

    await runFor(simulator, clock, 10_000)

    expect(http.posts.length).toBeGreaterThan(0)
    http.posts.forEach((post) => {
      expect(post.url).toBe(`${config.apiUrl}/ingest/readings`)
    })
  })

  it.fails(
    'runs 3 demo gateways with 2 demo devices each, each device on exactly one gateway',
    async () => {
      const { simulator, clock, http } = createHarness()

      await runFor(simulator, clock, 60_000)

      const sent = sentReadings(http)
      expect(new Set(sent.map((post) => post.reading.gateway_id))).toEqual(new Set(GATEWAYS))

      const byDevice = groupBy(sent, (post) => post.reading.device_id)
      const deviceIds = [...byDevice.keys()]
      expect(deviceIds).toHaveLength(6)
      deviceIds.forEach((deviceId) => {
        expect(deviceId).toMatch(/^demo-/)
        expect(isNewDevice(deviceId)).toBe(false)
        const gateways = new Set(byDevice.get(deviceId)?.map((post) => post.reading.gateway_id))
        expect(gateways.size).toBe(1)
      })

      const byGateway = groupBy(sent, (post) => post.reading.gateway_id)
      GATEWAYS.forEach((gatewayId) => {
        const devices = new Set(byGateway.get(gatewayId)?.map((post) => post.reading.device_id))
        expect(devices.size).toBe(2)
      })
    },
  )

  it.fails(
    'sends one reading per device every intervalMs, stamped with the current time',
    async () => {
      const { simulator, clock, http, config } = createHarness({ intervalMs: 2000 })

      await runFor(simulator, clock, 60_000, TICK_MS)

      const sent = sentReadings(http)
      sent.forEach((post) => {
        expect(Math.abs(post.eventTimeMs - post.at)).toBeLessThanOrEqual(TICK_MS)
        expect(post.eventTimeMs).toBeGreaterThanOrEqual(T0)
      })

      groupBy(sent, (post) => post.reading.device_id).forEach((posts) => {
        expect(posts.length).toBeGreaterThanOrEqual(29)
        expect(posts.length).toBeLessThanOrEqual(31)
        posts.slice(1).forEach((post, index) => {
          const gap = post.eventTimeMs - (posts[index]?.eventTimeMs ?? 0)
          expect(gap).toBeGreaterThanOrEqual(config.intervalMs - TICK_MS)
          expect(gap).toBeLessThanOrEqual(config.intervalMs + TICK_MS)
        })
      })
    },
  )

  it.fails('cycles each device through temperature, vibration, power_draw and status', async () => {
    const { simulator, clock, http } = createHarness()

    await runFor(simulator, clock, 60_000)

    groupBy(sentReadings(http), (post) => post.reading.device_id).forEach((posts) => {
      const metrics = posts.map((post) => post.reading.metric)
      expect(metrics.length).toBeGreaterThanOrEqual(8)
      metrics.slice(0, metrics.length - 3).forEach((_metric, index) => {
        expect(new Set(metrics.slice(index, index + 4))).toEqual(new Set(METRICS))
      })
    })
  })
})

describe('simulator: values (rule 2)', () => {
  const BOUNDS: Record<string, { min: number; max: number }> = {
    temperature: { min: 15, max: 90 },
    vibration: { min: 0, max: 10 },
    power_draw: { min: 0, max: 50 },
  }

  it.fails('keeps each metric in its realistic range over an hour', async () => {
    const { simulator, clock, http } = createHarness({ intervalMs: 2000 })

    await runFor(simulator, clock, 3_600_000, 1000)

    const sent = sentReadings(http)
    expect(sent.length).toBeGreaterThan(10_000)
    sent.forEach(({ reading }) => {
      if (reading.metric === 'status') {
        expect([0, 1]).toContain(reading.value)
        return
      }
      const bounds = BOUNDS[reading.metric]
      expect(bounds, `unexpected metric ${reading.metric}`).toBeDefined()
      expect(reading.value).toBeGreaterThanOrEqual(bounds?.min ?? Infinity)
      expect(reading.value).toBeLessThanOrEqual(bounds?.max ?? -Infinity)
    })
  })

  it.fails(
    'moves each continuous metric as a bounded random walk per (device, metric)',
    async () => {
      const { simulator, clock, http } = createHarness({ intervalMs: 2000 })

      await runFor(simulator, clock, 3_600_000, 1000)

      const series = groupBy(
        sentReadings(http).filter(({ reading }) => reading.metric !== 'status'),
        (post) => `${post.reading.device_id}|${post.reading.metric}`,
      )
      expect(series.size).toBe(6 * 3)
      series.forEach((posts) => {
        const { metric } = posts[0]?.reading ?? { metric: '' }
        const bounds = BOUNDS[metric] ?? { min: 0, max: 0 }
        const maxStep = (bounds.max - bounds.min) * 0.25
        const values = posts.map((post) => post.reading.value)
        // A walk, not a constant and not white noise across the whole range.
        expect(new Set(values).size).toBeGreaterThan(10)
        values.slice(1).forEach((value, index) => {
          expect(Math.abs(value - (values[index] ?? value))).toBeLessThanOrEqual(maxStep)
        })
      })
    },
  )

  it.fails('changes status rarely', async () => {
    const { simulator, clock, http } = createHarness({ intervalMs: 2000 })

    await runFor(simulator, clock, 3_600_000, 1000)

    groupBy(
      sentReadings(http).filter(({ reading }) => reading.metric === 'status'),
      (post) => post.reading.device_id,
    ).forEach((posts) => {
      const values = posts.map((post) => post.reading.value)
      const changes = values.slice(1).filter((value, index) => value !== values[index]).length
      expect(values.length).toBeGreaterThan(100)
      expect(changes / (values.length - 1)).toBeLessThanOrEqual(0.1)
    })
  })
})

describe('simulator: sequence counters (rule 2)', () => {
  it.fails('counts sequence per (gateway, device) from 0 in send order', async () => {
    const { simulator, clock, http } = createHarness()

    await runFor(simulator, clock, 60_000)

    const series = groupBy(
      sentReadings(http),
      (post) => `${post.reading.gateway_id}|${post.reading.device_id}`,
    )
    expect(series.size).toBe(6)
    series.forEach((posts) => {
      expect(posts.map((post) => post.reading.sequence)).toEqual(posts.map((_post, index) => index))
    })
  })

  it.fails('starts again from 0 in a new process', async () => {
    const first = createHarness()
    await runFor(first.simulator, first.clock, 10_000)
    const second = createHarness()
    await runFor(second.simulator, second.clock, 10_000)

    const firstSequences = sentReadings(second.http)
      .filter((post) => post.reading.sequence === 0)
      .map((post) => post.reading.device_id)
    expect(new Set(firstSequences).size).toBe(6)
  })
})

describe('simulator: deterministic core (rule 6)', () => {
  it.fails('produces identical bodies for the same seed and clock', async () => {
    const a = createHarness({}, { seed: 42 })
    const b = createHarness({}, { seed: 42 })

    await runFor(a.simulator, a.clock, 30_000)
    await runFor(b.simulator, b.clock, 30_000)

    expect(a.http.posts.length).toBeGreaterThan(0)
    expect(b.http.posts.map((post) => post.body)).toEqual(a.http.posts.map((post) => post.body))
  })

  it.fails('produces different values for a different seed', async () => {
    const a = createHarness({}, { seed: 42 })
    const b = createHarness({}, { seed: 43 })

    await runFor(a.simulator, a.clock, 30_000)
    await runFor(b.simulator, b.clock, 30_000)

    expect(b.http.posts.map((post) => post.body)).not.toEqual(a.http.posts.map((post) => post.body))
  })
})
