/**
 * popup-client.ts — the POPUP side of the detached call popup (M4). Runs INSIDE
 * the detached window (`packages/web-app/src/call-popup.ts` is the DOM entry
 * that uses this). It owns nothing of the core: it gets a {@link
 * PopupRpcClient} whose calls are relayed to the opener, waits for the opener's
 * {@link CallPopupInit} handoff, and surfaces the relayed core events for the
 * popup's local `CallBridge` to consume.
 *
 * Handshake: on construction it posts `ready`; the opener replies with `init`.
 * On hangup / window unload the popup calls {@link reportEnded} so the opener
 * tears its host down cleanly (vs. the abrupt-close safety net in
 * `popup-host.ts`).
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
  /** Subscribe to relayed core events (answer / remote-ended /
   * accepted-elsewhere); returns an unsubscribe fn. */
  onEvent(handler: (event: PopupCallEvent) => void): () => void
  /** Tell the opener the call ended here (hangup / unload) so it stops
   * relaying — the opener will NOT then send a safety-net `endCall`. Idempotent. */
  reportEnded(): void
  /** Release the relay (rejects any in-flight RPC). */
  close(): void
}

/**
 * Connect the popup to its opener over `port`. Immediately posts `ready`; the
 * returned {@link CallPopupConnection.init} promise resolves when the opener
 * replies. Foreign / malformed messages are already filtered by the port
 * ({@link parsePopupMessage}) — handlers here only see valid protocol messages.
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
    reportEnded() {
      if (ended) return
      ended = true
      port.post({ protocol: CALL_POPUP_PROTOCOL, kind: 'ended' })
    },
    close() {
      eventHandlers.clear()
      unsubscribe()
      rpc.dispose()
      port.close()
    },
  }
}
