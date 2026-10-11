import { describe, expect, it } from 'vitest'
import { loadSimulatorConfig } from './config'

describe('simulator config (rules 1-4, 6)', () => {
  it.fails('uses the documented defaults', () => {
    expect(loadSimulatorConfig({})).toMatchObject({
      apiUrl: 'http://api:8080',
      intervalMs: 2000,
      outageEveryMs: 300_000,
      outageMs: 60_000,
      newDeviceEveryMs: 600_000,
      maxNewDevices: 10,
    })
  })

  it.fails('reads every setting from the environment', () => {
    expect(
      loadSimulatorConfig({
        API_URL: 'http://localhost:8080',
        SIM_INTERVAL_MS: '500',
        SIM_OUTAGE_EVERY_MS: '10000',
        SIM_OUTAGE_MS: '3000',
        SIM_NEW_DEVICE_EVERY_MS: '20000',
        SIM_MAX_NEW_DEVICES: '2',
        SIM_SEED: 'demo',
      }),
    ).toEqual({
      apiUrl: 'http://localhost:8080',
      intervalMs: 500,
      outageEveryMs: 10_000,
      outageMs: 3000,
      newDeviceEveryMs: 20_000,
      maxNewDevices: 2,
      seed: 'demo',
    })
  })

  it.fails('picks a random seed when SIM_SEED is unset', () => {
    const a = loadSimulatorConfig({}).seed
    const b = loadSimulatorConfig({}).seed

    expect(a).toEqual(expect.any(String))
    expect(a.length).toBeGreaterThan(0)
    expect(b).not.toBe(a)
  })
})
