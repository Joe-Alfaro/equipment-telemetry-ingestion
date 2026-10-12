import type { DeviceSummary } from '@telemetry/shared'
import { useId } from 'react'
import { devicesUrl, fetchDevices, fetchReadingWindow, readingsUrl } from './api'
import { ClockBadges } from './ClockBadges'
import { MetricList } from './MetricList'
import { useFetch } from './useFetch'
import { useNow } from './useNow'

interface BoardProps {
  version: number
  /** Bumped per device when an event concerns it: that card refetches its chart window. */
  readingsVersion(deviceId: string): number
  onViewHistory(device: DeviceSummary): void
}

/** Live equipment board: registered devices and their current value per metric. */
export function Board({ version, readingsVersion, onViewHistory }: BoardProps) {
  const headingId = useId()
  // One clock for every card, so the charts slide together.
  const now = useNow()
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
      {data?.length === 0 && <p className="muted">No equipment yet. Claim one from New devices.</p>}
      {data && data.length > 0 && (
        <ul className="cards">
          {data.map((device) => (
            <li key={device.deviceId}>
              <DeviceCard
                device={device}
                now={now}
                readingsVersion={readingsVersion(device.deviceId)}
                onViewHistory={onViewHistory}
              />
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
  now: number
  readingsVersion: number
  onViewHistory(device: DeviceSummary): void
}

function DeviceCard({ device, now, readingsVersion, onViewHistory }: DeviceCardProps) {
  const headingId = useId()
  // Each card fetches only its own last 10 minutes (metric charts, rule 2).
  const readings = useFetch(readingsUrl(device.deviceId), readingsVersion, fetchReadingWindow)

  return (
    <article aria-labelledby={headingId} className="card">
      <header className="card-header">
        <h3 id={headingId}>{device.name ?? device.deviceId}</h3>
        {device.possiblyBehind && <PossiblyBehindBadge />}
      </header>
      <ClockBadges warnings={device.clockWarnings} />
      <p className="muted small">{device.deviceId}</p>
      <MetricList metrics={device.metrics} charts={{ readings: readings.data ?? [], now }} />
      <button type="button" aria-describedby={headingId} onClick={() => onViewHistory(device)}>
        View history
      </button>
    </article>
  )
}
