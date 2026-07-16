/**
 * DOM entry point: mounts `CallsRoot` once into a container appended to
 * `document.body`, always mounted in the main window so the incoming-ring
 * dialog can never be popup-blocked (docs/calls.md §Windowing). The only
 * file in this package that touches `document`/`react-dom/client` directly.
 */
import { createRoot, type Root } from 'react-dom/client'
import { CallsRoot } from './CallsRoot.tsx'
import type { CallsUiCallbacks, CallsUiStore } from './calls-store.ts'

const MOUNT_ELEMENT_ID = 'slothfulchat-calls-root'

let mountedRoot: Root | null = null

/**
 * Mount (or re-render, if already mounted — safe to call more than once,
 * e.g. under HMR) the call UI. `store` drives what renders; `callbacks` wires
 * user actions (accept/hangup/mute) back to whatever owns the active call.
 */
export function mountCallsUi(store: CallsUiStore, callbacks: CallsUiCallbacks): void {
  let container = document.getElementById(MOUNT_ELEMENT_ID)
  if (container == null) {
    container = document.createElement('div')
    container.id = MOUNT_ELEMENT_ID
    document.body.appendChild(container)
  }
  if (mountedRoot == null) {
    mountedRoot = createRoot(container)
  }
  mountedRoot.render(<CallsRoot store={store} callbacks={callbacks} />)
}
