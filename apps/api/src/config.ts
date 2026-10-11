export interface ApiConfig {
  host: string
  port: number
  databaseUrl: string
  amqpUrl: string
  readingsQueue: string
  lateThresholdMs: number
  /** CLOCK_SKEW_THRESHOLD_MS: a gateway clock is `ahead` past this median skew. Default 60000. */
  clockSkewThresholdMs?: number
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
    // Railway's private network may be IPv6-only; set HOST=:: there.
    host: process.env.HOST ?? '0.0.0.0',
    port: Number(process.env.PORT ?? 8080),
    databaseUrl: required('DATABASE_URL'),
    amqpUrl: required('AMQP_URL'),
    readingsQueue: process.env.READINGS_QUEUE ?? 'readings',
    lateThresholdMs: Number(process.env.LATE_THRESHOLD_MS ?? 30_000),
  }
}
