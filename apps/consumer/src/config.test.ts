import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { loadConfig } from './config'

describe('consumer config: FUTURE_SKEW_MS (rule 4)', () => {
  beforeEach(() => {
    vi.stubEnv('DATABASE_URL', 'postgres://localhost/telemetry')
    vi.stubEnv('AMQP_URL', 'amqp://localhost')
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it.fails('defaults futureSkewMs to 60000', () => {
    vi.stubEnv('FUTURE_SKEW_MS', undefined)

    expect(loadConfig()).toMatchObject({ futureSkewMs: 60_000 })
  })

  it.fails('reads futureSkewMs from FUTURE_SKEW_MS', () => {
    vi.stubEnv('FUTURE_SKEW_MS', '5000')

    expect(loadConfig()).toMatchObject({ futureSkewMs: 5_000 })
  })
})
