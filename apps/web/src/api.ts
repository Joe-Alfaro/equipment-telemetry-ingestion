import type { ClaimRequest, DeviceStatus, DeviceSummary, Reading } from '@telemetry/shared'

export class HttpError extends Error {
  readonly status: number

  constructor(status: number, url: string) {
    super(`${url} answered ${status}`)
    this.status = status
  }
}

async function getJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(url, { signal, headers: { Accept: 'application/json' } })
  if (!response.ok) {
    throw new HttpError(response.status, url)
  }
  return (await response.json()) as T
}

/** GET /api/devices, filtered by status when one is given. */
export function devicesUrl(status?: DeviceStatus) {
  return status ? `/api/devices?status=${status}` : '/api/devices'
}

export function readingsUrl(deviceId: string) {
  return `/api/devices/${encodeURIComponent(deviceId)}/readings`
}

export function fetchDevices(url: string, signal?: AbortSignal) {
  return getJson<DeviceSummary[]>(url, signal)
}

export function fetchReadings(url: string, signal?: AbortSignal) {
  return getJson<Reading[]>(url, signal)
}

export type ClaimResult =
  | { outcome: 'claimed'; device: DeviceSummary }
  | { outcome: 'already-claimed'; device: DeviceSummary }

/** POST /api/devices/:deviceId/claim. A 409 is a normal outcome (someone else claimed it first). */
export async function claimDevice(deviceId: string, name: string): Promise<ClaimResult> {
  const url = `/api/devices/${encodeURIComponent(deviceId)}/claim`
  const body: ClaimRequest = { name }
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
  })
  if (response.status === 409) {
    return { outcome: 'already-claimed', device: (await response.json()) as DeviceSummary }
  }
  if (!response.ok) {
    throw new HttpError(response.status, url)
  }
  return { outcome: 'claimed', device: (await response.json()) as DeviceSummary }
}
