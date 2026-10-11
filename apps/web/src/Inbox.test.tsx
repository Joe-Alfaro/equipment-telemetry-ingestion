import { waitFor, within } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { describe, expect, it } from 'vitest'
import { installFakeApi, registeredDevice, unregisteredDevice } from './test/fakeApi'
import { findRegion, renderApp } from './test/renderApp'
import { server } from './test/server'

describe('New devices inbox', () => {
  it('lists each unregistered device with its first-seen gateway', async () => {
    installFakeApi({
      devices: [
        unregisteredDevice('dev-2', { firstSeenGatewayId: 'gw-2' }),
        unregisteredDevice('dev-4', { firstSeenGatewayId: 'gw-3' }),
        registeredDevice('dev-1', 'Chiller 1'),
      ],
    })
    renderApp()
    const inbox = await findRegion('New devices')

    const dev2 = await within(inbox).findByRole('article', { name: 'dev-2' })
    const dev4 = within(inbox).getByRole('article', { name: 'dev-4' })

    expect(within(inbox).getAllByRole('article')).toHaveLength(2)
    expect(within(dev2).getByText(/first seen/i)).toBeInTheDocument()
    expect(within(dev2).getByText(/gw-2/)).toBeInTheDocument()
    expect(within(dev4).getByText(/gw-3/)).toBeInTheDocument()
    expect(within(inbox).queryByText('Chiller 1')).not.toBeInTheDocument()
  })
})

describe('Claim flow', () => {
  it('claims a device by name and moves it from the inbox to the board', async () => {
    const api = installFakeApi({ devices: [unregisteredDevice('dev-2')] })
    const { user } = renderApp()
    const inbox = await findRegion('New devices')
    const board = await findRegion('Equipment')
    const card = await within(inbox).findByRole('article', { name: 'dev-2' })

    await user.type(within(card).getByRole('textbox', { name: 'Device name' }), 'Boiler 7')
    await user.click(within(card).getByRole('button', { name: 'Claim' }))

    expect(await within(board).findByRole('article', { name: 'Boiler 7' })).toBeInTheDocument()
    await waitFor(() =>
      expect(within(inbox).queryByRole('article', { name: 'dev-2' })).not.toBeInTheDocument(),
    )
    expect(api.requests.filter((r) => r.method === 'POST')).toEqual([
      { method: 'POST', path: '/api/devices/dev-2/claim', search: '', body: { name: 'Boiler 7' } },
    ])
  })

  it('submits the claim when Enter is pressed in the name field', async () => {
    installFakeApi({ devices: [unregisteredDevice('dev-2')] })
    const { user } = renderApp()
    const inbox = await findRegion('New devices')
    const board = await findRegion('Equipment')
    const card = await within(inbox).findByRole('article', { name: 'dev-2' })

    await user.type(within(card).getByRole('textbox', { name: 'Device name' }), 'Boiler 7{Enter}')

    expect(await within(board).findByRole('article', { name: 'Boiler 7' })).toBeInTheDocument()
  })

  it('does not send a claim without a name', async () => {
    const api = installFakeApi({ devices: [unregisteredDevice('dev-2')] })
    const { user } = renderApp()
    const inbox = await findRegion('New devices')
    const card = await within(inbox).findByRole('article', { name: 'dev-2' })
    const claim = within(card).getByRole('button', { name: 'Claim' })

    await user.click(claim)

    expect(api.requests.filter((r) => r.method === 'POST')).toHaveLength(0)
    expect(within(inbox).getByRole('article', { name: 'dev-2' })).toBeInTheDocument()
  })

  it('sends one claim when Claim is double-clicked, and disables it while pending', async () => {
    const api = installFakeApi({ devices: [unregisteredDevice('dev-2')] })
    const release = api.holdClaims()
    const { user } = renderApp()
    const inbox = await findRegion('New devices')
    const board = await findRegion('Equipment')
    const card = await within(inbox).findByRole('article', { name: 'dev-2' })
    const claim = within(card).getByRole('button', { name: 'Claim' })

    await user.type(within(card).getByRole('textbox', { name: 'Device name' }), 'Boiler 7')
    await user.dblClick(claim)

    await waitFor(() => expect(claim).toBeDisabled())
    release()
    expect(await within(board).findByRole('article', { name: 'Boiler 7' })).toBeInTheDocument()
    expect(api.requests.filter((r) => r.method === 'POST')).toHaveLength(1)
  })

  it('handles 409 by explaining the device was already claimed and showing it on the board', async () => {
    const api = installFakeApi({ devices: [unregisteredDevice('dev-2')] })
    const { user } = renderApp()
    const inbox = await findRegion('New devices')
    const board = await findRegion('Equipment')
    const card = await within(inbox).findByRole('article', { name: 'dev-2' })
    // Another tab claims the device after this page loaded its inbox.
    api.upsertDevice(registeredDevice('dev-2', 'Claimed Elsewhere'))

    await user.type(within(card).getByRole('textbox', { name: 'Device name' }), 'Boiler 7')
    await user.click(within(card).getByRole('button', { name: 'Claim' }))

    expect(await within(inbox).findByRole('alert')).toHaveTextContent(/already claimed/i)
    expect(
      await within(board).findByRole('article', { name: 'Claimed Elsewhere' }),
    ).toBeInTheDocument()
    expect(within(board).queryByRole('article', { name: 'Boiler 7' })).not.toBeInTheDocument()
    await waitFor(() =>
      expect(within(inbox).queryByRole('article', { name: 'dev-2' })).not.toBeInTheDocument(),
    )
  })

  it('keeps the device in the inbox and re-enables Claim when the claim fails', async () => {
    installFakeApi({ devices: [unregisteredDevice('dev-2')] })
    server.use(
      http.post('/api/devices/:deviceId/claim', () =>
        HttpResponse.json({ error: 'internal error' }, { status: 500 }),
      ),
    )
    const { user } = renderApp()
    const inbox = await findRegion('New devices')
    const card = await within(inbox).findByRole('article', { name: 'dev-2' })
    const claim = within(card).getByRole('button', { name: 'Claim' })

    await user.type(within(card).getByRole('textbox', { name: 'Device name' }), 'Boiler 7')
    await user.click(claim)

    expect(await within(card).findByRole('alert')).toHaveTextContent(/could not claim/i)
    expect(claim).toBeEnabled()
    expect(within(card).getByRole('textbox', { name: 'Device name' })).toHaveValue('Boiler 7')
  })
})
