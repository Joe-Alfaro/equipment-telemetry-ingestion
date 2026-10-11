import type { ClockWarning } from '@telemetry/shared'
import { act, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import {
  installFakeApi,
  metric,
  reading,
  registeredDevice,
  unregisteredDevice,
} from './test/fakeApi'
import { latestEventSource } from './test/fakeEventSource'
import { findHistoryPage, findRegion, openNewDevices, renderApp } from './test/renderApp'

// UI rules 4-6: "View history" navigates to /devices/<encoded deviceId>, a page of its own.

const fastClock: ClockWarning = { gatewayId: 'gw-fast', status: 'ahead', offsetMs: 120_000 }

describe('history page navigation (UI rules 4 and 6)', () => {
  it('opens from a board card at /devices/<deviceId>, with no inline detail region', async () => {
    installFakeApi({
      devices: [registeredDevice('dev-1', 'Chiller 1')],
      readings: [reading({ deviceId: 'dev-1', value: 20.1 })],
    })
    const { user } = renderApp()
    const board = await findRegion('Equipment')
    const card = await within(board).findByRole('article', { name: 'Chiller 1' })

    await user.click(within(card).getByRole('button', { name: 'View history' }))

    const page = await findHistoryPage('Chiller 1')
    await waitFor(() => expect(window.location.pathname).toBe('/devices/dev-1'))
    const table = await within(page).findByRole('table', { name: 'Reading history' })
    expect(within(table).getByRole('cell', { name: '20.1' })).toBeInTheDocument()
    expect(screen.queryByRole('region', { name: 'Device detail' })).not.toBeInTheDocument()
  })

  it('encodes the device ID in the URL', async () => {
    installFakeApi({
      devices: [registeredDevice('line/7 east', 'Pump East')],
      readings: [reading({ deviceId: 'line/7 east', value: 4.5 })],
    })
    const { user } = renderApp()
    const board = await findRegion('Equipment')
    const card = await within(board).findByRole('article', { name: 'Pump East' })

    await user.click(within(card).getByRole('button', { name: 'View history' }))

    const page = await findHistoryPage('Pump East')
    expect(window.location.pathname).toBe('/devices/line%2F7%20east')
    expect(await within(page).findByRole('cell', { name: '4.5' })).toBeInTheDocument()
  })

  it('opens from a drawer card, closes the drawer and names an unclaimed device by its ID', async () => {
    installFakeApi({
      devices: [unregisteredDevice('dev-2'), unregisteredDevice('dev-4')],
      readings: [
        reading({ deviceId: 'dev-2', value: 20.5 }),
        reading({ deviceId: 'dev-4', value: 99.9 }),
      ],
    })
    const { user } = renderApp()
    const drawer = await openNewDevices(user)
    const card = await within(drawer).findByRole('article', { name: 'dev-2' })

    await user.click(within(card).getByRole('button', { name: 'View history' }))

    const page = await findHistoryPage('dev-2')
    expect(window.location.pathname).toBe('/devices/dev-2')
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    const table = await within(page).findByRole('table', { name: 'Reading history' })
    expect(within(table).getByRole('cell', { name: '20.5' })).toBeInTheDocument()
    expect(within(table).queryByRole('cell', { name: '99.9' })).not.toBeInTheDocument()
  })

  it('goes back to the board with the "Back to equipment" link', async () => {
    installFakeApi({ devices: [registeredDevice('dev-1', 'Chiller 1')] })
    const { user } = renderApp({ path: '/devices/dev-1' })
    const page = await findHistoryPage('Chiller 1')
    const back = within(page).getByRole('link', { name: 'Back to equipment' })
    expect(back).toHaveAttribute('href', '/')

    await user.click(back)

    const board = await findRegion('Equipment')
    expect(window.location.pathname).toBe('/')
    expect(await within(board).findByRole('article', { name: 'Chiller 1' })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { level: 2, name: 'Chiller 1' })).not.toBeInTheDocument()
  })

  it('goes back to the board with the browser back button', async () => {
    installFakeApi({ devices: [registeredDevice('dev-1', 'Chiller 1')] })
    const { user } = renderApp()
    const board = await findRegion('Equipment')
    const card = await within(board).findByRole('article', { name: 'Chiller 1' })
    await user.click(within(card).getByRole('button', { name: 'View history' }))
    await findHistoryPage('Chiller 1')

    act(() => window.history.back())

    const again = await findRegion('Equipment')
    await waitFor(() => expect(window.location.pathname).toBe('/'))
    expect(await within(again).findByRole('article', { name: 'Chiller 1' })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { level: 2, name: 'Chiller 1' })).not.toBeInTheDocument()
  })

  it('loads directly from a /devices/<encoded deviceId> URL', async () => {
    installFakeApi({
      devices: [registeredDevice('line/7 east', 'Pump East')],
      readings: [reading({ deviceId: 'line/7 east', value: 4.5 })],
    })
    renderApp({ path: '/devices/line%2F7%20east' })

    const page = await findHistoryPage('Pump East')

    expect(await within(page).findByRole('cell', { name: '4.5' })).toBeInTheDocument()
    expect(screen.queryByRole('region', { name: 'Equipment' })).not.toBeInTheDocument()
  })

  it('shows "Device not found" with a link back for an unknown device', async () => {
    installFakeApi({ devices: [registeredDevice('dev-1', 'Chiller 1')] })
    const { user } = renderApp({ path: '/devices/nope' })

    expect(await screen.findByText(/device not found/i)).toBeInTheDocument()
    const back = screen.getByRole('link', { name: /back/i })
    expect(back).toHaveAttribute('href', '/')
    expect(screen.queryByRole('table')).not.toBeInTheDocument()

    await user.click(back)

    expect(await findRegion('Equipment')).toBeInTheDocument()
    expect(window.location.pathname).toBe('/')
  })
})

