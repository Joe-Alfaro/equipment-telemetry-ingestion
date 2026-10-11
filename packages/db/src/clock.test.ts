import type { GatewayClock } from '@telemetry/shared'
import { describe, expect, it } from 'vitest'
import { computeGatewayClock, type ClockSample } from './clock'

/*
 * CONTRACT: computeGatewayClock(samples, { thresholdMs = 60000 }) -> GatewayClock.
 * Gateway clock check rules 1, 3 and 4: detect, never correct.
 *
 *   skew    = event_time - received_at (rule 1).
 *   window  = the last 20 samples by receivedAt, whatever order they are passed in (rule 3).
 *   samples = the window size.
 *   First match wins (rule 4):
 *     unknown     fewer than 5 samples in the window; offsetMs null.
 *     local-time  >= 5 naive samples in the window, and >= 80% of those naive samples have a skew
 *                 within +-5 min (inclusive) of the same non-zero multiple of 15 min;
 *                 offsetMs = that multiple.
 *     ahead       median skew of the whole window > thresholdMs (strictly);
 *                 offsetMs = the median rounded to the second.
 *     ok          anything else, including any negative median; offsetMs null.
 *
 * Every test builds skew exactly: receivedAt is fixed per sample and eventTime = receivedAt + skew.
 * Odd window sizes are used wherever the median matters, so no test depends on how an even-sized
 * median is taken.
 */

const BASE = '2026-10-10T12:00:00.000Z'
const MINUTE = 60_000
const UTC_PLUS_5_30 = 19_800_000
const UTC_MINUS_5 = -18_000_000

interface SampleSpec {
  skewMs: number
  naive?: boolean
  /** receivedAt = BASE + receivedOffsetMs. */
  receivedOffsetMs: number
}

function sample({ skewMs, naive = false, receivedOffsetMs }: SampleSpec): ClockSample {
  const received = Date.parse(BASE) + receivedOffsetMs
  return {
    eventTime: new Date(received + skewMs).toISOString(),
    receivedAt: new Date(received).toISOString(),
    naiveTime: naive,
  }
}

/** One sample per skew, received 1 s apart in array order. */
function samples(skews: number[], naive = false, startMs = 0): ClockSample[] {
  return skews.map((skewMs, i) => sample({ skewMs, naive, receivedOffsetMs: startMs + i * 1_000 }))
}

function repeat(count: number, skewMs: number): number[] {
  return Array.from({ length: count }, () => skewMs)
}

describe('computeGatewayClock: unknown (rule 3)', () => {
  it('is unknown with offsetMs null for no readings', () => {
    const expected: GatewayClock = { status: 'unknown', offsetMs: null, samples: 0 }
    expect(computeGatewayClock([])).toStrictEqual(expected)
  })

  it('is unknown for 4 readings even when they are an hour ahead and naive', () => {
    const expected: GatewayClock = { status: 'unknown', offsetMs: null, samples: 4 }
    expect(computeGatewayClock(samples(repeat(4, 60 * MINUTE), true))).toStrictEqual(expected)
  })

  it('judges a gateway once it has exactly 5 readings', () => {
    expect(computeGatewayClock(samples(repeat(5, 0)))).toStrictEqual({
      status: 'ok',
      offsetMs: null,
      samples: 5,
    })
  })
})

