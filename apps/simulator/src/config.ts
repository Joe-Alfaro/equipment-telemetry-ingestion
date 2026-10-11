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

export function loadSimulatorConfig(_env: NodeJS.ProcessEnv = process.env): SimulatorConfig {
  throw new Error('not implemented: loadSimulatorConfig')
}
