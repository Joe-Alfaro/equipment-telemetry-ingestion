import type { DeviceSummary, StreamEvent } from '@telemetry/shared'
import { useRef, useState } from 'react'
import { devicesUrl, fetchDevices } from './api'
import { Board } from './Board'
import { HistoryPage } from './HistoryPage'
import { Inbox } from './Inbox'
import { NewDevicesButton, NewDevicesDrawer } from './NewDevicesDrawer'
import { devicePath, matchDevicePath, navigate, usePathname } from './router'
import type { StreamStatus } from './useEventStream'
import { useEventStream } from './useEventStream'
import { useFetch } from './useFetch'

const STATUS_TEXT: Record<StreamStatus, string> = {
  connecting: 'Connecting…',
  live: 'Live',
  reconnecting: 'Reconnecting…',
}

function concernsDevice(event: StreamEvent, deviceId: string) {
  return 'deviceId' in event.data && event.data.deviceId === deviceId
}

export function App() {
  // Bumping a version refetches that data. There is no single-device GET, so any device event
  // refreshes the lists (they're small), and the open history only when the event concerns it.
  const [listVersion, setListVersion] = useState(0)
  const [detailVersion, setDetailVersion] = useState(0)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const newDevicesButtonRef = useRef<HTMLButtonElement>(null)
  const deviceId = matchDevicePath(usePathname())
  // Fetched here rather than in the drawer: the header badge needs the count on every page.
  const unregistered = useFetch(devicesUrl('unregistered'), listVersion, fetchDevices)

  function refreshLists() {
    setListVersion((version) => version + 1)
  }

  const streamStatus = useEventStream({
    onEvents(events) {
      refreshLists()
      if (deviceId !== null && events.some((event) => concernsDevice(event, deviceId))) {
        setDetailVersion((version) => version + 1)
      }
    },
    onReconnect() {
      refreshLists()
      setDetailVersion((version) => version + 1)
    },
  })

  function closeDrawer() {
    setDrawerOpen(false)
    newDevicesButtonRef.current?.focus()
  }

  function viewHistory(device: DeviceSummary) {
    // Focus moves to the history page's heading, not back to the header button.
    setDrawerOpen(false)
    navigate(devicePath(device.deviceId))
  }

  return (
    <div className="app">
      <header className="app-header">
        <h1>Equipment telemetry</h1>
        <div className="app-header-actions">
          <p className={`stream-status stream-${streamStatus}`}>{STATUS_TEXT[streamStatus]}</p>
          <NewDevicesButton
            ref={newDevicesButtonRef}
            count={unregistered.data?.length}
            expanded={drawerOpen}
            onClick={() => setDrawerOpen(true)}
          />
        </div>
      </header>
      <main>
        {deviceId === null && <Board version={listVersion} onViewHistory={viewHistory} />}
        {deviceId !== null && (
          <HistoryPage
            key={deviceId}
            deviceId={deviceId}
            listVersion={listVersion}
            detailVersion={detailVersion}
          />
        )}
      </main>
      {drawerOpen && (
        <NewDevicesDrawer onClose={closeDrawer}>
          <Inbox devices={unregistered} onClaimSettled={refreshLists} onViewHistory={viewHistory} />
        </NewDevicesDrawer>
      )}
    </div>
  )
}
