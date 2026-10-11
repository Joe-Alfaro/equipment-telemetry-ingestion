import { within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { installFailingApi, installFakeApi, installPendingApi } from './test/fakeApi'
import { findRegion, openNewDevices, renderApp } from './test/renderApp'

describe('loading, empty and error states', () => {
  it.fails(
    'shows a loading message on the board and in the drawer while devices are being fetched',
    async () => {
      installPendingApi()
      const { user } = renderApp()

      const board = await findRegion('Equipment')
      const drawer = await openNewDevices(user)

      expect(within(board).getByText(/loading/i)).toBeInTheDocument()
      expect(within(drawer).getByText(/loading/i)).toBeInTheDocument()
    },
  )

  it.fails(
    'replaces the loading message with an empty message when there are no devices',
    async () => {
      installFakeApi({ devices: [] })
      const { user } = renderApp()
      const board = await findRegion('Equipment')
      const drawer = await openNewDevices(user)

      expect(await within(board).findByText(/no equipment yet/i)).toBeInTheDocument()
      expect(await within(drawer).findByText(/no new devices/i)).toBeInTheDocument()
      expect(within(board).queryByText(/loading/i)).not.toBeInTheDocument()
      expect(within(drawer).queryByText(/loading/i)).not.toBeInTheDocument()
    },
  )

  it.fails(
    'shows an alert on the board and in the drawer when devices cannot be loaded',
    async () => {
      installFailingApi()
      const { user } = renderApp()
      const board = await findRegion('Equipment')
      const drawer = await openNewDevices(user)

      expect(await within(board).findByRole('alert')).toHaveTextContent(/could not load/i)
      expect(await within(drawer).findByRole('alert')).toHaveTextContent(/could not load/i)
      expect(within(board).queryByText(/loading/i)).not.toBeInTheDocument()
      expect(within(board).queryByText(/no equipment yet/i)).not.toBeInTheDocument()
    },
  )
})
