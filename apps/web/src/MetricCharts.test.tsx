import type { Reading } from '@telemetry/shared'
import { screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installFakeApi, metric, reading, registeredDevice } from './test/fakeApi'
import { findHistoryPage, findRegion, renderApp, type User } from './test/renderApp'

/*
 * Metric charts (10-minute line per continuous metric), rules 10-15. Charts are tested only
 * through what a user can perceive, never through SVG structure or chart-library internals:
 *
 * - Each continuous metric (anything but `status`) is one chart with role="img" whose accessible
 *   name is a summary starting "<metric>, current <value>, range <min> to <max> over the last
 *   10 minutes", followed by ", 1 gap" / ", N gaps" when the line has gaps (no reading for over
 *   30 s). `status` has no chart.
 * - Visible chart text lives inside that role="img" element: the end label (the latest value,
 *   plus "as of hh:mm:ss" when the latest reading is over 30 s old) and, on cards, the "−10m" and
 *   "now" tick labels and a "min–max" range text; on the history page, y ticks and clock-time
 *   x ticks.
 * - The chart is keyboard-focusable. Focusing it shows a role="tooltip" for the latest reading
 *   (value, event time, gateway, flags); ArrowLeft / ArrowRight move between readings.
 *
 * Only Date is faked, so `now` is fixed while timers, MSW and user-event run normally.
 */

const NOW = '2026-10-10T12:00:00.000Z'

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(NOW))
})

afterEach(() => {
  vi.useRealTimers()
})

/** A dev-1 reading at a UTC clock time on 2026-10-10 ("11:59:50"). */
function at(clock: string, metricName: string, value: number, overrides: Partial<Reading> = {}) {
  return reading({
    deviceId: 'dev-1',
    metric: metricName,
    value,
    eventTime: `2026-10-10T${clock}.000Z`,
    ...overrides,
  })
}

/**
 * temperature: steady, fresh, no gaps (plus one reading older than the window).
 * vibration: two gaps. power_draw: one gap, latest 40 s old. status: no chart.
 */
const READINGS: Reading[] = [
  at('11:49:00', 'temperature', 99.9, { sequence: 1 }),
  at('11:59:00', 'temperature', 68.1, { sequence: 2 }),
  at('11:59:20', 'temperature', 75.2, { sequence: 3 }),
  at('11:59:50', 'temperature', 72.4, { sequence: 4 }),
  at('11:55:00', 'vibration', 0.12, { sequence: 5 }),
  at('11:55:20', 'vibration', 0.18, { sequence: 6 }),
  at('11:57:00', 'vibration', 0.25, { sequence: 7 }),
  at('11:57:10', 'vibration', 0.22, { sequence: 8 }),
  at('11:59:50', 'vibration', 0.31, { sequence: 9 }),
  at('11:58:00', 'power_draw', 3.5, { sequence: 10 }),
  at('11:58:30', 'power_draw', 4.75, { sequence: 11 }),
  at('11:59:20', 'power_draw', 4.25, { sequence: 12 }),
  at('11:59:50', 'status', 1, { sequence: 13 }),
]

const CHILLER = registeredDevice('dev-1', 'Chiller 1', {
  metrics: {
    temperature: metric({ value: 72.4, eventTime: '2026-10-10T11:59:50.000Z', sequence: 4 }),
    vibration: metric({ value: 0.31, eventTime: '2026-10-10T11:59:50.000Z', sequence: 9 }),
    power_draw: metric({ value: 4.25, eventTime: '2026-10-10T11:59:20.000Z', sequence: 12 }),
    status: metric({ value: 1, eventTime: '2026-10-10T11:59:50.000Z', sequence: 13 }),
  },
})

const GAPS = /\b\d+ gaps?\b/

function findChart(container: HTMLElement, metricName: string) {
  return within(container).findByRole('img', { name: new RegExp(`^${metricName}, `) })
}

async function findChillerCard() {
  installFakeApi({ devices: [CHILLER], readings: READINGS })
  const view = renderApp()
  const board = await findRegion('Equipment')
  const card = await within(board).findByRole('article', { name: 'Chiller 1' })
  return { ...view, card }
}

