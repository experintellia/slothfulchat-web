/**
 * window-port.ts — the production {@link SignalingPort}: `window.postMessage`
 * between two same-origin windows (the opener and the detached call popup, M4).
 * The only DOM-touching file of the popup-signaling seam; everything in
 * `popup-signaling.ts` stays testable against an in-memory pair.
 *
 * SECURITY: every inbound `message` event is untrusted — any page can
 * `postMessage` into any window it has a handle to. Two guards:
 *   1. `event.origin` must equal our own origin (same-origin popup only), and
 *   2. `event.source` must be the exact peer window we expect (the popup we
 *      opened, or `window.opener`).
 * On top of that, {@link parsePopupMessage} validates the protocol tag/shape.
 * Outbound posts pin `targetOrigin` to our origin so a message is never
 * delivered to a window that navigated away to a foreign origin.
 */

import { parsePopupMessage, type PopupMessage, type SignalingPort } from './popup-signaling.ts'

/**
 * Build a {@link SignalingPort} that talks to `peer` (the other window) over
 * `postMessage`. `origin` defaults to this window's own origin — the popup is
 * always same-origin (`window.open` of a path on our own site).
 */
export function windowSignalingPort(
  peer: Window,
  options: { origin?: string; self?: Window } = {}
): SignalingPort {
  const selfWindow = options.self ?? window
  const origin = options.origin ?? selfWindow.location.origin
  const handlers = new Set<(message: PopupMessage) => void>()

  const listener = (event: MessageEvent): void => {
    // Same-origin only, and only from the exact peer window we handshake with.
    if (event.origin !== origin) return
    if (event.source !== peer) return
    const message = parsePopupMessage(event.data)
    if (message == null) return
    for (const handler of [...handlers]) handler(message)
  }
  selfWindow.addEventListener('message', listener)

  return {
    post(message: PopupMessage): void {
      // `peer` may already be closed (popup dismissed) — postMessage to a
      // closed window throws in some engines; swallow it, the lifecycle
      // watchers handle the teardown.
      try {
        peer.postMessage(message, origin)
      } catch {
        /* peer gone — best-effort */
      }
    },
    onMessage(handler: (message: PopupMessage) => void): () => void {
      handlers.add(handler)
      return () => {
        handlers.delete(handler)
      }
    },
    close(): void {
      handlers.clear()
      selfWindow.removeEventListener('message', listener)
    },
  }
}
