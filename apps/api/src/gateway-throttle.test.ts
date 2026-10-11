import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createKeyedThrottle } from './gateway-throttle'

describe('createKeyedThrottle', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('fires the first call at once and collapses a burst into one trailing call', () => {
    const fired: string[] = []
    const throttle = createKeyedThrottle(1_000, (key) => fired.push(key))

    throttle.call('gw-a')
    throttle.call('gw-a')
    throttle.call('gw-a')
    expect(fired).toEqual(['gw-a'])

    vi.advanceTimersByTime(1_000)
    expect(fired).toEqual(['gw-a', 'gw-a'])

    vi.advanceTimersByTime(1_000)
    expect(fired).toEqual(['gw-a', 'gw-a'])
  })

  it('throttles each key independently', () => {
    const fired: string[] = []
    const throttle = createKeyedThrottle(1_000, (key) => fired.push(key))

    throttle.call('gw-a')
    throttle.call('gw-b')
    throttle.call('gw-a')

    expect(fired).toEqual(['gw-a', 'gw-b'])
  })

  it('cancel drops pending trailing calls', () => {
    const fired: string[] = []
    const throttle = createKeyedThrottle(1_000, (key) => fired.push(key))

    throttle.call('gw-a')
    throttle.call('gw-a')
    throttle.cancel()
    vi.advanceTimersByTime(5_000)

    expect(fired).toEqual(['gw-a'])
  })
})
