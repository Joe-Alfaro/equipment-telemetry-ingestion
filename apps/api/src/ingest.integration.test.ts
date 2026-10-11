import { createReadingPublisher, type ReadingPublisher } from '@telemetry/broker'
import type { ReadingMessage } from '@telemetry/shared'
import { createTestBroker, getOneMessage, type TestBroker } from '@telemetry/test-harness'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildApp } from './app'

describe('POST /ingest/readings -> RabbitMQ', () => {
  const ctx: { broker?: TestBroker; publisher?: ReadingPublisher } = {}

  beforeAll(async () => {
    ctx.broker = await createTestBroker()
    ctx.publisher = await createReadingPublisher(ctx.broker.connection, ctx.broker.queue)
  })

  afterAll(async () => {
    await ctx.publisher?.close()
    await ctx.broker?.close()
  })

  it('returns 202 only after the reading is on the durable queue', async () => {
    const broker = ctx.broker as TestBroker
    const app = buildApp({ publisher: ctx.publisher as ReadingPublisher })
    const reading = {
      gateway_id: 'gw-it',
      device_id: 'dev-it',
      metric: 'temperature',
      value: 21.5,
      event_time: '2026-10-10T12:00:00.123456+00:00',
      sequence: 7,
    }

    const response = await app.inject({ method: 'POST', url: '/ingest/readings', payload: reading })

    expect(response.statusCode).toBe(202)
    const message = await getOneMessage(broker.connection, broker.queue)
    expect(message).not.toBeNull()
    const decoded = JSON.parse(message?.content.toString('utf8') ?? '') as ReadingMessage
    expect(decoded.reading).toEqual(reading)
    expect(Date.parse(decoded.receivedAt)).not.toBeNaN()
  })
})
