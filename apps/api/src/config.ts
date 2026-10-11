export interface ApiConfig {
  port: number
  databaseUrl: string
  amqpUrl: string
  readingsQueue: string
  lateThresholdMs: number
}

function required(name: string): string {
  const value = process.env[name]
  if (!value) {
    throw new Error(`${name} is required`)
  }
  return value
}

export function loadConfig(): ApiConfig {
  return {
    port: Number(process.env.PORT ?? 8080),
    databaseUrl: required('DATABASE_URL'),
    amqpUrl: required('AMQP_URL'),
    readingsQueue: process.env.READINGS_QUEUE ?? 'readings',
    lateThresholdMs: Number(process.env.LATE_THRESHOLD_MS ?? 30_000),
  }
}
