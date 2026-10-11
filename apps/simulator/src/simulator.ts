import type { SimulatorConfig } from './config'
import type { Rng } from './rng'

export interface Clock {
  /** Milliseconds since the Unix epoch. */
  now(): number
}

export interface HttpResponse {
  status: number
}

/**
 * Sends one JSON body. The body is passed already serialized so a resend can be byte-identical.
 * A network failure rejects.
 */
export interface HttpClient {
  post(url: string, body: string): Promise<HttpResponse>
}

export interface Logger {
  info(message: string, meta?: Record<string, unknown>): void
  warn(message: string, meta?: Record<string, unknown>): void
  error(message: string, meta?: Record<string, unknown>): void
}

export interface SimulatorDeps {
  config: SimulatorConfig
  clock: Clock
  rng: Rng
  http: HttpClient
  logger: Logger
}

export interface Simulator {
  /**
   * Emits every reading that is due at clock.now() and makes the send attempts due by then
   * (new readings, backlog, resends and retries). Never throws on HTTP failures.
   */
  tick(): Promise<void>
  /** Stops the simulator (SIGTERM). After it resolves, tick() sends nothing. */
  stop(): Promise<void>
}

const GATEWAYS = ['gw-demo-1', 'gw-demo-2', 'gw-demo-3']
const DEVICES_PER_GATEWAY = 2
const METRICS = ['temperature', 'vibration', 'power_draw', 'status']

const RANGES: Record<string, { min: number; max: number }> = {
  temperature: { min: 15, max: 90 },
  vibration: { min: 0, max: 10 },
  power_draw: { min: 0, max: 50 },
}
/** Largest random-walk step, as a share of the metric's range. */
const MAX_STEP_SHARE = 0.04
const STATUS_FLIP_PROBABILITY = 0.02
const RESEND_PROBABILITY = 0.25
/** The second gateway in a new-device race reports within this many ms of the first. */
const RACE_SPREAD_MS = 80
const RETRY_BASE_MS = 500
const RETRY_MAX_MS = 5000
/** After a long stall (a sleeping laptop), skip ahead instead of sending a burst. */
const MAX_CATCH_UP_INTERVALS = 5

interface Device {
  gatewayId: string
  deviceId: string
  metricIndex: number
  nextDueAt: number
}

interface Reading {
  gatewayId: string
  body: string
}

interface Pending extends Reading {
  id: number
  dueAt: number
  attempts: number
}

/**
 * The deterministic core: every decision comes from the injected clock and rng, so a seed and a
 * fake clock replay the same traffic byte for byte. main.ts only wires real deps and a timer.
 */
