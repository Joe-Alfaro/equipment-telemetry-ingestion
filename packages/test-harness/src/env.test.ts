import { describe, expect, it } from 'vitest'
import { TEST_AMQP_URL, TEST_DATABASE_URL } from './env'

describe('test harness (smoke)', () => {
  it('points at the docker-compose.test.yml ports by default', () => {
    expect(new URL(TEST_DATABASE_URL).protocol).toBe('postgres:')
    expect(new URL(TEST_AMQP_URL).protocol).toBe('amqp:')
  })
})
