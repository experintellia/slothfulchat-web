/**
 * popup-host.ts — the OPENER side of the detached call popup (M4, docs/calls.md
 * §Windowing). The opener owns the core Worker; this host opens the popup
 * window, performs the readiness handshake, forwards the popup's relayed RPC to
 * the real jsonrpc client ({@link servePopupRpc}), and pushes core call events
 * into the popup. The engine + media + `RTCPeerConnection` live in the POPUP;
 * this side only relays signaling.
 *
 * FALLBACK (the whole reason the overlay is the safe default): opening can fail
 * two ways —
 *   1. `window.open` returns `null` (popup blocked) — detected SYNCHRONOUSLY by
 *      {@link openCallPopup}, which returns `null` so the caller can mount the
 *      in-page overlay while still inside the user's click gesture (so the
 *      overlay's own `getUserMedia` is still gesture-authorized).
 *   2. The window opens but never handshakes (blank/failed page, slow load) —
 *      detected by the readiness timeout, which closes the popup and calls
 *      `onFallback`; the caller then mounts the overlay (best-effort — the
 *      original gesture is stale by then, but a granted mic permission does not
 *      require a fresh gesture on most browsers).
 *
 * TEARDOWN: the popup relays `endCall` itself on hangup, then posts `ended`. But
 * if the user closes the popup window abruptly (window "X"), its relay can't
 * flush — so this host polls `popup.closed` and, on an unexpected close, sends
 * `endCall` for the tracked message id as a safety net before reporting
 * `onEnded`.
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

/** Default handshake budget: how long to wait for the popup page to load and
 * post `ready` before giving up and falling back to the overlay. */
export const DEFAULT_POPUP_READY_TIMEOUT_MS = 4_000
/** How often to check `popup.closed` (there is no reliable cross-window
 * "closed" event for a same-origin popup). */
const POPUP_CLOSED_POLL_MS = 500

export interface CallPopupHostOptions {
  /** The real typed jsonrpc client (`getCore().dc.rpc`) the relay drives. */
  rpc: CallsRpcClient
  /** Opens the popup window. Default: `window.open(url, target, features)`.
   * Injectable for tests / to customize window features. MUST be called inside
   * the user gesture by the caller (it is invoked synchronously here). */
  openWindow?: () => Window | null
  /** Handshake timeout (ms). Default {@link DEFAULT_POPUP_READY_TIMEOUT_MS}. */
  readyTimeoutMs?: number
  /** How often to poll `popup.closed` (ms). Default {@link POPUP_CLOSED_POLL_MS}.
   * Injectable mainly so tests can drive the abrupt-close path with a short
   * real interval instead of a faked clock. */
  closedPollMs?: number
  /** Build the signaling port over the opened window. Default: postMessage
   * (`windowSignalingPort`). Injectable so tests drive an in-memory pair. */
  createPort?: (popup: Window) => SignalingPort
  /** The popup handshaked and the call is now running in it. */
  onReady?: () => void
  /** The popup ended the call (clean `ended`, or an abrupt window close). After
   * this the host is spent. */
  onEnded?: () => void
  /** The popup could not be established (handshake timeout) — the caller should
   * fall back to the in-page overlay. Not called for the synchronous
   * popup-blocked case (that is signaled by {@link openCallPopup} returning
   * `null`). */
  onFallback?: (reason: string) => void
}

/**
 * Try to open the detached call popup. Returns a live {@link CallPopupHost}, or
 * `null` if `window.open` was blocked (the caller falls back to the overlay
 * synchronously). A returned host is not yet handshaked — `onReady` fires when
 * it is, `onFallback` if the handshake times out.
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

/** Same-origin path the popup loads (served by the web-app build alongside
 * main.html — see `packages/web-app/assemble.mjs`). Relative so it works under
 * any base path (GitHub Pages subpath, custom domain). */
export const CALL_POPUP_URL = 'call-popup.html'
/** A fresh window per call (unique name) rather than reusing one — an in-flight
 * call must never have its window silently reused by the next `window.open`. */
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
      else if (message.kind === 'ended') this.onPopupEnded()
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

  private onPopupEnded(): void {
    if (this.done) return
    // The popup relayed its own endCall before posting this; no safety net.
    this.endedCleanly = true
    this.teardown()
    this.options.onEnded?.()
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
    this.options.onEnded?.()
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
