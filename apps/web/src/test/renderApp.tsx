import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { App } from '../App'

/**
 * Accessible structure the dashboard tests rely on:
 *
 * - Region "Equipment" (a section labelled by its h2). Each registered device is an article named
 *   by the device name, showing each metric name, its value, an "as of" event time and, when the
 *   device is possibly behind, the text "Possibly behind". Each article has a "View history"
 *   button.
 * - Region "New devices". Each unregistered device is an article named by its device ID, showing
 *   "First seen" and the gateway that first reported it, "Possibly behind" when it applies, a
 *   "Device name" textbox, a "Claim" button and a "View history" button.
 * - Region "Device detail", shown after "View history" (from the board or the inbox): a heading
 *   with the device name (the device ID when unnamed) and a table named "Reading history" with
 *   one row per reading, in event-time order. Flagged rows say "Late", "Out of order" and/or
 *   "Future timestamp".
 * - Loading shows "Loading…", empty lists say "No equipment yet", "No new devices" and
 *   "No readings yet", and failures render a role="alert" message.
 */
export function renderApp() {
  const user = userEvent.setup()
  const view = render(<App />)
  return { user, ...view }
}

/** Regions may render after the first fetch starts, so they are always found asynchronously. */
export function findRegion(name: 'Equipment' | 'New devices' | 'Device detail') {
  return screen.findByRole('region', { name })
}
