/**
 * Popup side of the detached call popup — runs inside the detached window
 * (DOM entry: `packages/web-app/src/call-popup.ts`). Protocol and relay live
 * in `popup-signaling.ts`. Posts `ready` on construction; the opener replies
 * with `init`.
 */

import {
  CALL_POPUP_PROTOCOL,
  PopupRpcClient,
  type CallPopupInit,
  type PopupCallEvent,
  type SignalingPort,
} from './popup-signaling.ts'

export interface CallPopupConnection {
  /** The relayed RPC client to construct the popup's `CallBridge` with. */
  readonly rpc: PopupRpcClient
  /** Resolves with the opener's call parameters once it posts `init`. */
  readonly init: Promise<CallPopupInit>
  /** Subscribe to relayed core events; returns an unsubscribe fn. */
  onEvent(handler: (event: PopupCallEvent) => void): () => void
  /** Tell the opener the call ended here (hangup / unload) so it skips its
   * abrupt-close safety-net `endCall`. Idempotent. `reachedConnected`: whether
   * this popup's engine ever reached `connected` (opener-side outcome
   * analytics; see `PopupToOpenerMessage`'s `ended` doc). Default `false`. */
  reportEnded(reachedConnected?: boolean): void
  /** Release the relay (rejects any in-flight RPC). */
  close(): void
}

/**
 * Connect the popup to its opener over `port`. Foreign / malformed messages
 * are already filtered by the port ({@link parsePopupMessage}).
 */
export function connectCallPopup(port: SignalingPort): CallPopupConnection {
  const rpc = new PopupRpcClient(port)
  const eventHandlers = new Set<(event: PopupCallEvent) => void>()
  let ended = false

  let resolveInit!: (init: CallPopupInit) => void
  const initPromise = new Promise<CallPopupInit>(resolve => {
    resolveInit = resolve
  })
  let initResolved = false

  const unsubscribe = port.onMessage(message => {
    if (message.kind === 'init') {
      if (!initResolved) {
        initResolved = true
        resolveInit(message.init)
      }
    } else if (message.kind === 'event') {
      for (const handler of [...eventHandlers]) handler(message.event)
    }
  })

  // Announce readiness so the opener hands over `init`.
  port.post({ protocol: CALL_POPUP_PROTOCOL, kind: 'ready' })

  return {
    rpc,
    init: initPromise,
    onEvent(handler) {
      eventHandlers.add(handler)
      return () => {
        eventHandlers.delete(handler)
      }
    },
    reportEnded(reachedConnected = false) {
      if (ended) return
      ended = true
      port.post({ protocol: CALL_POPUP_PROTOCOL, kind: 'ended', reachedConnected })
    },
    close() {
      eventHandlers.clear()
      unsubscribe()
      rpc.dispose()
      port.close()
    },
  }
}
