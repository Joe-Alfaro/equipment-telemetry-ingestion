import { describe, expect, it } from 'vitest'
import { T0, createHarness, groupBy, isNewDevice, runFor, sentReadings } from '../test/fakes'

const GATEWAYS = ['gw-demo-1', 'gw-demo-2', 'gw-demo-3']
const TICK_MS = 10

describe('simulator: new-device episodes (rule 4)', () => {
  it.fails(
    'reports demo-new-1 from two different demo gateways within ~100 ms, newDeviceEveryMs after start',
    async () => {
      const { simulator, clock, http } = createHarness({
        intervalMs: 2000,
        newDeviceEveryMs: 60_000,
      })

      await runFor(simulator, clock, 65_000, TICK_MS)

      const sent = sentReadings(http)
      const newDevicePosts = sent.filter((post) => isNewDevice(post.reading.device_id))
      newDevicePosts.forEach((post) => {
        expect(post.at).toBeGreaterThanOrEqual(T0 + 60_000 - TICK_MS)
      })

      const race = sent.filter((post) => post.reading.device_id === 'demo-new-1')
      const firstPerGateway = [...groupBy(race, (post) => post.reading.gateway_id).values()].map(
        (posts) => posts[0],
      )
      expect(firstPerGateway.length).toBeGreaterThanOrEqual(2)
      const [a, b] = firstPerGateway
      expect(GATEWAYS).toContain(a?.reading.gateway_id)
      expect(GATEWAYS).toContain(b?.reading.gateway_id)
      expect(a?.reading.gateway_id).not.toBe(b?.reading.gateway_id)
      expect(Math.abs((a?.eventTimeMs ?? 0) - (b?.eventTimeMs ?? Infinity))).toBeLessThanOrEqual(
        100,
      )
      expect(Math.abs((a?.at ?? 0) - (b?.at ?? Infinity))).toBeLessThanOrEqual(100)
      expect(a?.eventTimeMs).toBeLessThanOrEqual(T0 + 61_000)
      // A new (gateway, device) pair starts its own counter.
      expect(a?.reading.sequence).toBe(0)
      expect(b?.reading.sequence).toBe(0)
    },
  )

  it.fails(
    'numbers new devices demo-new-1, demo-new-2, ... and stops at maxNewDevices',
    async () => {
      const { simulator, clock, http } = createHarness({
        intervalMs: 2000,
        newDeviceEveryMs: 1000,
        maxNewDevices: 3,
      })

      await runFor(simulator, clock, 20_000, TICK_MS)

      const newDevices = sentReadings(http).filter((post) => isNewDevice(post.reading.device_id))
      const byDevice = groupBy(newDevices, (post) => post.reading.device_id)
      expect(new Set(byDevice.keys())).toEqual(new Set(['demo-new-1', 'demo-new-2', 'demo-new-3']))
      byDevice.forEach((posts) => {
        expect(new Set(posts.map((post) => post.reading.gateway_id)).size).toBeGreaterThanOrEqual(2)
      })
    },
  )
})
