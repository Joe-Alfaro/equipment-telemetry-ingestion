import type { DeviceSummary, StreamEvent } from '@telemetry/shared'
import { useState } from 'react'
import { Board } from './Board'
import type { SelectedDevice } from './DeviceDetail'
import { DeviceDetail } from './DeviceDetail'
import { Inbox } from './Inbox'
import type { StreamStatus } from './useEventStream'
import { useEventStream } from './useEventStream'

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
  // refreshes both lists (they're small), and the open detail only when the event concerns it.
  const [listVersion, setListVersion] = useState(0)
  const [detailVersion, setDetailVersion] = useState(0)
  const [selected, setSelected] = useState<SelectedDevice | null>(null)

  function refreshLists() {
    setListVersion((version) => version + 1)
  }

  const streamStatus = useEventStream({
    onEvents(events) {
      refreshLists()
      if (selected && events.some((event) => concernsDevice(event, selected.deviceId))) {
        setDetailVersion((version) => version + 1)
      }
    },
    onReconnect() {
      refreshLists()
      setDetailVersion((version) => version + 1)
    },
  })

  function viewHistory(device: DeviceSummary) {
    setSelected({ deviceId: device.deviceId, name: device.name ?? device.deviceId })
  }

  return (
    <div className="app">
      <header className="app-header">
        <h1>Equipment telemetry</h1>
        <p className={`stream-status stream-${streamStatus}`}>{STATUS_TEXT[streamStatus]}</p>
      </header>
      <main className="layout">
        <Board version={listVersion} onViewHistory={viewHistory} />
        <Inbox version={listVersion} onClaimSettled={refreshLists} />
        {selected && (
          <DeviceDetail
            key={selected.deviceId}
            device={selected}
            version={detailVersion}
            onClose={() => setSelected(null)}
          />
        )}
      </main>
    </div>
  )
}
