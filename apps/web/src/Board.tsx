import type { DeviceSummary } from '@telemetry/shared'
import { useId } from 'react'
import { devicesUrl, fetchDevices } from './api'
import { ClockBadges } from './ClockBadges'
import { formatTimestamp } from './format'
import { useFetch } from './useFetch'

interface BoardProps {
  version: number
  onViewHistory(device: DeviceSummary): void
}

/** Live equipment board: registered devices and their current value per metric. */
export function Board({ version, onViewHistory }: BoardProps) {
  const headingId = useId()
  const { data, failed, loading } = useFetch(devicesUrl('registered'), version, fetchDevices)

  return (
    <section aria-labelledby={headingId} className="panel">
      <h2 id={headingId}>Equipment</h2>
      {loading && <p className="muted">Loading…</p>}
      {failed && (
        <p role="alert" className="error">
          Could not load equipment.
        </p>
      )}
      {data?.length === 0 && <p className="muted">No equipment yet. Claim a new device below.</p>}
      {data && data.length > 0 && (
        <ul className="cards">
          {data.map((device) => (
            <li key={device.deviceId}>
              <DeviceCard device={device} onViewHistory={onViewHistory} />
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

export function PossiblyBehindBadge() {
  return (
    <span
      className="badge badge-warning"
      title="A gateway reporting this device has gone quiet, so newer readings may still arrive."
    >
      Possibly behind
    </span>
  )
}

interface DeviceCardProps {
  device: DeviceSummary
  onViewHistory(device: DeviceSummary): void
}

function DeviceCard({ device, onViewHistory }: DeviceCardProps) {
  const headingId = useId()
  const metrics = Object.entries(device.metrics).sort(([a], [b]) => a.localeCompare(b))

  return (
    <article aria-labelledby={headingId} className="card">
      <header className="card-header">
        <h3 id={headingId}>{device.name ?? device.deviceId}</h3>
        {device.possiblyBehind && <PossiblyBehindBadge />}
      </header>
      <ClockBadges warnings={device.clockWarnings} />
      <p className="muted small">{device.deviceId}</p>
      {metrics.length === 0 && <p className="muted">No metrics reported yet.</p>}
      {metrics.length > 0 && (
        <dl className="metrics">
          {metrics.map(([name, state]) => (
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
      )}
      <button type="button" aria-describedby={headingId} onClick={() => onViewHistory(device)}>
        View history
      </button>
    </article>
  )
}
