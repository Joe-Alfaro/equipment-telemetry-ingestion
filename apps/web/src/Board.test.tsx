import { within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { installFakeApi, metric, registeredDevice, unregisteredDevice } from './test/fakeApi'
import { findRegion, renderApp } from './test/renderApp'

describe('Equipment board', () => {
  it('lists each registered device with its current value per metric', async () => {
    installFakeApi({
      devices: [
        registeredDevice('dev-1', 'Chiller 1', {
          metrics: {
            temperature: metric({ value: 21.5 }),
            power_kw: metric({ value: 3.25, sequence: 2 }),
          },
        }),
        registeredDevice('dev-3', 'AHU 2', {
          metrics: { vibration: metric({ value: 0.04 }) },
        }),
      ],
    })
    renderApp()
    const board = await findRegion('Equipment')

    const chiller = await within(board).findByRole('article', { name: 'Chiller 1' })
    const ahu = within(board).getByRole('article', { name: 'AHU 2' })

    expect(within(chiller).getByText('temperature')).toBeInTheDocument()
    expect(within(chiller).getByText('21.5')).toBeInTheDocument()
    expect(within(chiller).getByText('power_kw')).toBeInTheDocument()
    expect(within(chiller).getByText('3.25')).toBeInTheDocument()
    expect(within(ahu).getByText('vibration')).toBeInTheDocument()
    expect(within(ahu).getByText('0.04')).toBeInTheDocument()
    expect(within(ahu).queryByText('temperature')).not.toBeInTheDocument()
  })

  it('shows when each metric value was measured', async () => {
    installFakeApi({
      devices: [
        registeredDevice('dev-1', 'Chiller 1', {
          metrics: { temperature: metric({ value: 21.5 }) },
        }),
      ],
    })
    renderApp()
    const board = await findRegion('Equipment')

    const chiller = await within(board).findByRole('article', { name: 'Chiller 1' })

    expect(within(chiller).getByText(/as of/i)).toBeInTheDocument()
  })

  it('does not show unregistered devices on the board', async () => {
    installFakeApi({
      devices: [registeredDevice('dev-1', 'Chiller 1'), unregisteredDevice('dev-2')],
    })
    renderApp()
    const board = await findRegion('Equipment')

    await within(board).findByRole('article', { name: 'Chiller 1' })

    expect(within(board).getAllByRole('article')).toHaveLength(1)
    expect(within(board).queryByText('dev-2')).not.toBeInTheDocument()
  })

  it('badges a device as possibly behind when one of its gateways is stale', async () => {
    installFakeApi({
      devices: [
        registeredDevice('dev-1', 'Chiller 1', { possiblyBehind: true }),
        registeredDevice('dev-3', 'AHU 2', { possiblyBehind: false }),
      ],
    })
    renderApp()
    const board = await findRegion('Equipment')

    const chiller = await within(board).findByRole('article', { name: 'Chiller 1' })
    const ahu = within(board).getByRole('article', { name: 'AHU 2' })

    expect(within(chiller).getByText(/possibly behind/i)).toBeInTheDocument()
    expect(within(ahu).queryByText(/possibly behind/i)).not.toBeInTheDocument()
  })
})
