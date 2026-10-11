import { within } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { describe, expect, it } from 'vitest'
import { installFakeApi, reading, registeredDevice } from './test/fakeApi'
import { findRegion, renderApp } from './test/renderApp'
import { server } from './test/server'

const chiller = registeredDevice('dev-1', 'Chiller 1')

async function openHistory(user: ReturnType<typeof renderApp>['user'], deviceName: string) {
  const board = await findRegion('Equipment')
  const card = await within(board).findByRole('article', { name: deviceName })
  await user.click(within(card).getByRole('button', { name: 'View history' }))
  return findRegion('Device detail')
}

describe('Device detail', () => {
  it.fails(
    'shows the reading history in event-time order with late and out-of-order flags',
    async () => {
      installFakeApi({
        devices: [chiller],
        readings: [
          reading({
            deviceId: 'dev-1',
            sequence: 3,
            value: 22.4,
            eventTime: '2026-10-10T11:59:40.000Z',
            outOfOrder: true,
          }),
          reading({
            deviceId: 'dev-1',
            sequence: 1,
            value: 20.1,
            eventTime: '2026-10-10T11:59:00.000Z',
          }),
          reading({
            deviceId: 'dev-1',
            sequence: 2,
            value: 21.7,
            eventTime: '2026-10-10T11:59:20.000Z',
            late: true,
          }),
        ],
      })
      const { user } = renderApp()

      const detail = await openHistory(user, 'Chiller 1')
      const table = await within(detail).findByRole('table', { name: 'Reading history' })
      const [, ...rows] = within(table).getAllByRole('row')

      expect(within(detail).getByRole('heading', { name: 'Chiller 1' })).toBeInTheDocument()
      expect(rows).toHaveLength(3)
      const [first, second, third] = rows.map((row) => within(row))
      expect(first?.getByRole('cell', { name: '20.1' })).toBeInTheDocument()
      expect(first?.queryByText(/^late$/i)).not.toBeInTheDocument()
      expect(first?.queryByText(/^out of order$/i)).not.toBeInTheDocument()
      expect(second?.getByRole('cell', { name: '21.7' })).toBeInTheDocument()
      expect(second?.getByText(/^late$/i)).toBeInTheDocument()
      expect(second?.queryByText(/^out of order$/i)).not.toBeInTheDocument()
      expect(third?.getByRole('cell', { name: '22.4' })).toBeInTheDocument()
      expect(third?.getByText(/^out of order$/i)).toBeInTheDocument()
      expect(third?.queryByText(/^late$/i)).not.toBeInTheDocument()
    },
  )

  it.fails('shows each reading’s metric, gateway and sequence', async () => {
    installFakeApi({
      devices: [chiller],
      readings: [
        reading({
          deviceId: 'dev-1',
          metric: 'power_kw',
          gatewayId: 'gw-9',
          sequence: 41,
          value: 3.25,
        }),
      ],
    })
    const { user } = renderApp()

    const detail = await openHistory(user, 'Chiller 1')
    const table = await within(detail).findByRole('table', { name: 'Reading history' })
    const [, row] = within(table).getAllByRole('row')
    const cells = within(row as HTMLElement)

    expect(cells.getByRole('cell', { name: 'power_kw' })).toBeInTheDocument()
    expect(cells.getByRole('cell', { name: 'gw-9' })).toBeInTheDocument()
    expect(cells.getByRole('cell', { name: '41' })).toBeInTheDocument()
    expect(cells.getByRole('cell', { name: '3.25' })).toBeInTheDocument()
  })

  it.fails('flags a reading that is both late and out of order with both labels', async () => {
    installFakeApi({
      devices: [chiller],
      readings: [reading({ deviceId: 'dev-1', late: true, outOfOrder: true })],
    })
    const { user } = renderApp()

    const detail = await openHistory(user, 'Chiller 1')
    const table = await within(detail).findByRole('table', { name: 'Reading history' })
    const [, row] = within(table).getAllByRole('row')

    expect(within(row as HTMLElement).getByText(/^late$/i)).toBeInTheDocument()
    expect(within(row as HTMLElement).getByText(/^out of order$/i)).toBeInTheDocument()
  })

  it.fails('says so when a device has no readings', async () => {
    installFakeApi({ devices: [chiller], readings: [] })
    const { user } = renderApp()

    const detail = await openHistory(user, 'Chiller 1')

    expect(await within(detail).findByText(/no readings yet/i)).toBeInTheDocument()
  })

  it.fails('shows an alert when the history cannot be loaded', async () => {
    installFakeApi({ devices: [chiller] })
    server.use(
      http.get('/api/devices/:deviceId/readings', () =>
        HttpResponse.json({ error: 'internal error' }, { status: 500 }),
      ),
    )
    const { user } = renderApp()

    const detail = await openHistory(user, 'Chiller 1')

    expect(await within(detail).findByRole('alert')).toHaveTextContent(/could not load/i)
    expect(within(detail).queryByRole('table')).not.toBeInTheDocument()
  })
})
