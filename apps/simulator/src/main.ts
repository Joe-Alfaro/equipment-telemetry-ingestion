import { loadSimulatorConfig } from './config'
import { createRng } from './rng'
import { createSimulator } from './simulator'
import type { HttpClient, Logger } from './simulator'

const TICK_MS = 100
const REQUEST_TIMEOUT_MS = 5000

function write(level: string, message: string, meta?: Record<string, unknown>) {
  const line = JSON.stringify({ level, message, meta })
  if (level === 'info') {
    console.log(line)
    return
  }
  console.error(line)
}

const log: Logger = {
  info: (message, meta) => write('info', message, meta),
  warn: (message, meta) => write('warn', message, meta),
  error: (message, meta) => write('error', message, meta),
}

const http: HttpClient = {
  post: async (url, body) => {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    // Drain the body so the connection is reused.
    await response.arrayBuffer()
    return { status: response.status }
  },
}

const config = loadSimulatorConfig()
const simulator = createSimulator({
  config,
  clock: { now: () => Date.now() },
  rng: createRng(config.seed),
  http,
  logger: log,
})
log.info('simulating', { ...config })

// A self-rescheduling timer, so a slow tick never overlaps the next one.
const timer = { handle: setTimeout(loop, 0) }

async function loop() {
  await simulator.tick()
  timer.handle = setTimeout(loop, TICK_MS)
}

async function shutdown(signal: string) {
  log.info(`${signal} received, shutting down`)
  clearTimeout(timer.handle)
  await simulator.stop()
  process.exit(0)
}

process.on('SIGTERM', () => void shutdown('SIGTERM'))
process.on('SIGINT', () => void shutdown('SIGINT'))
