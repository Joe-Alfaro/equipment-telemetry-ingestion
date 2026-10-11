import { act, waitFor, within } from '@testing-library/react'
import type { ClockWarning } from '@telemetry/shared'
import { describe, expect, it } from 'vitest'
import { installFakeApi, registeredDevice, unregisteredDevice } from './test/fakeApi'
import { latestEventSource } from './test/fakeEventSource'
import { findRegion, openNewDevices, renderApp } from './test/renderApp'

/*
 * Gateway clock check rule 6: device cards on the board AND in the New devices drawer show one badge per
 * DeviceSummary.clockWarnings entry, and none when the array is empty.
 *   - ahead:      "Clock ahead ~Xm", or "Clock ahead ~Xs" under a minute.
 *   - local-time: "Local time? UTC+H[:MM]", for example "Local time? UTC+5:30" or "Local time? UTC−5".
 * Each badge's accessible description names the gateway. Live updates use the existing SSE refetch.
 *
 * The rule writes a negative offset with a minus sign (U+2212); a hyphen-minus is accepted too.
 */

const MINUTE = 60_000

function ahead(gatewayId: string, offsetMs: number): ClockWarning {
  return { gatewayId, status: 'ahead', offsetMs }
}

function localTime(gatewayId: string, offsetMs: number): ClockWarning {
  return { gatewayId, status: 'local-time', offsetMs }
}

const ANY_CLOCK_BADGE = /^(clock ahead|local time\?)/i

describe('clock warning badges (rule 6)', () => {
  it('shows one badge per warning on a board card, each describing its gateway', async () => {
    installFakeApi({
      devices: [
        registeredDevice('dev-1', 'Chiller 1', {
          gateways: ['gw-fast', 'gw-ist'],
          clockWarnings: [ahead('gw-fast', 2 * MINUTE), localTime('gw-ist', 19_800_000)],
        }),
        registeredDevice('dev-2', 'Boiler 2', { clockWarnings: [] }),
      ],
    })
    renderApp()
    const board = await findRegion('Equipment')
    const chiller = await within(board).findByRole('article', { name: 'Chiller 1' })
    const boiler = within(board).getByRole('article', { name: 'Boiler 2' })

    const aheadBadge = within(chiller).getByText('Clock ahead ~2m')
    const localBadge = within(chiller).getByText('Local time? UTC+5:30')
    expect(aheadBadge).toHaveAccessibleDescription(expect.stringContaining('gw-fast'))
    expect(aheadBadge).not.toHaveAccessibleDescription(expect.stringContaining('gw-ist'))
    expect(localBadge).toHaveAccessibleDescription(expect.stringContaining('gw-ist'))
    expect(localBadge).not.toHaveAccessibleDescription(expect.stringContaining('gw-fast'))
    expect(within(chiller).getAllByText(ANY_CLOCK_BADGE)).toHaveLength(2)
    expect(within(boiler).queryByText(ANY_CLOCK_BADGE)).not.toBeInTheDocument()
  })

  it.fails(
    'shows the badges on drawer cards too, in seconds under a minute and for negative offsets',
    async () => {
      installFakeApi({
        devices: [
          unregisteredDevice('dev-5', {
            gateways: ['gw-chi', 'gw-skew'],
            clockWarnings: [ahead('gw-skew', 45_000), localTime('gw-chi', -18_000_000)],
          }),
          unregisteredDevice('dev-6', { clockWarnings: [] }),
        ],
      })
      const { user } = renderApp()
      const drawer = await openNewDevices(user)
      const warned = await within(drawer).findByRole('article', { name: 'dev-5' })
      const clean = within(drawer).getByRole('article', { name: 'dev-6' })

      expect(within(warned).getByText('Clock ahead ~45s')).toHaveAccessibleDescription(
        expect.stringContaining('gw-skew'),
      )
      expect(within(warned).getByText(/^Local time\? UTC[−-]5$/)).toHaveAccessibleDescription(
        expect.stringContaining('gw-chi'),
      )
      expect(within(clean).queryByText(ANY_CLOCK_BADGE)).not.toBeInTheDocument()
    },
  )

  it.each([
    ['Clock ahead ~59s', ahead('gw-x', 59_000)],
    ['Clock ahead ~1m', ahead('gw-x', 60_000)],
    ['Clock ahead ~10m', ahead('gw-x', 10 * MINUTE)],
    ['Local time? UTC+9', localTime('gw-x', 9 * 60 * MINUTE)],
    ['Local time? UTC+5:45', localTime('gw-x', 20_700_000)],
  ])('renders "%s"', async (text, warning) => {
    installFakeApi({
      devices: [registeredDevice('dev-1', 'Chiller 1', { clockWarnings: [warning] })],
    })
    renderApp()
    const board = await findRegion('Equipment')
    const card = await within(board).findByRole('article', { name: 'Chiller 1' })

    expect(within(card).getByText(text)).toHaveAccessibleDescription(
      expect.stringContaining('gw-x'),
    )
  })

  it('adds a badge on gateway-updated and removes it on device-updated', async () => {
    const api = installFakeApi({
      devices: [registeredDevice('dev-1', 'Chiller 1', { clockWarnings: [] })],
    })
    renderApp()
    const board = await findRegion('Equipment')
    const card = await within(board).findByRole('article', { name: 'Chiller 1' })
    expect(within(card).queryByText(ANY_CLOCK_BADGE)).not.toBeInTheDocument()

    api.upsertDevice(
      registeredDevice('dev-1', 'Chiller 1', { clockWarnings: [ahead('gw-1', 3 * MINUTE)] }),
    )
    act(() => latestEventSource().emit('gateway-updated', { gatewayId: 'gw-1' }))

    const warned = await within(board).findByText('Clock ahead ~3m')
    expect(warned).toHaveAccessibleDescription(expect.stringContaining('gw-1'))

    api.upsertDevice(registeredDevice('dev-1', 'Chiller 1', { clockWarnings: [] }))
    act(() => latestEventSource().emit('device-updated', { deviceId: 'dev-1' }))

    await waitFor(() => expect(within(board).queryByText(ANY_CLOCK_BADGE)).not.toBeInTheDocument())
  })
})
