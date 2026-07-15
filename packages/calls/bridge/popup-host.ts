/**
 * Opener side of the detached call popup (protocol: `popup-signaling.ts`).
 * Engine + media + `RTCPeerConnection` live in the popup; this side only
 * relays signaling to the real jsonrpc client.
 *
 * Fallback: `window.open` returning `null` (popup blocked) is detected
 * synchronously so the caller can mount the in-page overlay while still inside
 * the user's click gesture (keeping `getUserMedia` gesture-authorized); a
 * window that opens but never handshakes is caught by the readiness timeout
 * (`onFallback`). Teardown: an abrupt window close ("X") means the popup's own
 * `endCall` relay can't flush, so this host polls `popup.closed` and sends a
 * safety-net `endCall`.
 */

import {
  CALL_POPUP_PROTOCOL,
  servePopupRpc,
  type CallPopupInit,
  type PopupCallEvent,
  type SignalingPort,
} from './popup-signaling.ts'
import { windowSignalingPort } from './window-port.ts'
import type { CallsRpcClient } from './index.ts'

/** How long to wait for the popup to post `ready` before falling back. */
export const DEFAULT_POPUP_READY_TIMEOUT_MS = 4_000
/** How often to check `popup.closed` (there is no reliable cross-window
 * "closed" event for a same-origin popup). */
const POPUP_CLOSED_POLL_MS = 500

export interface CallPopupHostOptions {
  /** The real typed jsonrpc client (`getCore().dc.rpc`) the relay drives. */
  rpc: CallsRpcClient
  /** Opens the popup window (injectable for tests). Invoked synchronously, so
   * it MUST be called inside the user gesture by the caller. */
  openWindow?: () => Window | null
  /** Handshake timeout (ms). Default {@link DEFAULT_POPUP_READY_TIMEOUT_MS}. */
  readyTimeoutMs?: number
  /** How often to poll `popup.closed` (ms). Injectable for tests. */
  closedPollMs?: number
  /** Build the signaling port over the opened window. Default: postMessage
   * (`windowSignalingPort`). Injectable so tests drive an in-memory pair. */
  createPort?: (popup: Window) => SignalingPort
  /** The popup handshaked and the call is now running in it. */
  onReady?: () => void
  /** The popup ended the call (clean `ended`, or an abrupt window close). After
   * this the host is spent. `reachedConnected`: whether the popup's engine ever
   * reached `connected` — `false` for an abrupt close (unknown) or an older
   * popup page that never reported it. */
  onEnded?: (reachedConnected: boolean) => void
  /** Handshake timed out — caller should fall back to the in-page overlay. Not
   * called for the synchronous popup-blocked case ({@link openCallPopup}
   * returns `null` for that). */
  onFallback?: (reason: string) => void
}

/**
 * Try to open the detached call popup. Returns `null` if `window.open` was
 * blocked (caller falls back to the overlay synchronously). A returned host is
 * not yet handshaked — `onReady` / `onFallback` report the outcome.
 */
export function openCallPopup(
  init: CallPopupInit,
  options: CallPopupHostOptions
): CallPopupHost | null {
  const openWindow = options.openWindow ?? (() => window.open(CALL_POPUP_URL, CALL_POPUP_TARGET, CALL_POPUP_FEATURES))
  const popup = openWindow()
  if (popup == null) return null // popup-blocked — synchronous fallback
  return new CallPopupHost(popup, init, options)
}

/** Same-origin popup page (see `packages/web-app/assemble.mjs`). Relative so
 * it works under any base path. */
export const CALL_POPUP_URL = 'call-popup.html'
/** Fresh window per call — an in-flight call's window must never be silently
 * reused by the next `window.open`. */
export const CALL_POPUP_TARGET = '_blank'
export const CALL_POPUP_FEATURES = 'popup=yes,width=480,height=640'

export class CallPopupHost {
  private readonly popup: Window
  private readonly options: CallPopupHostOptions
  private readonly init: CallPopupInit
  private readonly port: SignalingPort
  private unsubscribeMessages: (() => void) | null = null
  private unsubscribeRpc: (() => void) | null = null
  private readyTimer: ReturnType<typeof setTimeout> | null = null
  private closedPoll: ReturnType<typeof setInterval> | null = null
  private ready = false
  private done = false
  private endedCleanly = false
  /** Known for incoming from `init`; for outgoing, captured when the relayed
   * `placeOutgoingCall` resolves — used for the abrupt-close `endCall` safety
   * net and by the caller to route core events. */
  private trackedCallMessageId: number | null

