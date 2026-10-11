import type { DeviceSummary } from '@telemetry/shared'
import { formatTimestamp } from './format'

interface MetricListProps {
  metrics: DeviceSummary['metrics']
}

/** A device's current value per metric, each with the event time it was measured at. */
export function MetricList({ metrics }: MetricListProps) {
  const entries = Object.entries(metrics).sort(([a], [b]) => a.localeCompare(b))

  if (entries.length === 0) {
    return <p className="muted">No metrics reported yet.</p>
  }
  return (
    <dl className="metrics">
      {entries.map(([name, state]) => (
        <div key={name} className="metric">
          <dt>{name}</dt>
          <dd>
            <span className="metric-value">{state.value}</span>
            <span className="muted small">
              as of <time dateTime={state.eventTime}>{formatTimestamp(state.eventTime)}</time>
            </span>
          </dd>
        </div>
      ))}
    </dl>
  )
}