describe('computeGatewayClock: window of the last 20 by receivedAt (rule 3)', () => {
  it('ignores readings older than the newest 20, even when passed last and an hour ahead', () => {
    // The 5 oldest receipts carry the latest event_times, so ordering by event_time (or by array
    // position) would pick them.
    const recent = samples(repeat(20, 0), false, 10_000)
    const old = samples(repeat(5, 60 * MINUTE), false, 0)

    expect(computeGatewayClock([...recent, ...old])).toStrictEqual({
      status: 'ok',
      offsetMs: null,
      samples: 20,
    })
  })

  it('uses the newest 20 when they are the ones ahead', () => {
    const old = samples(repeat(5, 0), false, 0)
    const recent = samples(repeat(20, 2 * MINUTE), false, 10_000)

    expect(computeGatewayClock([...recent.reverse(), ...old])).toStrictEqual({
      status: 'ahead',
      offsetMs: 2 * MINUTE,
      samples: 20,
    })
  })

  it('does not count naive readings that fell out of the window', () => {
    const oldNaive = samples(repeat(5, UTC_PLUS_5_30), true, 0)
    const recent = samples(repeat(20, 0), false, 10_000)

    expect(computeGatewayClock([...oldNaive, ...recent])).toMatchObject({ status: 'ok' })
  })
})

describe('computeGatewayClock: ahead (rule 4)', () => {
  it('is ahead when the median skew exceeds 60 s, offsetMs = median rounded to the second', () => {
    expect(computeGatewayClock(samples([0, 61_400, 120_000, 61_400, 120_000]))).toStrictEqual({
      status: 'ahead',
      offsetMs: 61_000,
      samples: 5,
    })
  })

  it('rounds the median to the nearest second', () => {
    expect(computeGatewayClock(samples([61_600, 61_600, 61_600, 0, 90_000]))).toMatchObject({
      status: 'ahead',
      offsetMs: 62_000,
    })
  })

  it('is ok at exactly the threshold and ahead 1 ms past it', () => {
    expect(computeGatewayClock(samples(repeat(5, 60_000)))).toMatchObject({ status: 'ok' })
    expect(computeGatewayClock(samples(repeat(5, 60_001)))).toMatchObject({
      status: 'ahead',
      offsetMs: 60_000,
    })
  })

  it('uses the median, not the mean: one wild reading does not flag the gateway', () => {
    expect(computeGatewayClock(samples([0, 1_000, 2_000, 3_000, 24 * 60 * MINUTE]))).toMatchObject({
      status: 'ok',
    })
  })

  it('honors a configured threshold', () => {
    const window = samples(repeat(5, 6_000))

    expect(computeGatewayClock(window)).toMatchObject({ status: 'ok' })
    expect(computeGatewayClock(window, { thresholdMs: 5_000 })).toStrictEqual({
      status: 'ahead',
      offsetMs: 6_000,
      samples: 5,
    })
  })

  it('flags readings with an offset that are 5:30 h ahead as ahead, not local-time', () => {
    expect(computeGatewayClock(samples(repeat(5, UTC_PLUS_5_30)))).toStrictEqual({
      status: 'ahead',
      offsetMs: UTC_PLUS_5_30,
      samples: 5,
    })
  })
})

describe('computeGatewayClock: ok, including a negative median (rule 4)', () => {
  it('is ok for network-jitter skews of a few seconds either way', () => {
    expect(computeGatewayClock(samples([-2_000, 3_000, 4_750, 0, 1_500]))).toStrictEqual({
      status: 'ok',
      offsetMs: null,
      samples: 5,
    })
  })

  it('never flags a replayed backlog (event_time 1-20 s before receipt)', () => {
    const backlog = Array.from({ length: 20 }, (_, i) => -(20 - i) * 1_000 - 500)

    expect(computeGatewayClock(samples(backlog))).toStrictEqual({
      status: 'ok',
      offsetMs: null,
      samples: 20,
    })
  })

  it('never flags a negative median, even an hour behind, when the readings carry offsets', () => {
    expect(computeGatewayClock(samples(repeat(7, -60 * MINUTE)))).toMatchObject({
      status: 'ok',
      offsetMs: null,
    })
  })
})

