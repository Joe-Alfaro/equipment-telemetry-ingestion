import { useSyncExternalStore } from 'react'

/**
 * A two-route app doesn't need a router library: the URL is read from window.location and kept in
 * sync through the History API. pushState fires no event, so navigate() announces its own changes.
 */
const NAVIGATE_EVENT = 'app:navigate'

function subscribe(onChange: () => void) {
  window.addEventListener('popstate', onChange)
  window.addEventListener(NAVIGATE_EVENT, onChange)
  return () => {
    window.removeEventListener('popstate', onChange)
    window.removeEventListener(NAVIGATE_EVENT, onChange)
  }
}

function getPathname() {
  return window.location.pathname
}

/** The current URL path, re-rendering on navigate() and on browser back/forward. */
export function usePathname() {
  return useSyncExternalStore(subscribe, getPathname)
}

export function navigate(path: string) {
  if (path === window.location.pathname) {
    return
  }
  window.history.pushState(null, '', path)
  window.dispatchEvent(new Event(NAVIGATE_EVENT))
}

export function devicePath(deviceId: string) {
  return `/devices/${encodeURIComponent(deviceId)}`
}

const DEVICE_PATH = /^\/devices\/([^/]+)\/?$/

/** The device ID in a /devices/<encoded deviceId> path, or null for any other path. */
export function matchDevicePath(pathname: string) {
  const match = DEVICE_PATH.exec(pathname)
  if (!match?.[1]) {
    return null
  }
  try {
    return decodeURIComponent(match[1])
  } catch {
    // A malformed escape can't name a real device; the page then says "Device not found".
    return match[1]
  }
}