describe('history page content (UI rule 4)', () => {
  it('shows the status, current values and badges above the reading history', async () => {
    installFakeApi({
      devices: [
        registeredDevice('dev-1', 'Chiller 1', {
          possiblyBehind: true,
          clockWarnings: [fastClock],
          metrics: {
            temperature: metric({ value: 21.5 }),
            power_kw: metric({ value: 3.25, sequence: 2 }),
          },
        }),
      ],
      readings: [],
    })
    renderApp({ path: '/devices/dev-1' })

    const page = await findHistoryPage('Chiller 1')

    expect(await within(page).findByText(/^registered$/i)).toBeInTheDocument()
    expect(within(page).getByText('temperature')).toBeInTheDocument()
    expect(within(page).getByText('21.5')).toBeInTheDocument()
    expect(within(page).getByText('power_kw')).toBeInTheDocument()
    expect(within(page).getByText('3.25')).toBeInTheDocument()
    expect(within(page).getByText(/^possibly behind$/i)).toBeInTheDocument()
    expect(within(page).getByText('Clock ahead ~2m')).toHaveAccessibleDescription(
      expect.stringContaining('gw-fast'),
    )
    expect(await within(page).findByText(/no readings yet/i)).toBeInTheDocument()
  })

  it('shows "Unregistered" and no badges for a plain unclaimed device', async () => {
    installFakeApi({ devices: [unregisteredDevice('dev-2')] })
    renderApp({ path: '/devices/dev-2' })

    const page = await findHistoryPage('dev-2')

    expect(await within(page).findByText(/^unregistered$/i)).toBeInTheDocument()
    expect(within(page).queryByText(/^possibly behind$/i)).not.toBeInTheDocument()
    expect(within(page).queryByText(/^clock ahead/i)).not.toBeInTheDocument()
  })

  it('live-updates the current values and history on device-updated for this device', async () => {
    const api = installFakeApi({
      devices: [
        registeredDevice('dev-1', 'Chiller 1', {
          metrics: { temperature: metric({ value: 20.1 }) },
        }),
      ],
      readings: [reading({ deviceId: 'dev-1', sequence: 1, value: 20.1 })],
    })
    renderApp({ path: '/devices/dev-1' })
    const page = await findHistoryPage('Chiller 1')
    const table = await within(page).findByRole('table', { name: 'Reading history' })
    expect(within(table).getAllByRole('row')).toHaveLength(2)

    api.upsertDevice(
      registeredDevice('dev-1', 'Chiller 1', {
        metrics: { temperature: metric({ value: 23.75, sequence: 2 }) },
      }),
    )
    api.state.readings.push(
      reading({
        deviceId: 'dev-1',
        sequence: 2,
        value: 23.75,
        eventTime: '2026-10-10T11:59:30.000Z',
      }),
    )
    act(() => latestEventSource().emit('device-updated', { deviceId: 'dev-1' }))

    await waitFor(() =>
      expect(
        within(within(page).getByRole('table', { name: 'Reading history' })).getAllByRole('row'),
      ).toHaveLength(3),
    )
    // The new value is in both the current values and the history table.
    expect(within(page).getAllByText('23.75')).toHaveLength(2)
  })
})
