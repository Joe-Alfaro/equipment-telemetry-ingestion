import type { DeviceSummary, Reading } from '@telemetry/shared'
import { describe, expect, it } from 'vitest'
import { installFakeApi, reading, registeredDevice, unregisteredDevice } from './fakeApi'
import { FakeEventSource, latestEventSource } from './fakeEventSource'

// The fakes are test infrastructure; these checks keep the red UI tests honest by proving the
// boundary itself behaves like the contract in @telemetry/shared.
describe('fake read API (MSW)', () => {
  it('filters devices by status', async () => {
    installFakeApi({
      devices: [registeredDevice('dev-1', 'Chiller 1'), unregisteredDevice('dev-2')],
    })

    const response = await fetch('/api/devices?status=unregistered')
    const devices = (await response.json()) as DeviceSummary[]

    expect(devices.map((d) => d.deviceId)).toEqual(['dev-2'])
  })

  it('returns readings ordered by event time', async () => {
    installFakeApi({
      devices: [registeredDevice('dev-1', 'Chiller 1')],
      readings: [
        reading({ deviceId: 'dev-1', sequence: 2, eventTime: '2026-10-10T11:59:30.000Z' }),
        reading({ deviceId: 'dev-1', sequence: 1, eventTime: '2026-10-10T11:59:10.000Z' }),
      ],
    })

    const response = await fetch('/api/devices/dev-1/readings')
    const history = (await response.json()) as Reading[]

    expect(history.map((r) => r.sequence)).toEqual([1, 2])
  })

  it('keeps only readings at or after since', async () => {
    installFakeApi({
      devices: [registeredDevice('dev-1', 'Chiller 1')],
      readings: [
        reading({ deviceId: 'dev-1', sequence: 1, eventTime: '2026-10-10T11:49:59.999Z' }),
        reading({ deviceId: 'dev-1', sequence: 2, eventTime: '2026-10-10T11:50:00.000Z' }),
      ],
    })

    const since = encodeURIComponent('2026-10-10T11:50:00.000Z')
    const response = await fetch(`/api/devices/dev-1/readings?since=${since}`)
    const history = (await response.json()) as Reading[]

    expect(history.map((r) => r.sequence)).toEqual([2])
  })

  it('claims once, then answers 409 with the current device', async () => {
    const api = installFakeApi({ devices: [unregisteredDevice('dev-2')] })
    const claim = (name: string) =>
      fetch('/api/devices/dev-2/claim', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name }),
      })

    const first = await claim('Boiler 7')
    const second = await claim('Other')

    expect(first.status).toBe(200)
    expect(second.status).toBe(409)
    expect(((await second.json()) as DeviceSummary).name).toBe('Boiler 7')
    expect(api.requests.filter((r) => r.method === 'POST')).toHaveLength(2)
  })

  it('answers 404 for an unknown device', async () => {
    installFakeApi()

    const response = await fetch('/api/devices/nope/readings')

    expect(response.status).toBe(404)
  })
})

describe('FakeEventSource', () => {
  it('is installed as the global EventSource and dispatches named JSON events', () => {
    const source = new EventSource('/api/stream')
    const received: unknown[] = []
    source.addEventListener('device-updated', (event) => received.push(JSON.parse(event.data)))

    latestEventSource().emit('device-updated', { deviceId: 'dev-1' })
    source.close()
    expect(() => latestEventSource()).toThrow()

    expect(FakeEventSource.instances).toHaveLength(1)
    expect(received).toEqual([{ deviceId: 'dev-1' }])
  })
})
