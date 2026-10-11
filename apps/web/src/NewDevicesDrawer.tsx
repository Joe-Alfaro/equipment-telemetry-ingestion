import type { ReactNode, Ref } from 'react'
import { useEffect, useId, useRef } from 'react'

interface NewDevicesButtonProps {
  ref: Ref<HTMLButtonElement>
  /** Unregistered devices waiting to be claimed; undefined until the first fetch answers. */
  count?: number
  expanded: boolean
  onClick(): void
}

/** Header button that opens the drawer, with a badge counting the devices waiting (UI rule 1). */
export function NewDevicesButton({ ref, count, expanded, onClick }: NewDevicesButtonProps) {
  const waiting = count ?? 0

  return (
    <button
      ref={ref}
      type="button"
      className="new-devices-button"
      aria-haspopup="dialog"
      aria-expanded={expanded}
      aria-label={waiting > 0 ? `New devices, ${waiting} waiting` : 'New devices'}
      onClick={onClick}
    >
      New devices
      {waiting > 0 && <span className="count-badge">{waiting}</span>}
    </button>
  )
}

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), [tabindex="0"]'

interface NewDevicesDrawerProps {
  onClose(): void
  children: ReactNode
}

/**
 * Modal drawer that slides in from the right over a backdrop (UI rule 2). It closes on its Close
 * button, Escape, or any click outside it; the caller decides where focus goes next.
 */
export function NewDevicesDrawer({ onClose, children }: NewDevicesDrawerProps) {
  const headingId = useId()
  const dialogRef = useRef<HTMLDivElement>(null)
  const onCloseRef = useRef(onClose)

  useEffect(() => {
    onCloseRef.current = onClose
  })

  useEffect(() => {
    dialogRef.current?.focus()
    const { overflow } = document.body.style
    document.body.style.overflow = 'hidden'

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        onCloseRef.current()
        return
      }
      if (event.key === 'Tab') {
        trapFocus(event)
      }
    }

    // Closing on `click` rather than `mousedown`: the mousedown blur would otherwise land after
    // the caller has moved focus back. composedPath() is fixed at dispatch, so a click on an
    // element that re-renders away mid-event still counts as inside.
    function handleClick(event: MouseEvent) {
      const dialog = dialogRef.current
      if (dialog && !event.composedPath().includes(dialog)) {
        onCloseRef.current()
      }
    }

    function trapFocus(event: KeyboardEvent) {
      const dialog = dialogRef.current
      if (!dialog) {
        return
      }
      const focusable = Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE))
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (!first || !last) {
        event.preventDefault()
        return
      }
      const active = document.activeElement
      if (event.shiftKey && (active === first || active === dialog)) {
        event.preventDefault()
        last.focus()
        return
      }
      if (!event.shiftKey && active === last) {
        event.preventDefault()
        first.focus()
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    // The click that opened the drawer is still bubbling to the document when this effect runs;
    // listening from the next task keeps it from closing the drawer straight away.
    const timer = setTimeout(() => document.addEventListener('click', handleClick))
    return () => {
      clearTimeout(timer)
      document.removeEventListener('keydown', handleKeyDown)
      document.removeEventListener('click', handleClick)
      document.body.style.overflow = overflow
    }
  }, [])

  return (
    <div className="drawer-layer">
      <div className="drawer-backdrop" aria-hidden="true" />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={headingId}
        tabIndex={-1}
        className="drawer"
      >
        <div className="drawer-header">
          <h2 id={headingId}>New devices</h2>
          <button type="button" onClick={onClose}>
            Close
          </button>
        </div>
        <div className="drawer-body">{children}</div>
      </div>
    </div>
  )
}