/** Tabs forward until `target` has focus (fails after 40 presses). */
async function tabTo(user: User, target: HTMLElement, presses = 0): Promise<void> {
  if (document.activeElement === target) {
    return
  }
  if (presses >= 40) {
    throw new Error('could not reach the chart with Tab')
  }
  await user.tab()
  return tabTo(user, target, presses + 1)
}

describe('device card charts (rules 10, 11, 14 and 15)', () => {
  it('draws one chart per continuous metric with an accessible summary', async () => {
    const { card } = await findChillerCard()

    const temperature = await findChart(card, 'temperature')
    expect(temperature).toHaveAccessibleName(
      expect.stringMatching(
        /^temperature, current 72\.4, range 68\.1 to 75\.2 over the last 10 minutes/,
      ),
    )
    expect(temperature.getAttribute('aria-label')).not.toMatch(GAPS)

    const vibration = await findChart(card, 'vibration')
    expect(vibration).toHaveAccessibleName(
      expect.stringMatching(
        /^vibration, current 0\.31, range 0\.12 to 0\.31 over the last 10 minutes, 2 gaps$/,
      ),
    )

    const power = await findChart(card, 'power_draw')
    expect(power).toHaveAccessibleName(
      expect.stringMatching(
        /^power_draw, current 4\.25, range 3\.5 to 4\.75 over the last 10 minutes, 1 gap$/,
      ),
    )
  })

  it('shows status as a plain value with no chart', async () => {
    const { card } = await findChillerCard()
    await findChart(card, 'temperature')

    expect(within(card).queryByRole('img', { name: /^status\b/ })).not.toBeInTheDocument()
    expect(within(card).getByText('status')).toBeInTheDocument()
    expect(within(card).getByText('1')).toBeInTheDocument()
  })

  it('labels the end of each line with the latest value', async () => {
    const { card } = await findChillerCard()

    const temperature = await findChart(card, 'temperature')
    const vibration = await findChart(card, 'vibration')

    expect(within(temperature).getByText('72.4')).toBeInTheDocument()
    expect(within(vibration).getByText('0.31')).toBeInTheDocument()
    expect(temperature).not.toHaveTextContent(/as of/i)
    expect(vibration).not.toHaveTextContent(/as of/i)
  })

  it('adds "as of hh:mm:ss" when the latest reading is over 30 s old', async () => {
    const { card } = await findChillerCard()

    const power = await findChart(card, 'power_draw')

    expect(within(power).getByText('4.25')).toBeInTheDocument()
    expect(power).toHaveTextContent(/as of \d{1,2}:\d{2}:20\b/)
  })

  it('shows the "−10m" and "now" ticks and a muted min–max range', async () => {
    const { card } = await findChillerCard()

    const temperature = await findChart(card, 'temperature')

    expect(within(temperature).getByText('−10m')).toBeInTheDocument()
    expect(within(temperature).getByText('now')).toBeInTheDocument()
    expect(within(temperature).getByText(/^68\.1\s*[–-]\s*75\.2$/)).toBeInTheDocument()
    // The reading from before the window is not in the range or the summary.
    expect(temperature).not.toHaveTextContent('99.9')
  })

  it('is keyboard-focusable and arrow keys move a tooltip between readings', async () => {
    const { card, user } = await findChillerCard()
    const temperature = await findChart(card, 'temperature')

    await tabTo(user, temperature)

    const tooltip = await screen.findByRole('tooltip')
    expect(tooltip).toHaveTextContent('72.4')
    expect(tooltip).toHaveTextContent('gw-1')
    expect(tooltip).toHaveTextContent(/\d{1,2}:\d{2}:50\b/)

    await user.keyboard('{ArrowLeft}')

    expect(screen.getByRole('tooltip')).toHaveTextContent('75.2')
    expect(screen.getByRole('tooltip')).toHaveTextContent(/\d{1,2}:\d{2}:20\b/)

    await user.keyboard('{ArrowRight}')

    expect(screen.getByRole('tooltip')).toHaveTextContent('72.4')
  })
})

