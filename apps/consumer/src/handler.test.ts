import { describe, expect, it, vi } from 'vitest'
import { createMessageHandler, type AckChannel } from './handler'

const silentLog = { info: () => {}, error: () => {} }

function message(body: unknown) {
  return { content: Buffer.from(JSON.stringify(body)) }
}

describe('consumer handler (smoke)', () => {
  it('acks after the reading is processed', async () => {
    const channel: AckChannel = { ack: vi.fn(), nack: vi.fn() }
    const process = vi.fn(async () => {})
    const handle = createMessageHandler(channel, process, silentLog)
    const delivered = message({
      reading: {
        gateway_id: 'gw-0',
        device_id: 'dev-1',
        metric: 'temperature',
        value: 70,
        event_time: '2026-10-10T12:00:00+00:00',
        sequence: 0,
      },
      receivedAt: '2026-10-10T12:00:00.100Z',
    })

    await handle(delivered)

    expect(process).toHaveBeenCalledOnce()
    expect(channel.ack).toHaveBeenCalledWith(delivered)
    expect(channel.nack).not.toHaveBeenCalled()
  })
})
