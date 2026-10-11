import { screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { installFakeApi, registeredDevice, unregisteredDevice } from './test/fakeApi'
import { findHistoryPage, findRegion, openNewDevices, renderApp } from './test/renderApp'

describe('accessible structure', () => {
  it.fails('labels each area with a heading', async () => {
    installFakeApi()
    const { user } = renderApp()

    expect(await findRegion('Equipment')).toBeInTheDocument()
    expect(screen.getByRole('heading', { level: 2, name: 'Equipment' })).toBeInTheDocument()
    const drawer = await openNewDevices(user)
    expect(
      within(drawer).getByRole('heading', { level: 2, name: 'New devices' }),
    ).toBeInTheDocument()
  })

  it.fails('gives every control an accessible name', async () => {
    installFakeApi({
      devices: [
        registeredDevice('dev-1', 'Chiller 1'),
        registeredDevice('dev-3', 'AHU 2'),
        unregisteredDevice('dev-2'),
        unregisteredDevice('dev-4'),
      ],
    })
    const { user } = renderApp()
    const board = await findRegion('Equipment')
    const chiller = await within(board).findByRole('article', { name: 'Chiller 1' })
    await within(board).findByRole('article', { name: 'AHU 2' })
    const drawer = await openNewDevices(user)
    await within(drawer).findByRole('article', { name: 'dev-4' })

    const textboxes = screen.getAllByRole('textbox')
    expect(textboxes).toHaveLength(2)
    textboxes.forEach((textbox) => expect(textbox).toHaveAccessibleName('Device name'))
    expect(within(drawer).getAllByRole('button', { name: 'Claim' })).toHaveLength(2)
    expect(within(drawer).getAllByRole('button', { name: 'View history' })).toHaveLength(2)
    expect(within(board).getAllByRole('button', { name: 'View history' })).toHaveLength(2)
    screen.getAllByRole('button').forEach((button) => expect(button).toHaveAccessibleName())

    await user.click(within(drawer).getByRole('button', { name: 'Close' }))
    await user.click(within(chiller).getByRole('button', { name: 'View history' }))
    await findHistoryPage('Chiller 1')

    screen.getAllByRole('button').forEach((button) => expect(button).toHaveAccessibleName())
    screen.getAllByRole('link').forEach((link) => expect(link).toHaveAccessibleName())
  })
})
