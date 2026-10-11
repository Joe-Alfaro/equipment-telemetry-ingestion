import { describe, expect, it } from 'vitest'
import { connectBroker, DEFAULT_READINGS_QUEUE } from './connection'

describe('broker (smoke)', () => {
  it('uses the readings queue by default', () => {
    expect(DEFAULT_READINGS_QUEUE).toBe('readings')
  })

  it('gives up after the configured attempts', async () => {
    await expect(connectBroker('amqp://127.0.0.1:1', { attempts: 2, delayMs: 1 })).rejects.toThrow()
  })
})