export function createSimulator({ config, clock, rng, http, logger }: SimulatorDeps): Simulator {
  const startAt = clock.now()
  const url = `${config.apiUrl}/ingest/readings`
  const devices: Device[] = GATEWAYS.flatMap((gatewayId, gatewayIndex) =>
    Array.from({ length: DEVICES_PER_GATEWAY }, (_unused, n) => {
      const index = gatewayIndex * DEVICES_PER_GATEWAY + n
      return {
        gatewayId,
        deviceId: `demo-${gatewayIndex + 1}-${n + 1}`,
        metricIndex: index % METRICS.length,
        // Stagger the devices so the board updates steadily rather than in bursts.
        nextDueAt:
          startAt +
          Math.round((index * config.intervalMs) / (GATEWAYS.length * DEVICES_PER_GATEWAY)),
      }
    }),
  )
  const state = {
    values: new Map<string, number>(),
    sequences: new Map<string, number>(),
    backlogs: new Map<string, Reading[]>(),
    queue: [] as Pending[],
    nextId: 0,
    nextNewDeviceAt: startAt + config.newDeviceEveryMs,
    newDevices: 0,
    stopped: false,
    current: Promise.resolve(),
  }

  /** Outage k (k >= 1) silences GATEWAYS[(k - 1) % 3] from startAt + k * every for outageMs. */
  function isSilent(gatewayId: string, at: number): boolean {
    const latest = Math.floor((at - startAt) / config.outageEveryMs)
    const overlapping = Math.min(latest, Math.ceil(config.outageMs / config.outageEveryMs) + 1)
    return Array.from({ length: Math.max(overlapping, 0) }, (_unused, back) => latest - back).some(
      (k) =>
        k >= 1 &&
        at < startAt + k * config.outageEveryMs + config.outageMs &&
        GATEWAYS[(k - 1) % GATEWAYS.length] === gatewayId,
    )
  }

  function nextValue(deviceId: string, metric: string): number {
    const key = `${deviceId}|${metric}`
    const previous = state.values.get(key)
    const range = RANGES[metric]
    const value = range ? walk(previous, range) : flip(previous)
    state.values.set(key, value)
    return value
  }

  function walk(previous: number | undefined, { min, max }: { min: number; max: number }) {
    const span = max - min
    if (previous === undefined) {
      return round(min + span * (0.3 + 0.4 * rng.next()))
    }
    const stepped = previous + (rng.next() * 2 - 1) * MAX_STEP_SHARE * span
    // Reflect off the bounds so the walk never sticks to an edge.
    if (stepped > max) {
      return round(2 * max - stepped)
    }
    if (stepped < min) {
      return round(2 * min - stepped)
    }
    return round(stepped)
  }

  function flip(previous: number | undefined): number {
    if (previous === undefined) {
      return 1
    }
    return rng.next() < STATUS_FLIP_PROBABILITY ? 1 - previous : previous
  }

  function makeReading(gatewayId: string, deviceId: string, metric: string, at: number): Reading {
    const key = `${gatewayId}|${deviceId}`
    const sequence = state.sequences.get(key) ?? 0
    state.sequences.set(key, sequence + 1)
    const body = JSON.stringify({
      gateway_id: gatewayId,
      device_id: deviceId,
      metric,
      value: nextValue(deviceId, metric),
      event_time: new Date(at).toISOString(),
      sequence,
    })
    return { gatewayId, body }
  }

  function enqueue(reading: Reading, dueAt: number) {
    state.queue.push({ ...reading, id: state.nextId, dueAt, attempts: 0 })
    state.nextId += 1
  }

  function generateSteadyTraffic(now: number) {
    devices.forEach((device) => {
      if (now - device.nextDueAt > MAX_CATCH_UP_INTERVALS * config.intervalMs) {
        device.nextDueAt = now
      }
      const due =
        device.nextDueAt > now ? 0 : Math.floor((now - device.nextDueAt) / config.intervalMs) + 1
      Array.from({ length: due }).forEach(() => {
        const at = device.nextDueAt
        const metric = METRICS[device.metricIndex % METRICS.length] as string
        device.metricIndex += 1
        device.nextDueAt += config.intervalMs
        const reading = makeReading(device.gatewayId, device.deviceId, metric, at)
        if (!isSilent(device.gatewayId, at)) {
          enqueue(reading, at)
          return
        }
        if (!state.backlogs.has(device.gatewayId)) {
          logger.info('gateway offline, buffering', { gatewayId: device.gatewayId })
        }
        state.backlogs.set(device.gatewayId, [
          ...(state.backlogs.get(device.gatewayId) ?? []),
          reading,
        ])
      })
    })
  }

  /**
   * A reconnected gateway sends its backlog in order, spread over half an outage so live
   * readings interleave with it, and resends about 1 in 4 of them byte for byte.
   */
  function drainBacklogs(now: number) {
    state.backlogs.forEach((backlog, gatewayId) => {
      if (isSilent(gatewayId, now)) {
        return
      }
      state.backlogs.delete(gatewayId)
      const windowMs = config.outageMs / 2
      const gapMs = windowMs / backlog.length
      logger.info('gateway reconnected, sending backlog', { gatewayId, readings: backlog.length })
      backlog.forEach((reading, index) => {
        const dueAt = now + Math.round(index * gapMs)
        enqueue(reading, dueAt)
        if (rng.next() < RESEND_PROBABILITY) {
          enqueue(reading, dueAt + Math.round(rng.next() * (windowMs / 2)))
        }
      })
    })
  }

  /** Two different gateways report the same brand-new device within RACE_SPREAD_MS. */
  function startNewDeviceRaces(now: number) {
    const due =
      state.nextNewDeviceAt > now
        ? 0
        : Math.floor((now - state.nextNewDeviceAt) / config.newDeviceEveryMs) + 1
    Array.from({ length: Math.min(due, config.maxNewDevices - state.newDevices) }).forEach(() => {
      const at = state.nextNewDeviceAt
      state.nextNewDeviceAt += config.newDeviceEveryMs
      state.newDevices += 1
      const deviceId = `demo-new-${state.newDevices}`
      const online = GATEWAYS.filter((gatewayId) => !isSilent(gatewayId, at))
      const candidates = online.length >= 2 ? online : GATEWAYS
      const first = candidates[Math.floor(rng.next() * candidates.length)] as string
      const others = candidates.filter((gatewayId) => gatewayId !== first)
      const second = others[Math.floor(rng.next() * others.length)] as string
      const secondAt = at + Math.floor(rng.next() * RACE_SPREAD_MS)
      logger.info('new device race', { deviceId, gateways: [first, second] })
      enqueue(makeReading(first, deviceId, 'temperature', at), at)
      enqueue(makeReading(second, deviceId, 'temperature', secondAt), secondAt)
    })
    if (state.newDevices >= config.maxNewDevices) {
      state.nextNewDeviceAt = Infinity
    }
  }

  function retryLater(item: Pending, now: number) {
    item.attempts += 1
    item.dueAt = now + Math.min(RETRY_BASE_MS * 2 ** (item.attempts - 1), RETRY_MAX_MS)
  }

  /** Resolves true once the item is finished: accepted, or dropped as a 4xx. */
  async function attempt(item: Pending, now: number): Promise<boolean> {
    try {
      const { status } = await http.post(url, item.body)
      if (status < 300) {
        return true
      }
      if (status < 500) {
        logger.error('reading rejected, dropping it', { status, body: item.body })
        return true
      }
      logger.warn('api error, will retry', { status, attempts: item.attempts + 1 })
    } catch (error) {
      logger.warn('api unreachable, will retry', {
        error: error instanceof Error ? error.message : String(error),
        attempts: item.attempts + 1,
      })
    }
    retryLater(item, now)
    return false
  }

  async function send(now: number) {
    const due = state.queue
      .filter((item) => item.dueAt <= now && !isSilent(item.gatewayId, now))
      .sort((a, b) => a.dueAt - b.dueAt || a.id - b.id)
    const finished = new Set<number>()
    await due.reduce(async (previous, item) => {
      await previous
      if (state.stopped) {
        return
      }
      if (await attempt(item, now)) {
        finished.add(item.id)
      }
    }, Promise.resolve())
    state.queue = state.queue.filter((item) => !finished.has(item.id))
  }

  async function runTick() {
    const now = clock.now()
    generateSteadyTraffic(now)
    startNewDeviceRaces(now)
    drainBacklogs(now)
    await send(now)
  }

  return {
    tick: async () => {
      if (state.stopped) {
        return
      }
      state.current = runTick()
      await state.current
    },
    stop: async () => {
      state.stopped = true
      await state.current
    },
  }
}

function round(value: number): number {
  return Math.round(value * 100) / 100
}
