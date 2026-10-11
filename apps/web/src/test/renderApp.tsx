import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { App } from '../App'

/**
 * Accessible structure the dashboard tests rely on:
 *
 * - Page header: a "New devices" button, on every page. While unregistered
 *   devices exist it shows a count badge (for example "3") and its accessible name is
 *   "New devices, 3 waiting"; with none there is no badge and the name is just "New devices".
 * - Board page ("/"): region "Equipment" (a section labelled by its h2). Each registered device is
 *   an article named by the device name, showing each metric name, its value, an "as of" event
 *   time and, when the device is possibly behind, the text "Possibly behind". Each article has a
 *   "View history" button. There is no inline "New devices" or "Device detail" region.
 * - Drawer: the "New devices" button opens a dialog (aria-modal="true") named "New devices", with
 *   an h2 "New devices". Each unregistered device is an article named by its device ID, showing
 *   "First seen" and the gateway that first reported it, "Possibly behind" and clock badges when
 *   they apply, a "Device name" textbox, a "Claim" button and a "View history" button. It closes
 *   with its "Close" button, Escape, or a click outside the drawer (the backdrop; tests click
 *   document.body), and focus returns to the header button.
 * - History page ("/devices/<encodeURIComponent(deviceId)>"), inside the "main" landmark: an h2
 *   with the device name (the device ID when unnamed), the status ("Registered" or
 *   "Unregistered"), current values per metric, "Possibly behind" and clock badges, a table named
 *   "Reading history" with one row per reading in event-time order (flagged rows say "Late",
 *   "Out of order" and/or "Future timestamp"), and a "Back to equipment" link to "/". An unknown
 *   device shows "Device not found" with a link back to "/".
 * - Loading shows "Loading…", empty lists say "No equipment yet", "No new devices" and
 *   "No readings yet", and failures render a role="alert" message.
 *
 * Routing contract: tests set the starting URL with window.history.pushState before rendering
 * <App/> (the `path` option) and assert window.location.pathname after navigating. setup.ts
 * resets the URL to "/" after each test.
 */
export function renderApp({ path }: { path?: string } = {}) {
  if (path !== undefined) {
    window.history.pushState(null, '', path)
  }
  const user = userEvent.setup()
  const view = render(<App />)
  return { user, ...view }
}

export type User = ReturnType<typeof renderApp>['user']

/** Regions may render after the first fetch starts, so they are always found asynchronously. */
export function findRegion(name: 'Equipment') {
  return screen.findByRole('region', { name })
}

/**
 * The header's "New devices" button, whatever its count. Card headers are <header> elements too,
 * so the page header can't be singled out as the only "banner"; the button is found page-wide.
 */
export function findNewDevicesButton() {
  return screen.findByRole('button', { name: /^New devices/ })
}

/** Opens the "New devices" drawer from the header and returns the dialog. */
export async function openNewDevices(user: User) {
  await user.click(await findNewDevicesButton())
  return screen.findByRole('dialog', { name: 'New devices' })
}

/** Waits for a device's history page (its h2) and returns the main landmark that holds it. */
export async function findHistoryPage(deviceName: string) {
  await screen.findByRole('heading', { level: 2, name: deviceName })
  return screen.getByRole('main')
}
