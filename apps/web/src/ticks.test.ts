import { describe, expect, it } from 'vitest'
import { xTicks, yTicks } from './series'

// History-page ticks (metric charts, rule 12): 4-5 clean y ticks, x ticks every 2 minutes.
describe('yTicks', () => {
  it('keeps the domain when 4-5 clean ticks fit inside it', () => {
    expect(yTicks([67.39, 75.91])).toEqual({
      values: [68, 70, 72, 74],
      step: 2,
      domain: [67.39, 75.91],
    })
  })

  it('widens the domain to whole steps when no step fits 4-5 ticks inside it', () => {
    expect(yTicks([17.29, 20.17])).toEqual({
      values: [17, 18, 19, 20, 21],
      step: 1,
      domain: [17, 21],
    })
  })

  it('prints decimal steps without float noise', () => {
    const { values } = yTicks([0.1, 0.42])

    expect(values.length).toBeGreaterThanOrEqual(4)
    expect(values.length).toBeLessThanOrEqual(5)
    values.forEach((value) => expect(String(value)).toMatch(/^-?\d+(\.\d{1,3})?$/))
  })
})

describe('xTicks', () => {
  it('ticks every 2 minutes of clock time inside the domain', () => {
    const start = Date.parse('2026-10-10T11:50:30.000Z')
    const end = Date.parse('2026-10-10T12:00:00.000Z')

    expect(xTicks([start, end]).map((time) => new Date(time).toISOString().slice(11, 16))).toEqual([
      '11:52',
      '11:54',
      '11:56',
      '11:58',
      '12:00',
    ])
  })
})
