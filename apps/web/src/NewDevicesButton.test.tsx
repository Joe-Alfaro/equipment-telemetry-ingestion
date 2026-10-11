import { act, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { installFakeApi, registeredDevice, unregisteredDevice } from './test/fakeApi'
import { latestEventSource } from './test/fakeEventSource'
import { renderApp } from './test/renderApp'

// UI rule 1: a "New devices" button in the page header, with a live count badge.

describe('header "New devices" button (UI rule 1)', () => {
  it.fails(
    'shows a count badge and names the count when unregistered devices are waiting',
    async () => {
      installFakeApi({
        devices: [
          unregisteredDevice('dev-2'),
          unregisteredDevice('dev-4'),
          unregisteredDevice('dev-5'),
          registeredDevice('dev-1', 'Chiller 1'),
        ],
      })
      renderApp()

      const button = await screen.findByRole('button', { name: 'New devices, 3 waiting' })

      expect(within(button).getByText('3')).toBeInTheDocument()
    },
  )

  it.fails('has no badge and is named just "New devices" when nothing is waiting', async () => {
    const api = installFakeApi({ devices: [registeredDevice('dev-1', 'Chiller 1')] })
    renderApp()
    await screen.findByRole('article', { name: 'Chiller 1' })
    // "No badge" must not pass just because the unregistered devices haven't been fetched yet.
    await waitFor(() =>
      expect(
        api.requests.filter((r) => r.path === '/api/devices' && r.search !== '?status=registered'),
      ).not.toHaveLength(0),
    )

    const button = screen.getByRole('button', { name: 'New devices' })

    expect(within(button).queryByText(/\d/)).not.toBeInTheDocument()
  })

  it.fails('updates the count live when a device is discovered or claimed elsewhere', async () => {
    const api = installFakeApi({ devices: [unregisteredDevice('dev-2')] })
    renderApp()
    await screen.findByRole('button', { name: 'New devices, 1 waiting' })

    api.upsertDevice(unregisteredDevice('dev-5'))
    act(() => latestEventSource().emit('device-discovered', { deviceId: 'dev-5' }))
    const button = await screen.findByRole('button', { name: 'New devices, 2 waiting' })
    expect(within(button).getByText('2')).toBeInTheDocument()

    api.upsertDevice(registeredDevice('dev-2', 'Boiler 7'))
    act(() => latestEventSource().emit('device-claimed', { deviceId: 'dev-2' }))
    expect(
      await screen.findByRole('button', { name: 'New devices, 1 waiting' }),
    ).toBeInTheDocument()

    api.upsertDevice(registeredDevice('dev-5', 'Pump 3'))
    act(() => latestEventSource().emit('device-claimed', { deviceId: 'dev-5' }))
    const empty = await screen.findByRole('button', { name: 'New devices' })
    expect(within(empty).queryByText(/\d/)).not.toBeInTheDocument()
  })

  it.fails('is in the header on the history page too', async () => {
    installFakeApi({
      devices: [registeredDevice('dev-1', 'Chiller 1'), unregisteredDevice('dev-2')],
    })
    renderApp({ path: '/devices/dev-1' })

    await screen.findByRole('heading', { level: 2, name: 'Chiller 1' })

    expect(
      await screen.findByRole('button', { name: 'New devices, 1 waiting' }),
    ).toBeInTheDocument()
  })
})
