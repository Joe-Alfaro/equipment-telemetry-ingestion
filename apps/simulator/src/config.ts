import { randomUUID } from 'node:crypto'

export interface SimulatorConfig {
  /** Base URL of the api; readings go to `${apiUrl}/ingest/readings`. API_URL, default http://api:8080. */
  apiUrl: string
  /** Each device sends one reading this often. SIM_INTERVAL_MS, default 2000. */
  intervalMs: number
  /** One gateway (round robin) goes silent this often. SIM_OUTAGE_EVERY_MS, default 300000. */
  outageEveryMs: number
  /** How long each outage lasts. SIM_OUTAGE_MS, default 60000. */
  outageMs: number
  /** A new device races onto two gateways this often. SIM_NEW_DEVICE_EVERY_MS, default 600000. */
  newDeviceEveryMs: number
  /** Most new devices per process lifetime. SIM_MAX_NEW_DEVICES, default 10. */
  maxNewDevices: number
  /** RNG seed. SIM_SEED, default random. */
  seed: string
}

function positiveInt(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name]
  if (raw === undefined || raw === '') {
    return fallback
  }
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer, got ${raw}`)
  }
  return value
}

export function loadSimulatorConfig(env: NodeJS.ProcessEnv = process.env): SimulatorConfig {
  return {
    apiUrl: (env.API_URL || 'http://api:8080').replace(/\/+$/, ''),
    intervalMs: positiveInt(env, 'SIM_INTERVAL_MS', 2000),
    outageEveryMs: positiveInt(env, 'SIM_OUTAGE_EVERY_MS', 300_000),
    outageMs: positiveInt(env, 'SIM_OUTAGE_MS', 60_000),
    newDeviceEveryMs: positiveInt(env, 'SIM_NEW_DEVICE_EVERY_MS', 600_000),
    maxNewDevices: positiveInt(env, 'SIM_MAX_NEW_DEVICES', 10),
    seed: env.SIM_SEED || randomUUID(),
  }
}
