import type { ClockWarning } from '@telemetry/shared'
import { useId } from 'react'
import { formatClockWarning } from './format'

interface ClockBadgesProps {
  warnings: ClockWarning[]
}

/** One badge per gateway whose clock looks wrong (rule 6). Detection only: nothing is corrected. */
export function ClockBadges({ warnings }: ClockBadgesProps) {
  if (warnings.length === 0) {
    return null
  }
  return (
    <p className="clock-badges">
      {warnings.map((warning) => (
        <ClockBadge key={warning.gatewayId} warning={warning} />
      ))}
    </p>
  )
}

function ClockBadge({ warning }: { warning: ClockWarning }) {
  const descriptionId = useId()
  const description =
    warning.status === 'ahead'
      ? `Gateway ${warning.gatewayId} sends timestamps ahead of the time we receive them.`
      : `Gateway ${warning.gatewayId} seems to send local time without a UTC offset.`

  return (
    <>
      <span
        className="badge badge-warning"
        aria-describedby={descriptionId}
        title={`${description} Stored timestamps are not corrected.`}
      >
        {formatClockWarning(warning)}
      </span>
      <span id={descriptionId} hidden>
        {description}
      </span>
    </>
  )
}
