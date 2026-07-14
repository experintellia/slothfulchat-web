/**
 * popup-signaling.ts — the popup⇄opener IPC protocol (M4, docs/calls.md
 * §Windowing). The detached call popup owns media + `RTCPeerConnection` and
 * relays SIGNALING ONLY to the opener, which forwards it to the core Worker
 * (the Worker is owned by the main tab and can't be shared — OPFS/dedicated
 * worker constraint). This module is the pure wire format + a transport seam:
 *
 *   - {@link SignalingPort}: a minimal post/onMessage/close seam. In production
 *     it wraps `window.postMessage` between the two same-origin windows (see
 *     `window-port.ts`); in tests it is an in-memory pair, so the whole relay
 *     is unit-testable with no DOM.
 *   - The message union ({@link OpenerToPopupMessage} / {@link
 *     PopupToOpenerMessage}) and a validating {@link parsePopupMessage} — every
 *     inbound `postMessage` is untrusted (any page can post to a window), so
 *     messages are tagged with {@link CALL_POPUP_PROTOCOL} and structurally
 *     checked before use.
 *   - The RPC relay: {@link PopupRpcClient} (popup side — a `CallsRpcClient`
 *     whose calls travel over the port) and {@link servePopupRpc} (opener side —
 *     receives those calls and drives the REAL typed jsonrpc client).
 *
 * No DOM/React imports here (only ambient `RTCIceServer` etc. via the shared
 * `CallsRpcClient` type) — the DOM `postMessage` port lives in `window-port.ts`.
 */

import type { CallDirection } from '../engine/index.ts'
import type { CallsRpcClient } from './index.ts'

/** Version-tagged discriminator on every message. Bump on a breaking wire
 * change so an opener and a popup served from mismatched builds (e.g. a stale
 * cached popup page after a deploy) reject each other cleanly instead of
 * mis-parsing. */
export const CALL_POPUP_PROTOCOL = 'slothfulchat-call-popup/1'

/** The RPC methods the popup relays to the opener — the SIGNALING subset of
 * {@link CallsRpcClient} (nothing that touches the DOM or media; those stay in
 * the popup). Kept as a string union so {@link servePopupRpc} can exhaustively
 * dispatch. */
export type PopupRpcMethod =
  | 'placeOutgoingCall'
  | 'acceptIncomingCall'
  | 'endCall'
  | 'iceServers'

/** The call parameters the opener hands the popup once it signals readiness —
 * everything the popup needs to construct its own `CallBridge` locally. The
 * popup fetches its own ICE servers over the RPC relay ({@link
 * PopupRpcClient.iceServers}), so they are NOT included here: keeping ICE
 * fetching popup-side means the opener only ever forwards, matching "relays
 * signaling only". */
export interface CallPopupInit {
  direction: CallDirection
  accountId: number
  chatId: number
  /** Whether this call carries video (M3 `has_video`). */
  hasVideo: boolean
  /** Incoming: the info-message id (from the `IncomingCall` event), needed for
   * `acceptIncomingCall`/`endCall`. Outgoing: `null` — the popup learns its own
   * message id when `placeOutgoingCall` resolves over the relay. */
  callMessageId: number | null
  /** Incoming: the caller's raw-SDP offer (`place_call_info`). Outgoing: `null`. */
  offerSdp: string | null
  /** Best-effort chat/contact name for the popup's window/overlay title. */
  title: string
}

/** Core call events the opener relays into the popup (the popup owns the engine
 * that consumes them). Mirrors the runtime's `OutgoingCallAccepted` /
 * `CallEnded` / `IncomingCallAccepted{from_this_device:false}` handling. */
export type PopupCallEvent =
  | { type: 'answer'; acceptCallInfo: string }
  | { type: 'remote-ended' }
  | { type: 'accepted-elsewhere' }

export type OpenerToPopupMessage =
  | { protocol: typeof CALL_POPUP_PROTOCOL; kind: 'init'; init: CallPopupInit }
  | { protocol: typeof CALL_POPUP_PROTOCOL; kind: 'rpc-result'; id: number; ok: true; value: unknown }
  | { protocol: typeof CALL_POPUP_PROTOCOL; kind: 'rpc-result'; id: number; ok: false; error: string }
  | { protocol: typeof CALL_POPUP_PROTOCOL; kind: 'event'; event: PopupCallEvent }

export type PopupToOpenerMessage =
  | { protocol: typeof CALL_POPUP_PROTOCOL; kind: 'ready' }
  | { protocol: typeof CALL_POPUP_PROTOCOL; kind: 'rpc'; id: number; method: PopupRpcMethod; args: unknown[] }
  | { protocol: typeof CALL_POPUP_PROTOCOL; kind: 'ended' }

export type PopupMessage = OpenerToPopupMessage | PopupToOpenerMessage

/**
 * A transport seam carrying JSON-serializable messages between the two peers.
 * Production impl: `windowSignalingPort` (postMessage). Tests: `createPortPair`.
 */
export interface SignalingPort {
  /** Send one message to the peer. */
  post(message: PopupMessage): void
  /** Register a handler for inbound messages; returns an unsubscribe fn. */
  onMessage(handler: (message: PopupMessage) => void): () => void
  /** Detach all listeners / release the transport. Idempotent. */
  close(): void
}

