import type { DeviceSummary, Reading } from '@telemetry/shared'
import { useEffect, useRef } from 'react'
import { devicesUrl, fetchDevices, fetchReadings, readingsUrl } from './api'
import { PossiblyBehindBadge } from './Board'
import { ClockBadges } from './ClockBadges'
import { formatTimestamp } from './format'
import { Link } from './Link'
import { MetricChart } from './MetricChart'
import { MetricList } from './MetricList'
import { buildSeries, chartDomain, GAP_MS, isCharted, WINDOW_MS } from './series'
import type { FetchResult } from './useFetch'
import { useFetch } from './useFetch'
import { useNow } from './useNow'

interface HistoryPageProps {
  deviceId: string
  /** Bumped on any device event: the device's summary (values, badges, status) is refetched. */
  listVersion: number
  /** Bumped on events for this device: its reading history is refetched. */
  detailVersion: number
}

const STATUS_TEXT: Record<DeviceSummary['status'], string> = {
  registered: 'Registered',
  unregistered: 'Unregistered',
}

/**
 * /devices/<deviceId>: one device's status, current values and reading history (UI rule 4).
 * There is no single-device GET, so the device is found in the full device list.
 */
export function HistoryPage({ deviceId, listVersion, detailVersion }: HistoryPageProps) {
  const devices = useFetch(devicesUrl(), listVersion, fetchDevices)
  // Fetched alongside the device list rather than after it; a 404 for an unknown ID is ignored.
  const readings = useFetch(readingsUrl(deviceId), detailVersion, fetchReadings)
  const device = devices.data?.find((candidate) => candidate.deviceId === deviceId)

  if (devices.loading) {
    return <p className="muted">Loading…</p>
  }
  if (!devices.data) {
    return (
      <section className="panel">
        <p role="alert" className="error">
          Could not load this device.
        </p>
        <BackLink />
      </section>
    )
  }
  if (!device) {
    return (
      <section className="panel">
        <h2>Device not found</h2>
        <p className="muted">No device has reported as “{deviceId}”.</p>
        <BackLink />
      </section>
    )
  }
  return <DeviceHistory device={device} readings={readings} />
}

function BackLink() {
  return (
    <Link href="/" className="back-link">
      Back to equipment
    </Link>
  )
}

interface DeviceHistoryProps {
  device: DeviceSummary
  readings: FetchResult<Reading[]>
}

function DeviceHistory({ device, readings }: DeviceHistoryProps) {
  const nameRef = useRef<HTMLHeadingElement>(null)

  // Land keyboard and screen-reader users on the device when its page opens.
  useEffect(() => {
    nameRef.current?.focus()
  }, [device.deviceId])

  return (
    <div className="history">
      <BackLink />
      <section className="panel">
        <header className="history-header">
          <h2 ref={nameRef} tabIndex={-1}>
            {device.name ?? device.deviceId}
          </h2>
          <span className={`badge badge-status badge-${device.status}`}>
            {STATUS_TEXT[device.status]}
          </span>
          {device.possiblyBehind && <PossiblyBehindBadge />}
        </header>
        <ClockBadges warnings={device.clockWarnings} />
        {device.name && <p className="muted small">{device.deviceId}</p>}
        <p className="muted small">
          First seen{' '}
          <time dateTime={device.firstSeenAt}>{formatTimestamp(device.firstSeenAt)}</time> via{' '}
          {device.firstSeenGatewayId}
        </p>
        <MetricList metrics={device.metrics} />
      </section>
      <section className="panel">
        {readings.data && <MetricCharts device={device} readings={readings.data} />}
        <ReadingHistory readings={readings} />
      </section>
    </div>
  )
}

interface MetricChartsProps {
  device: DeviceSummary
  readings: Reading[]
}

/**
 * Rule 12: one large chart per continuous metric over the last 10 minutes, stacked as small
 * multiples on one shared x domain, with a key for the hollow-ring flag marker.
 */
function MetricCharts({ device, readings }: MetricChartsProps) {
  const now = useNow()
  const metrics = [...new Set([...Object.keys(device.metrics), ...readings.map((r) => r.metric)])]
    .filter(isCharted)
    .sort((a, b) => a.localeCompare(b))
  const charted = metrics
    .map((metric) => ({
      metric,
      series: buildSeries(readings, metric, { now, windowMs: WINDOW_MS, gapMs: GAP_MS }),
    }))
    .filter(({ series }) => series.latest !== null)
  const domain = chartDomain(
    charted.map(({ series }) => series),
    now,
  )

  if (charted.length === 0) {
    return <p className="muted small">No readings in the last 10 minutes.</p>
  }
  return (
    <div className="history-charts">
      {charted.map(({ metric, series }) => (
        <figure key={metric} className="history-chart">
          <figcaption>{metric}</figcaption>
          <MetricChart metric={metric} series={series} domain={domain} now={now} variant="page" />
        </figure>
      ))}
      <p className="muted small chart-key">
        <svg
          className="chart-key-ring"
          width="12"
          height="12"
          viewBox="0 0 12 12"
          aria-hidden="true"
        >
          <circle cx="6" cy="6" r="4" />
        </svg>
        Hollow ring: a late, out of order or future reading (see the table for details).
      </p>
    </div>
  )
}

function readingKey(reading: Reading) {
  return `${reading.gatewayId}|${reading.metric}|${reading.sequence}|${reading.eventTime}`
}

/** Reading history in event-time order, with the late, out-of-order and future flags. */
function ReadingHistory({ readings }: { readings: FetchResult<Reading[]> }) {
  const { data, failed, loading } = readings

  return (
    <>
      {loading && <p className="muted">Loading…</p>}
      {failed && (
        <p role="alert" className="error">
          Could not load the reading history.
        </p>
      )}
      {data?.length === 0 && <p className="muted">No readings yet.</p>}
      {data && data.length > 0 && (
        <div className="table-scroll">
          <table>
            <caption>Reading history</caption>
            <thead>
              <tr>
                <th scope="col">Event time</th>
                <th scope="col">Metric</th>
                <th scope="col" className="numeric">
                  Value
                </th>
                <th scope="col">Gateway</th>
                <th scope="col" className="numeric">
                  Sequence
                </th>
                <th scope="col">Flags</th>
              </tr>
            </thead>
            <tbody>
              {data.map((reading) => (
                <tr key={readingKey(reading)}>
                  <td>
                    <time dateTime={reading.eventTime}>{formatTimestamp(reading.eventTime)}</time>
                  </td>
                  <td>{reading.metric}</td>
                  <td className="numeric">{reading.value}</td>
                  <td>{reading.gatewayId}</td>
                  <td className="numeric">{reading.sequence}</td>
                  <td>
                    {reading.late && <span className="badge badge-warning">Late</span>}
                    {reading.outOfOrder && <span className="badge badge-info">Out of order</span>}
                    {reading.future && (
                      <span
                        className="badge badge-warning"
                        title="The event time was ahead of the server clock when this reading was processed."
                      >
                        Future timestamp
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  )
}
