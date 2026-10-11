import { screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { installFakeApi, registeredDevice, unregisteredDevice } from './test/fakeApi'
import { findRegion, renderApp } from './test/renderApp'

describe('accessible structure', () => {
  it('labels each area with a heading', async () => {
    installFakeApi()
    renderApp()

    expect(await findRegion('Equipment')).toBeInTheDocument()
    expect(await findRegion('New devices')).toBeInTheDocument()
    expect(screen.getByRole('heading', { level: 2, name: 'Equipment' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { level: 2, name: 'New devices' })).toBeInTheDocument()
  })

  it('gives every control an accessible name', async () => {
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
    const inbox = await findRegion('New devices')
    const chiller = await within(board).findByRole('article', { name: 'Chiller 1' })
    await within(inbox).findByRole('article', { name: 'dev-4' })
    await user.click(within(chiller).getByRole('button', { name: 'View history' }))
    await findRegion('Device detail')

    const textboxes = screen.getAllByRole('textbox')
    expect(textboxes).toHaveLength(2)
    textboxes.forEach((textbox) => expect(textbox).toHaveAccessibleName('Device name'))
    expect(within(inbox).getAllByRole('button', { name: 'Claim' })).toHaveLength(2)
    expect(within(board).getAllByRole('button', { name: 'View history' })).toHaveLength(2)
    screen.getAllByRole('button').forEach((button) => expect(button).toHaveAccessibleName())
  })
})