describe('history page charts (rules 12-15)', () => {
  /** temperature with every flag: late, out of order, and a future reading as the latest. */
  const FLAGGED: Reading[] = [
    at('11:58:00', 'temperature', 68.1, { sequence: 1 }),
    at('11:58:20', 'temperature', 75.2, { sequence: 2, late: true }),
    at('11:58:40', 'temperature', 70.3, { sequence: 3, outOfOrder: true }),
    at('11:59:00', 'temperature', 71.6, { sequence: 4 }),
    at('12:01:30', 'temperature', 72.4, { sequence: 5, future: true }),
    at('11:59:30', 'vibration', 0.31, { sequence: 6 }),
    at('11:59:30', 'status', 1, { sequence: 7 }),
  ]

  async function findPage(readings: Reading[]) {
    installFakeApi({ devices: [CHILLER], readings })
    const view = renderApp({ path: '/devices/dev-1' })
    const page = await findHistoryPage('Chiller 1')
    return { ...view, page }
  }

  it('draws a chart per continuous metric above the reading table', async () => {
    const { page } = await findPage(READINGS)

    expect(await findChart(page, 'temperature')).toHaveAccessibleName(
      expect.stringMatching(/^temperature, current 72\.4, range 68\.1 to 75\.2 over the last/),
    )
    expect(await findChart(page, 'vibration')).toHaveAccessibleName(
      expect.stringMatching(/, 2 gaps$/),
    )
    expect(await findChart(page, 'power_draw')).toHaveAccessibleName(
      expect.stringMatching(/, 1 gap$/),
    )
    expect(within(page).queryByRole('img', { name: /^status\b/ })).not.toBeInTheDocument()
    expect(within(page).getByRole('table', { name: 'Reading history' })).toBeInTheDocument()
  })

  it('labels clock-time x ticks every 2 minutes and 4-5 y ticks', async () => {
    const { page } = await findPage(READINGS)

    const temperature = await findChart(page, 'temperature')

    const clockTicks = within(temperature).getAllByText(/^\d{1,2}:\d{2}(:00)?(\s?[AP]M)?$/i)
    expect(clockTicks.length).toBeGreaterThanOrEqual(5)
    expect(clockTicks.length).toBeLessThanOrEqual(6)
    // The y ticks, plus the end label "72.4".
    const numbers = within(temperature).getAllByText(/^-?\d+(\.\d+)?$/)
    expect(numbers.length).toBeGreaterThanOrEqual(5)
    expect(numbers.length).toBeLessThanOrEqual(6)
  })

  it('keeps a future reading as the latest point and counts the gap before it', async () => {
    const { page } = await findPage(FLAGGED)

    const temperature = await findChart(page, 'temperature')

    expect(temperature).toHaveAccessibleName(
      expect.stringMatching(/^temperature, current 72\.4, range 68\.1 to 75\.2 .*, 1 gap$/),
    )
    expect(within(temperature).getByText('72.4')).toBeInTheDocument()
  })

  it('describes late, out-of-order and future flags in the tooltip', async () => {
    const { page, user } = await findPage(FLAGGED)
    const temperature = await findChart(page, 'temperature')

    await tabTo(user, temperature)

    const tooltip = await screen.findByRole('tooltip')
    expect(tooltip).toHaveTextContent('72.4')
    expect(tooltip).toHaveTextContent(/future/i)

    await user.keyboard('{ArrowLeft}')
    expect(screen.getByRole('tooltip')).toHaveTextContent('71.6')
    expect(screen.getByRole('tooltip')).not.toHaveTextContent(/late|out of order|future/i)

    await user.keyboard('{ArrowLeft}')
    expect(screen.getByRole('tooltip')).toHaveTextContent('70.3')
    expect(screen.getByRole('tooltip')).toHaveTextContent(/out of order/i)

    await user.keyboard('{ArrowLeft}')
    expect(screen.getByRole('tooltip')).toHaveTextContent('75.2')
    expect(screen.getByRole('tooltip')).toHaveTextContent(/late/i)
    expect(screen.getByRole('tooltip')).toHaveTextContent('gw-1')
  })

  it('explains the hollow-ring flag marker in a key under the charts', async () => {
    const { page } = await findPage(FLAGGED)
    await findChart(page, 'temperature')

    expect(within(page).getByText(/late.*out of order.*future/i)).toBeInTheDocument()
  })
})
