import { within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { installFailingApi, installFakeApi, installPendingApi } from './test/fakeApi'
import { findRegion, renderApp } from './test/renderApp'

describe('loading, empty and error states', () => {
  it('shows a loading message in both lists while devices are being fetched', async () => {
    installPendingApi()
    renderApp()

    const board = await findRegion('Equipment')
    const inbox = await findRegion('New devices')

    expect(within(board).getByText(/loading/i)).toBeInTheDocument()
    expect(within(inbox).getByText(/loading/i)).toBeInTheDocument()
  })

  it('replaces the loading message with an empty message when there are no devices', async () => {
    installFakeApi({ devices: [] })
    renderApp()
    const board = await findRegion('Equipment')
    const inbox = await findRegion('New devices')

    expect(await within(board).findByText(/no equipment yet/i)).toBeInTheDocument()
    expect(await within(inbox).findByText(/no new devices/i)).toBeInTheDocument()
    expect(within(board).queryByText(/loading/i)).not.toBeInTheDocument()
    expect(within(inbox).queryByText(/loading/i)).not.toBeInTheDocument()
  })

  it('shows an alert in each list when devices cannot be loaded', async () => {
    installFailingApi()
    renderApp()
    const board = await findRegion('Equipment')
    const inbox = await findRegion('New devices')

    expect(await within(board).findByRole('alert')).toHaveTextContent(/could not load/i)
    expect(await within(inbox).findByRole('alert')).toHaveTextContent(/could not load/i)
    expect(within(board).queryByText(/loading/i)).not.toBeInTheDocument()
    expect(within(board).queryByText(/no equipment yet/i)).not.toBeInTheDocument()
  })
})
