import type { ClockWarning } from '@telemetry/shared'
import { screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { installFakeApi, registeredDevice, unregisteredDevice } from './test/fakeApi'
import { findNewDevicesButton, findRegion, openNewDevices, renderApp } from './test/renderApp'

// UI rules 2 and 3: unregistered devices live in a "New devices" drawer opened from the header;
// the board keeps only the registered equipment.

const fastClock: ClockWarning = { gatewayId: 'gw-fast', status: 'ahead', offsetMs: 120_000 }

describe('"New devices" drawer (UI rule 2)', () => {
  it('opens a modal dialog with a card per unregistered device', async () => {
    installFakeApi({
      devices: [
        unregisteredDevice('dev-2', { possiblyBehind: true, clockWarnings: [fastClock] }),
        unregisteredDevice('dev-4'),
        registeredDevice('dev-1', 'Chiller 1'),
      ],
    })
    const { user } = renderApp()

    const drawer = await openNewDevices(user)
    const dev2 = await within(drawer).findByRole('article', { name: 'dev-2' })
    const dev4 = within(drawer).getByRole('article', { name: 'dev-4' })

    expect(drawer).toHaveAttribute('aria-modal', 'true')
    expect(within(drawer).getAllByRole('article')).toHaveLength(2)
    expect(within(dev2).getByRole('textbox', { name: 'Device name' })).toBeInTheDocument()
    expect(within(dev2).getByRole('button', { name: 'Claim' })).toBeInTheDocument()
    expect(within(dev2).getByRole('button', { name: 'View history' })).toBeInTheDocument()
    expect(within(dev2).getByText(/^possibly behind$/i)).toBeInTheDocument()
    expect(within(dev2).getByText('Clock ahead ~2m')).toBeInTheDocument()
    expect(within(dev4).queryByText(/^possibly behind$/i)).not.toBeInTheDocument()
    expect(within(drawer).queryByText('Chiller 1')).not.toBeInTheDocument()
  })

  it('closes with the Close button and returns focus to the header button', async () => {
    installFakeApi({ devices: [unregisteredDevice('dev-2')] })
    const { user } = renderApp()
    const button = await findNewDevicesButton()

    const drawer = await openNewDevices(user)
    await user.click(within(drawer).getByRole('button', { name: 'Close' }))

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(button).toHaveFocus()
  })

  it('closes with Escape and returns focus to the header button', async () => {
    installFakeApi({ devices: [unregisteredDevice('dev-2')] })
    const { user } = renderApp()
    const button = await findNewDevicesButton()

    await openNewDevices(user)
    await user.keyboard('{Escape}')

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(button).toHaveFocus()
  })

  it('closes on a click outside the drawer and returns focus to the header button', async () => {
    installFakeApi({ devices: [unregisteredDevice('dev-2')] })
    const { user } = renderApp()
    const button = await findNewDevicesButton()

    const drawer = await openNewDevices(user)
    // A click inside does not close it.
    await user.click(await within(drawer).findByRole('article', { name: 'dev-2' }))
    expect(screen.getByRole('dialog', { name: 'New devices' })).toBeInTheDocument()
    await user.click(document.body)

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(button).toHaveFocus()
  })

  it('removes a claimed card and decrements the badge', async () => {
    installFakeApi({ devices: [unregisteredDevice('dev-2'), unregisteredDevice('dev-4')] })
    const { user } = renderApp()
    const board = await findRegion('Equipment')
    await screen.findByRole('button', {
      name: 'New devices, 2 waiting',
    })

    const drawer = await openNewDevices(user)
    const card = await within(drawer).findByRole('article', { name: 'dev-2' })
    await user.type(within(card).getByRole('textbox', { name: 'Device name' }), 'Boiler 7')
    await user.click(within(card).getByRole('button', { name: 'Claim' }))

    expect(await within(board).findByRole('article', { name: 'Boiler 7' })).toBeInTheDocument()
    await waitFor(() =>
      expect(within(drawer).queryByRole('article', { name: 'dev-2' })).not.toBeInTheDocument(),
    )
    expect(within(drawer).getByRole('article', { name: 'dev-4' })).toBeInTheDocument()
    expect(
      await screen.findByRole('button', {
        name: 'New devices, 1 waiting',
      }),
    ).toBeInTheDocument()
  })

  it('says "No new devices" when there are none', async () => {
    installFakeApi({ devices: [registeredDevice('dev-1', 'Chiller 1')] })
    const { user } = renderApp()

    const drawer = await openNewDevices(user)

    expect(await within(drawer).findByText(/no new devices/i)).toBeInTheDocument()
    expect(within(drawer).queryByRole('article')).not.toBeInTheDocument()
  })
})

describe('board without the inline inbox (UI rules 3 and 5)', () => {
  it('shows only the Equipment region on the main page', async () => {
    installFakeApi({
      devices: [registeredDevice('dev-1', 'Chiller 1'), unregisteredDevice('dev-2')],
    })
    renderApp()
    const board = await findRegion('Equipment')
    await within(board).findByRole('article', { name: 'Chiller 1' })
    // The header button only exists in the new UI; waiting for it proves the app is the new one.
    await findNewDevicesButton()

    expect(screen.queryByRole('region', { name: 'New devices' })).not.toBeInTheDocument()
    expect(screen.queryByRole('region', { name: 'Device detail' })).not.toBeInTheDocument()
    expect(screen.queryByRole('article', { name: 'dev-2' })).not.toBeInTheDocument()
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
  })
})
