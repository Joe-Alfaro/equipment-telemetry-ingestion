import { describe, expect, it } from 'vitest'
import { createRng } from './rng'

function draw(seed: string, count = 100): number[] {
  const rng = createRng(seed)
  return Array.from({ length: count }, () => rng.next())
}

describe('createRng (rule 6)', () => {
  it.fails('returns the same sequence for the same seed', () => {
    expect(draw('demo')).toEqual(draw('demo'))
  })

  it.fails('returns a different sequence for a different seed', () => {
    expect(draw('demo-a')).not.toEqual(draw('demo-b'))
  })

  it.fails('returns uniform-ish numbers in [0, 1)', () => {
    const values = draw('demo', 10_000)
    values.forEach((value) => {
      expect(value).toBeGreaterThanOrEqual(0)
      expect(value).toBeLessThan(1)
    })
    const mean = values.reduce((sum, value) => sum + value, 0) / values.length
    expect(mean).toBeGreaterThan(0.45)
    expect(mean).toBeLessThan(0.55)
  })
})
