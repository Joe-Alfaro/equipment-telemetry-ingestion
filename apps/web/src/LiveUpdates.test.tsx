import { act, waitFor, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import {
  gatewaySummary,
  installFakeApi,
  metric,
  reading,
  registeredDevice,
  unregisteredDevice,
} from './test/fakeApi'
import { FakeEventSource, latestEventSource } from './test/fakeEventSource'
import { findRegion, renderApp } from './test/renderApp'

// SSE is simulated by FakeEventSource (src/test/fakeEventSource.ts), installed as the global
// EventSource in setup.ts. Each test changes the fake backend first, then emits the event the
// real api would send, and expects the UI to refetch and show the new state.

function emit(...args: Parameters<FakeEventSource['emit']>) {
  act(() => latestEventSource().emit(...args))
}

describe('live updates over SSE', () => {
  it('opens one stream to /api/stream and closes it on unmount', async () => {
    installFakeApi()
    const { unmount } = renderApp()

    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1))
    const [source] = FakeEventSource.instances
    expect(source?.url).toMatch(/\/api\/stream$/)

    unmount()

    expect(source?.readyState).toBe(FakeEventSource.CLOSED)
  })

  it('refetches a device on device-updated and shows its new value', async () => {
    const api = installFakeApi({
      devices: [
        registeredDevice('dev-1', 'Chiller 1', {
          metrics: { temperature: metric({ value: 21.5 }) },
        }),
      ],
    })
    renderApp()
    const board = await findRegion('Equipment')
    const card = await within(board).findByRole('article', { name: 'Chiller 1' })
    expect(within(card).getByText('21.5')).toBeInTheDocument()

    api.upsertDevice(
      registeredDevice('dev-1', 'Chiller 1', {
        metrics: { temperature: metric({ value: 23.75, sequence: 2 }) },
      }),
    )
    emit('device-updated', { deviceId: 'dev-1' })

    const updated = await within(board).findByRole('article', { name: 'Chiller 1' })
    expect(await within(updated).findByText('23.75')).toBeInTheDocument()
    expect(within(updated).queryByText('21.5')).not.toBeInTheDocument()
  })

  it('adds a device to the inbox on device-discovered', async () => {
    const api = installFakeApi({ devices: [unregisteredDevice('dev-2')] })
    renderApp()
    const inbox = await findRegion('New devices')
    await within(inbox).findByRole('article', { name: 'dev-2' })

    api.upsertDevice(unregisteredDevice('dev-5', { firstSeenGatewayId: 'gw-4' }))
    emit('device-discovered', { deviceId: 'dev-5' })

    const discovered = await within(inbox).findByRole('article', { name: 'dev-5' })
    expect(within(discovered).getByText(/gw-4/)).toBeInTheDocument()
  })

  it('moves a device claimed in another tab to the board on device-claimed', async () => {
    const api = installFakeApi({ devices: [unregisteredDevice('dev-2')] })
    renderApp()
    const inbox = await findRegion('New devices')
    const board = await findRegion('Equipment')
    await within(inbox).findByRole('article', { name: 'dev-2' })

    api.upsertDevice(registeredDevice('dev-2', 'Boiler 7'))
    emit('device-claimed', { deviceId: 'dev-2' })

    expect(await within(board).findByRole('article', { name: 'Boiler 7' })).toBeInTheDocument()
    await waitFor(() =>
      expect(within(inbox).queryByRole('article', { name: 'dev-2' })).not.toBeInTheDocument(),
    )
  })

  it('shows the possibly-behind badge after gateway-updated marks a gateway stale', async () => {
    const api = installFakeApi({
      devices: [registeredDevice('dev-1', 'Chiller 1', { gateways: ['gw-1'] })],
      gateways: [gatewaySummary('gw-1', { lastSeenAt: '2026-10-10T11:59:50.000Z', stale: false })],
    })
    renderApp()
    const board = await findRegion('Equipment')
    const card = await within(board).findByRole('article', { name: 'Chiller 1' })
    expect(within(card).queryByText(/possibly behind/i)).not.toBeInTheDocument()

    api.upsertDevice(
      registeredDevice('dev-1', 'Chiller 1', { gateways: ['gw-1'], possiblyBehind: true }),
    )
    api.state.gateways = [
      gatewaySummary('gw-1', { lastSeenAt: '2026-10-10T11:59:50.000Z', stale: true }),
    ]
    emit('gateway-updated', { gatewayId: 'gw-1' })

    await waitFor(() =>
      expect(
        within(within(board).getByRole('article', { name: 'Chiller 1' })).getByText(
          /possibly behind/i,
        ),
      ).toBeInTheDocument(),
    )
  })

  it('refreshes the open device detail on device-updated', async () => {
    const api = installFakeApi({
      devices: [registeredDevice('dev-1', 'Chiller 1')],
      readings: [reading({ deviceId: 'dev-1', sequence: 1, value: 20.1 })],
    })
    const { user } = renderApp()
    const board = await findRegion('Equipment')
    const card = await within(board).findByRole('article', { name: 'Chiller 1' })
    await user.click(within(card).getByRole('button', { name: 'View history' }))
    const detail = await findRegion('Device detail')
    const table = await within(detail).findByRole('table', { name: 'Reading history' })
    expect(within(table).getAllByRole('row')).toHaveLength(2)

    api.state.readings.push(
      reading({
        deviceId: 'dev-1',
        sequence: 2,
        value: 19.9,
        eventTime: '2026-10-10T11:58:00.000Z',
        outOfOrder: true,
      }),
    )
    emit('device-updated', { deviceId: 'dev-1' })

    await waitFor(() => expect(within(detail).getAllByRole('row')).toHaveLength(3))
    const [, older] = within(detail).getAllByRole('row')
    expect(within(older as HTMLElement).getByRole('cell', { name: '19.9' })).toBeInTheDocument()
    expect(within(older as HTMLElement).getByText(/^out of order$/i)).toBeInTheDocument()
  })
})
