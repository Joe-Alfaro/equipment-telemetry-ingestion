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

export function createSimulator(_deps: SimulatorDeps): Simulator {
  throw new Error('not implemented: createSimulator')
}
