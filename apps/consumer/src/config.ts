export interface ConsumerConfig {
  databaseUrl: string
  amqpUrl: string
  readingsQueue: string
  prefetch: number
  lateThresholdMs: number
  /** readings.future = event_time - processed_at > futureSkewMs (rule 4). */
  futureSkewMs: number
}

function required(name: string): string {
  const value = process.env[name]
  if (!value) {
    throw new Error(`${name} is required`)
  }
  return value
}

export function loadConfig(): ConsumerConfig {
  return {
    databaseUrl: required('DATABASE_URL'),
    amqpUrl: required('AMQP_URL'),
    readingsQueue: process.env.READINGS_QUEUE ?? 'readings',
    prefetch: Number(process.env.CONSUMER_PREFETCH ?? 20),
    lateThresholdMs: Number(process.env.LATE_THRESHOLD_MS ?? 30_000),
    futureSkewMs: Number(process.env.FUTURE_SKEW_MS ?? 60_000),
  }
}
