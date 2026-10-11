import { within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { installFakeApi, reading, unregisteredDevice } from './test/fakeApi'
import { findRegion, renderApp } from './test/renderApp'

// Decided rule 6: inbox cards show "Possibly behind" and open the same Device detail as the board.
describe('New devices inbox: staleness and history', () => {
  it('badges an unregistered device as possibly behind only when it is', async () => {
    installFakeApi({
      devices: [
        unregisteredDevice('dev-2', { possiblyBehind: true }),
        unregisteredDevice('dev-4', { possiblyBehind: false }),
      ],
    })
    renderApp()
    const inbox = await findRegion('New devices')

    const behind = await within(inbox).findByRole('article', { name: 'dev-2' })
    const current = within(inbox).getByRole('article', { name: 'dev-4' })

    expect(within(behind).getByText(/^possibly behind$/i)).toBeInTheDocument()
    expect(within(current).queryByText(/^possibly behind$/i)).not.toBeInTheDocument()
  })

  it('opens the device detail with its reading history from an inbox card', async () => {
    installFakeApi({
      devices: [unregisteredDevice('dev-2'), unregisteredDevice('dev-4')],
      readings: [
        reading({ deviceId: 'dev-2', sequence: 1, value: 20.5 }),
        reading({
          deviceId: 'dev-2',
          sequence: 2,
          value: 21.5,
          eventTime: '2026-10-10T11:59:10.000Z',
        }),
        reading({ deviceId: 'dev-4', sequence: 1, value: 99.9 }),
      ],
    })
    const { user } = renderApp()
    const inbox = await findRegion('New devices')
    const card = await within(inbox).findByRole('article', { name: 'dev-2' })

    await user.click(within(card).getByRole('button', { name: 'View history' }))

    const detail = await findRegion('Device detail')
    const table = await within(detail).findByRole('table', { name: 'Reading history' })
    const [, ...rows] = within(table).getAllByRole('row')
    expect(within(detail).getByRole('heading', { level: 3, name: 'dev-2' })).toBeInTheDocument()
    expect(rows).toHaveLength(2)
    expect(within(rows[0] as HTMLElement).getByRole('cell', { name: '20.5' })).toBeInTheDocument()
    expect(within(rows[1] as HTMLElement).getByRole('cell', { name: '21.5' })).toBeInTheDocument()
    expect(within(table).queryByRole('cell', { name: '99.9' })).not.toBeInTheDocument()
  })
})