/**
 * Validate an untrusted inbound value as one of our protocol messages. Returns
 * the narrowed message or `null` (wrong/foreign message — ignore it). Only the
 * shape needed to dispatch is checked; the payload fields (`init`, `args`, …)
 * are trusted structurally once the `protocol`+`kind` tag matches, since the
 * only sender of tagged messages is our own same-origin peer window.
 */
export function parsePopupMessage(value: unknown): PopupMessage | null {
  if (value == null || typeof value !== 'object') return null
  const m = value as Record<string, unknown>
  if (m.protocol !== CALL_POPUP_PROTOCOL) return null
  switch (m.kind) {
    case 'ready':
    case 'ended':
    case 'init':
    case 'event':
      return value as PopupMessage
    case 'rpc':
      return typeof m.id === 'number' && typeof m.method === 'string' && Array.isArray(m.args)
        ? (value as PopupMessage)
        : null
    case 'rpc-result':
      return typeof m.id === 'number' && typeof m.ok === 'boolean'
        ? (value as PopupMessage)
        : null
    default:
      return null
  }
}

/**
 * The popup-side {@link CallsRpcClient}: every method posts an `rpc` message and
 * resolves when the matching `rpc-result` comes back. This is what the popup's
 * `CallBridge` is constructed with instead of the real jsonrpc client — so the
 * engine/media stay in the popup while the SDP-bearing calls travel to the
 * opener and on to the core Worker.
 */
export class PopupRpcClient implements CallsRpcClient {
  private readonly port: SignalingPort
  private nextId = 1
  private readonly pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >()
  private readonly unsubscribe: () => void
  private closed = false

  constructor(port: SignalingPort) {
    this.port = port
    this.unsubscribe = port.onMessage(message => {
      if (message.kind !== 'rpc-result') return
      const entry = this.pending.get(message.id)
      if (entry == null) return
      this.pending.delete(message.id)
      if (message.ok) entry.resolve(message.value)
      else entry.reject(new Error(message.error))
    })
  }

  private call<T>(method: PopupRpcMethod, args: unknown[]): Promise<T> {
    if (this.closed) return Promise.reject(new Error('PopupRpcClient: relay closed'))
    const id = this.nextId++
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: value => resolve(value as T), reject })
      this.port.post({ protocol: CALL_POPUP_PROTOCOL, kind: 'rpc', id, method, args })
    })
  }

  placeOutgoingCall(
    accountId: number,
    chatId: number,
    placeCallInfo: string,
    hasVideo: boolean
  ): Promise<number> {
    return this.call('placeOutgoingCall', [accountId, chatId, placeCallInfo, hasVideo])
  }

  acceptIncomingCall(accountId: number, msgId: number, acceptCallInfo: string): Promise<void> {
    return this.call('acceptIncomingCall', [accountId, msgId, acceptCallInfo])
  }

  endCall(accountId: number, msgId: number): Promise<void> {
    return this.call('endCall', [accountId, msgId])
  }

  iceServers(accountId: number): Promise<string> {
    return this.call('iceServers', [accountId])
  }

  /** Reject every in-flight call and stop listening — called when the relay
   * tears down so a pending `await` never hangs forever. */
  dispose(): void {
    this.closed = true
    this.unsubscribe()
    const error = new Error('PopupRpcClient: relay closed')
    for (const [, entry] of this.pending) entry.reject(error)
    this.pending.clear()
  }
}

/**
 * The opener-side RPC responder: receives the popup's `rpc` messages, invokes
 * the REAL typed jsonrpc client, and posts the `rpc-result` back. Returns an
 * unsubscribe fn. `onCallMessageId` fires with the msg id the moment a relayed
 * `placeOutgoingCall` resolves — the opener needs it to route the subsequent
 * `OutgoingCallAccepted`/`CallEnded` core events back to this popup (the popup
 * itself learns the same id from the very same result).
 */
export function servePopupRpc(
  port: SignalingPort,
  rpc: CallsRpcClient,
  handlers: { onCallMessageId?: (msgId: number) => void } = {}
): () => void {
  return port.onMessage(message => {
    if (message.kind !== 'rpc') return
    const { id, method, args } = message
    void invokeRpc(rpc, method, args)
      .then(value => {
        if (method === 'placeOutgoingCall' && typeof value === 'number') {
          handlers.onCallMessageId?.(value)
        }
        port.post({ protocol: CALL_POPUP_PROTOCOL, kind: 'rpc-result', id, ok: true, value })
      })
      .catch((error: unknown) => {
        port.post({
          protocol: CALL_POPUP_PROTOCOL,
          kind: 'rpc-result',
          id,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        })
      })
  })
}

/** Typed dispatch of a relayed RPC onto the real client. Rejects on an unknown
 * method or malformed args rather than calling with `undefined` holes. */
function invokeRpc(rpc: CallsRpcClient, method: PopupRpcMethod, args: unknown[]): Promise<unknown> {
  switch (method) {
    case 'placeOutgoingCall':
      return rpc.placeOutgoingCall(
        args[0] as number,
        args[1] as number,
        args[2] as string,
        args[3] as boolean
      )
    case 'acceptIncomingCall':
      return rpc.acceptIncomingCall(args[0] as number, args[1] as number, args[2] as string)
    case 'endCall':
      return rpc.endCall(args[0] as number, args[1] as number)
    case 'iceServers':
      return rpc.iceServers(args[0] as number)
    default:
      return Promise.reject(new Error(`servePopupRpc: unknown method "${String(method)}"`))
  }
}
