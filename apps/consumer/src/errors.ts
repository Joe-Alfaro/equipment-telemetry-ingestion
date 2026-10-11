/**
 * How the consumer treats a processing error (rule 3):
 *   - 'data': the reading can never be stored (SQLSTATE class 22, 54, or 23 other than the unique
 *     conflict processReading already handles). Dead-lettered at once.
 *   - 'transient': the database is unreachable or restarting. Retried after a delay, uncapped,
 *     so an outage loses nothing.
 *   - 'other': anything else. Retried a bounded number of times, then dead-lettered.
 */
export type ErrorClass = 'data' | 'transient' | 'other'

const DATA_SQLSTATE_CLASSES = ['22', '23', '54']

const TRANSIENT_SQLSTATES = ['57P01', '57P02', '57P03']

// Socket-level failures reported by node-postgres before or during a query.
const TRANSIENT_NODE_CODES = [
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EPIPE',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
]

// node-postgres reports a dropped connection without a code.
const TRANSIENT_MESSAGES = [
  /connection terminated/i,
  /connection timeout/i,
  /client has encountered a connection error/i,
]

function errorCode(error: unknown): string | null {
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return null
  }
  return typeof error.code === 'string' ? error.code : null
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Node reports a refused multi-address connect as an AggregateError whose parts carry the code. */
function causes(error: unknown): unknown[] {
  if (error instanceof AggregateError) {
    return [error, ...error.errors]
  }
  return [error]
}

export function classifyError(error: unknown): ErrorClass {
  const codes = causes(error)
    .map(errorCode)
    .filter((code): code is string => code !== null)

  if (codes.some((code) => code.length === 5 && DATA_SQLSTATE_CLASSES.includes(code.slice(0, 2)))) {
    return 'data'
  }
  if (
    codes.some(
      (code) =>
        code.startsWith('08') ||
        TRANSIENT_SQLSTATES.includes(code) ||
        TRANSIENT_NODE_CODES.includes(code),
    ) ||
    TRANSIENT_MESSAGES.some((pattern) => pattern.test(errorMessage(error)))
  ) {
    return 'transient'
  }
  return 'other'
}
