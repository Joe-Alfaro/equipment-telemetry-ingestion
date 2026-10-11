/** Defaults match docker-compose.test.yml (`npm run test:infra:up`). */
export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://telemetry:telemetry@localhost:55432/telemetry'

export const TEST_AMQP_URL = process.env.TEST_AMQP_URL ?? 'amqp://guest:guest@localhost:55672'
