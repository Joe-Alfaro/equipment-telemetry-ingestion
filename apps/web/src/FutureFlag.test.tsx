import { within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { installFakeApi, reading, registeredDevice } from './test/fakeApi'
import { findRegion, renderApp } from './test/renderApp'

// Decided rule 4/6: readings with event_time too far ahead of processing are flagged, not dropped.
describe('Device detail: future timestamps', () => {
  it('labels future readings "Future timestamp" alongside the late and out-of-order labels', async () => {
    installFakeApi({
      devices: [registeredDevice('dev-1', 'Chiller 1')],
      readings: [
        reading({
          deviceId: 'dev-1',
          sequence: 1,
          value: 10,
          eventTime: '2026-10-10T11:59:00.000Z',
        }),
        reading({
          deviceId: 'dev-1',
          sequence: 2,
          value: 20,
          eventTime: '2026-10-10T11:59:10.000Z',
          late: true,
        }),
        reading({
          deviceId: 'dev-1',
          sequence: 3,
          value: 30,
          eventTime: '2026-10-10T12:10:00.000Z',
          future: true,
        }),
        reading({
          deviceId: 'dev-1',
          sequence: 4,
          value: 40,
          eventTime: '2026-10-10T12:20:00.000Z',
          future: true,
          outOfOrder: true,
        }),
      ],
    })
    const { user } = renderApp()
    const board = await findRegion('Equipment')
    const card = await within(board).findByRole('article', { name: 'Chiller 1' })
    await user.click(within(card).getByRole('button', { name: 'View history' }))

    const detail = await findRegion('Device detail')
    const table = await within(detail).findByRole('table', { name: 'Reading history' })
    const [, ...rows] = within(table).getAllByRole('row')
    const [plain, late, future, futureOutOfOrder] = rows.map((row) => within(row))

    expect(rows).toHaveLength(4)
    expect(plain?.queryByText(/^future timestamp$/i)).not.toBeInTheDocument()
    expect(late?.getByText(/^late$/i)).toBeInTheDocument()
    expect(late?.queryByText(/^future timestamp$/i)).not.toBeInTheDocument()
    expect(future?.getByText(/^future timestamp$/i)).toBeInTheDocument()
    expect(future?.queryByText(/^late$/i)).not.toBeInTheDocument()
    expect(future?.queryByText(/^out of order$/i)).not.toBeInTheDocument()
    expect(futureOutOfOrder?.getByText(/^future timestamp$/i)).toBeInTheDocument()
    expect(futureOutOfOrder?.getByText(/^out of order$/i)).toBeInTheDocument()
  })
})
