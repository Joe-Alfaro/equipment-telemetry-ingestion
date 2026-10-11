import type { Reading } from '@telemetry/shared'
import { useEffect, useId, useRef } from 'react'
import { fetchReadings, readingsUrl } from './api'
import { formatTimestamp } from './format'
import { useFetch } from './useFetch'

export interface SelectedDevice {
  deviceId: string
  name: string
}

interface DeviceDetailProps {
  device: SelectedDevice
  version: number
  onClose(): void
}

function readingKey(reading: Reading) {
  return `${reading.gatewayId}|${reading.metric}|${reading.sequence}|${reading.eventTime}`
}

/** Reading history for one device, with the late, out-of-order and future flags. */
export function DeviceDetail({ device, version, onClose }: DeviceDetailProps) {
  const headingId = useId()
  const nameRef = useRef<HTMLHeadingElement>(null)
  const { data, failed, loading } = useFetch(readingsUrl(device.deviceId), version, fetchReadings)

  // Move focus here when a device is opened so keyboard and screen-reader users land on it.
  useEffect(() => {
    nameRef.current?.focus()
  }, [device.deviceId])

  return (
    <section aria-labelledby={headingId} className="panel detail">
      <div className="panel-header">
        <h2 id={headingId}>Device detail</h2>
        <button type="button" onClick={onClose}>
          Close history
        </button>
      </div>
      <h3 ref={nameRef} tabIndex={-1}>
        {device.name}
      </h3>
      <p className="muted small">{device.deviceId}</p>
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
    </section>
  )
}
