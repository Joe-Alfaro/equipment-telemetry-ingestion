import type { DeviceSummary } from '@telemetry/shared'
import type { FormEvent } from 'react'
import { useId, useRef, useState } from 'react'
import { claimDevice, devicesUrl, fetchDevices } from './api'
import { PossiblyBehindBadge } from './Board'
import { ClockBadges } from './ClockBadges'
import { formatTimestamp } from './format'
import { useFetch } from './useFetch'

interface InboxProps {
  version: number
  /** A claim settled (either way), so both lists need a refresh. */
  onClaimSettled(): void
  onViewHistory(device: DeviceSummary): void
}

/** Unregistered devices that have started reporting, each with a Claim form. */
export function Inbox({ version, onClaimSettled, onViewHistory }: InboxProps) {
  const headingId = useId()
  const { data, failed, loading } = useFetch(devicesUrl('unregistered'), version, fetchDevices)
  const [notice, setNotice] = useState<string | null>(null)

  function handleClaimed() {
    setNotice(null)
    onClaimSettled()
  }

  function handleAlreadyClaimed(device: DeviceSummary) {
    const by = device.name ? ` as “${device.name}”` : ''
    setNotice(`${device.deviceId} was already claimed${by}. It is now on the board.`)
    onClaimSettled()
  }

  return (
    <section aria-labelledby={headingId} className="panel">
      <h2 id={headingId}>New devices</h2>
      {notice && (
        <p role="alert" className="notice">
          {notice}
        </p>
      )}
      {loading && <p className="muted">Loading…</p>}
      {failed && (
        <p role="alert" className="error">
          Could not load new devices.
        </p>
      )}
      {data?.length === 0 && <p className="muted">No new devices.</p>}
      {data && data.length > 0 && (
        <ul className="cards">
          {data.map((device) => (
            <li key={device.deviceId}>
              <ClaimCard
                device={device}
                onClaimed={handleClaimed}
                onAlreadyClaimed={handleAlreadyClaimed}
                onViewHistory={onViewHistory}
              />
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

interface ClaimCardProps {
  device: DeviceSummary
  onClaimed(device: DeviceSummary): void
  onAlreadyClaimed(device: DeviceSummary): void
  onViewHistory(device: DeviceSummary): void
}

function ClaimCard({ device, onClaimed, onAlreadyClaimed, onViewHistory }: ClaimCardProps) {
  const headingId = useId()
  const inputId = useId()
  const [name, setName] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // State updates are async, so a double-click can submit twice before `pending` re-renders.
  const inFlight = useRef(false)

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (inFlight.current) {
      return
    }
    const trimmed = name.trim()
    if (!trimmed) {
      setError('Enter a name to claim this device.')
      return
    }

    inFlight.current = true
    setPending(true)
    setError(null)
    try {
      const result = await claimDevice(device.deviceId, trimmed)
      if (result.outcome === 'already-claimed') {
        onAlreadyClaimed(result.device)
        return
      }
      onClaimed(result.device)
    } catch {
      setError('Could not claim this device. Try again.')
    } finally {
      inFlight.current = false
      setPending(false)
    }
  }

  return (
    <article aria-labelledby={headingId} className="card">
      <header className="card-header">
        <h3 id={headingId}>{device.deviceId}</h3>
        {device.possiblyBehind && <PossiblyBehindBadge />}
      </header>
      <ClockBadges warnings={device.clockWarnings} />
      <p className="muted small">
        First seen <time dateTime={device.firstSeenAt}>{formatTimestamp(device.firstSeenAt)}</time>{' '}
        via {device.firstSeenGatewayId}
      </p>
      <form className="claim-form" onSubmit={handleSubmit} aria-busy={pending}>
        <label htmlFor={inputId}>Device name</label>
        <div className="claim-row">
          <input
            id={inputId}
            type="text"
            value={name}
            autoComplete="off"
            aria-invalid={error !== null}
            onChange={(event) => setName(event.target.value)}
          />
          <button type="submit" disabled={pending}>
            Claim
          </button>
        </div>
      </form>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      <button type="button" aria-describedby={headingId} onClick={() => onViewHistory(device)}>
        View history
      </button>
    </article>
  )
}
