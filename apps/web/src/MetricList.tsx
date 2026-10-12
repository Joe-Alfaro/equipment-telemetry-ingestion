import type { DeviceSummary, Reading } from '@telemetry/shared'
import { formatTimestamp } from './format'
import { MetricChart } from './MetricChart'
import { buildSeries, chartDomain, GAP_MS, isCharted, WINDOW_MS, type Series } from './series'

interface MetricListProps {
  metrics: DeviceSummary['metrics']
  /** When given, continuous metrics with readings in the window are drawn as charts. */
  charts?: { readings: Reading[]; now: number }
}

/** A device's current value per metric, each with the event time it was measured at. */
export function MetricList({ metrics, charts }: MetricListProps) {
  const entries = Object.entries(metrics).sort(([a], [b]) => a.localeCompare(b))

  if (entries.length === 0) {
    return <p className="muted">No metrics reported yet.</p>
  }
  const now = charts?.now ?? 0
  const seriesByMetric = new Map<string, Series>(
    entries
      .filter(([name]) => charts && isCharted(name))
      .map(([name]) => [
        name,
        buildSeries(charts?.readings ?? [], name, { now, windowMs: WINDOW_MS, gapMs: GAP_MS }),
      ]),
  )
  const domain = chartDomain([...seriesByMetric.values()], now)

  return (
    <dl className="metrics">
      {entries.map(([name, state]) => {
        const series = seriesByMetric.get(name)
        // A metric with nothing in the window keeps its plain current value.
        if (series?.latest) {
          return (
            <div key={name} className="metric metric-charted">
              <dt>{name}</dt>
              <dd>
                <MetricChart
                  metric={name}
                  series={series}
                  domain={domain}
                  now={now}
                  variant="card"
                />
              </dd>
            </div>
          )
        }
        return (
          <div key={name} className="metric">
            <dt>{name}</dt>
            <dd>
              <span className="metric-value">{state.value}</span>
              <span className="muted small">
                as of <time dateTime={state.eventTime}>{formatTimestamp(state.eventTime)}</time>
              </span>
            </dd>
          </div>
        )
      })}
    </dl>
  )
}