describe('computeGatewayClock: local-time (rule 4)', () => {
  it('detects UTC+5:30 from naive readings, ahead of the ahead check', () => {
    const jitter = [0, 2_000, -1_500, 4 * MINUTE + 59_000, -4 * MINUTE]
    const window = samples(
      jitter.map((j) => UTC_PLUS_5_30 + j),
      true,
    )

    expect(computeGatewayClock(window)).toStrictEqual({
      status: 'local-time',
      offsetMs: UTC_PLUS_5_30,
      samples: 5,
    })
  })

  it('detects UTC-5 (a negative offset) from naive readings', () => {
    const window = samples(
      [0, 1_000, -3_000, 500, 2 * MINUTE].map((j) => UTC_MINUS_5 + j),
      true,
    )

    expect(computeGatewayClock(window)).toStrictEqual({
      status: 'local-time',
      offsetMs: UTC_MINUS_5,
      samples: 5,
    })
  })

  it('accepts a skew exactly 5 min from the multiple and rejects one 5 min 1 s away', () => {
    const atEdge = samples(repeat(5, UTC_PLUS_5_30 + 5 * MINUTE), true)
    expect(computeGatewayClock(atEdge)).toMatchObject({
      status: 'local-time',
      offsetMs: UTC_PLUS_5_30,
    })

    // 5 min 1 s past +5:30 is 9 min 59 s short of +5:45, so no multiple of 15 min fits.
    const pastEdge = samples(repeat(5, UTC_PLUS_5_30 + 5 * MINUTE + 1_000), true)
    expect(computeGatewayClock(pastEdge)).toMatchObject({
      status: 'ahead',
      offsetMs: UTC_PLUS_5_30 + 5 * MINUTE + 1_000,
    })
  })

  it('needs at least 80% of the naive readings on the same multiple: 4 of 5 is enough', () => {
    const window = samples([...repeat(4, UTC_PLUS_5_30), 0], true)

    expect(computeGatewayClock(window)).toMatchObject({
      status: 'local-time',
      offsetMs: UTC_PLUS_5_30,
    })
  })

  it('3 of 5 naive readings on one multiple is not local-time; the median decides', () => {
    const window = samples([0, UTC_PLUS_5_30, 0, UTC_PLUS_5_30, UTC_PLUS_5_30], true)

    expect(computeGatewayClock(window)).toStrictEqual({
      status: 'ahead',
      offsetMs: UTC_PLUS_5_30,
      samples: 5,
    })
  })

  it('naive readings split across two different multiples are not local-time', () => {
    const window = samples(
      [...repeat(3, UTC_PLUS_5_30), ...repeat(3, UTC_PLUS_5_30 + 60 * MINUTE)],
      true,
    )

    expect(computeGatewayClock(window)).toMatchObject({ status: 'ahead' })
  })

  it('needs at least 5 naive readings in the window', () => {
    const window = [
      ...samples(repeat(4, UTC_PLUS_5_30), true, 0),
      ...samples(repeat(5, 0), false, 10_000),
    ]

    expect(computeGatewayClock(window)).toStrictEqual({ status: 'ok', offsetMs: null, samples: 9 })
  })

  it('counts 80% of the naive readings only, not of the whole window', () => {
    const window = [
      ...samples(repeat(5, UTC_PLUS_5_30), true, 0),
      ...samples(repeat(15, 0), false, 10_000),
    ]

    expect(computeGatewayClock(window)).toStrictEqual({
      status: 'local-time',
      offsetMs: UTC_PLUS_5_30,
      samples: 20,
    })
  })

  it('a zero multiple is not local-time: a UTC gateway that omits the offset is ok', () => {
    expect(computeGatewayClock(samples([0, 1_000, -2_000, 3_000, 500], true))).toStrictEqual({
      status: 'ok',
      offsetMs: null,
      samples: 5,
    })
  })

  it('naive readings 7 min ahead fit no non-zero multiple, so they fall through to ahead', () => {
    expect(computeGatewayClock(samples(repeat(5, 7 * MINUTE), true))).toStrictEqual({
      status: 'ahead',
      offsetMs: 7 * MINUTE,
      samples: 5,
    })
  })
})