  constructor(popup: Window, init: CallPopupInit, options: CallPopupHostOptions) {
    this.popup = popup
    this.init = init
    this.options = options
    this.trackedCallMessageId = init.callMessageId
    this.port = (options.createPort ?? (p => windowSignalingPort(p)))(popup)

    this.unsubscribeMessages = this.port.onMessage(message => {
      if (message.kind === 'ready') this.onReady()
      else if (message.kind === 'ended') this.onPopupEnded(message.reachedConnected ?? false)
    })
    this.unsubscribeRpc = servePopupRpc(this.port, options.rpc, {
      onCallMessageId: id => {
        this.trackedCallMessageId = id
      },
    })

    this.readyTimer = setTimeout(() => {
      if (this.ready || this.done) return
      this.teardown()
      // Close the blank/failed window so it doesn't linger while the opener
      // falls back to the overlay.
      try {
        this.popup.close()
      } catch {
        /* best-effort */
      }
      this.options.onFallback?.('handshake-timeout')
    }, options.readyTimeoutMs ?? DEFAULT_POPUP_READY_TIMEOUT_MS)

    this.closedPoll = setInterval(() => {
      if (this.done) return
      if (this.popup.closed) this.onPopupClosedAbruptly()
    }, options.closedPollMs ?? POPUP_CLOSED_POLL_MS)
  }

  /** The call's info-message id, once known (see {@link trackedCallMessageId}). */
  get callMessageId(): number | null {
    return this.trackedCallMessageId
  }

  /** Whether the popup has handshaked (its engine is driving the call). */
  get isReady(): boolean {
    return this.ready
  }

  private onReady(): void {
    if (this.ready || this.done) return
    this.ready = true
    if (this.readyTimer != null) {
      clearTimeout(this.readyTimer)
      this.readyTimer = null
    }
    this.port.post({ protocol: CALL_POPUP_PROTOCOL, kind: 'init', init: this.init })
    this.options.onReady?.()
  }

  // ── Core-event forwarding (opener → popup) ──────────────────────────────────

  /** `OutgoingCallAccepted` arrived — hand the peer's answer to the popup. */
  forwardAnswer(acceptCallInfo: string): void {
    this.forwardEvent({ type: 'answer', acceptCallInfo })
  }

  /** `CallEnded` arrived — the far end hung up. */
  forwardRemoteEnded(): void {
    this.endedCleanly = true // remote already tore down; no safety-net endCall needed
    this.forwardEvent({ type: 'remote-ended' })
  }

  /** `IncomingCallAccepted{from_this_device:false}` arrived while ringing. */
  forwardAcceptedElsewhere(): void {
    this.endedCleanly = true
    this.forwardEvent({ type: 'accepted-elsewhere' })
  }

  private forwardEvent(event: PopupCallEvent): void {
    if (this.done) return
    this.port.post({ protocol: CALL_POPUP_PROTOCOL, kind: 'event', event })
  }

  // ── Teardown ────────────────────────────────────────────────────────────────

  private onPopupEnded(reachedConnected: boolean): void {
    if (this.done) return
    // The popup relayed its own endCall before posting this; no safety net.
    this.endedCleanly = true
    this.teardown()
    this.options.onEnded?.(reachedConnected)
  }

  private onPopupClosedAbruptly(): void {
    if (this.done) return
    // The window was closed without a clean `ended` (user hit "X" mid-call):
    // the popup's relay never flushed, so notify the far end ourselves.
    if (!this.endedCleanly && this.trackedCallMessageId != null) {
      this.options.rpc
        .endCall(this.init.accountId, this.trackedCallMessageId)
        .catch(() => {
          /* best-effort — local teardown proceeds regardless */
        })
    }
    this.teardown()
    // We have no report from the popup on an abrupt close — `false` is the
    // conservative "unknown" default (see `onEnded`'s doc).
    this.options.onEnded?.(false)
  }

  /**
   * Opener-initiated close (e.g. the whole app is tearing down, or the call was
   * ended from the main window). Closes the popup window and stops relaying.
   * Does NOT itself send `endCall` — the caller owns that decision.
   */
  close(): void {
    if (this.done) return
    this.teardown()
    try {
      this.popup.close()
    } catch {
      /* best-effort */
    }
  }

  private teardown(): void {
    if (this.done) return
    this.done = true
    if (this.readyTimer != null) {
      clearTimeout(this.readyTimer)
      this.readyTimer = null
    }
    if (this.closedPoll != null) {
      clearInterval(this.closedPoll)
      this.closedPoll = null
    }
    this.unsubscribeRpc?.()
    this.unsubscribeRpc = null
    this.unsubscribeMessages?.()
    this.unsubscribeMessages = null
    this.port.close()
  }
}
