/**
 * bridge/ — the thin glue that connects the framework-agnostic engine/ WebRTC
 * state machine ({@link AudioCallEngine}) to the typed jsonrpc client
 * (`rpc.placeOutgoingCall` / `acceptIncomingCall` / `endCall` / `iceServers`)
 * and the browser platform (getUserMedia + RTCPeerConnection). It is consumed by
 * `packages/web-app/src/runtime.ts`, which owns the call event subscriptions and
 * the ring/in-call UI (docs/calls.md §Architecture).
 *
 * The popup⇄opener signaling relay (docs/calls.md §Windowing) is M4 and not part
 * of this M1 surface — the engine runs in the main-window overlay for now.
 *
 * DOM lib is available here (for `navigator`/`RTCPeerConnection`), but there are
 * no React or DOM-tree (`document`) dependencies: this is glue, not UI.
 */

import {
  AudioCallEngine,
  type AudioCallMediaFactories,
  type CallDirection,
  type CallState,
  type CallStateListener,
  type PeerConnectionLike,
} from '../engine/index.ts'

export {
  AudioCallEngine,
  type AudioCallMediaFactories,
  type CallDirection,
  type CallState,
  type CallStateChange,
  type CallStateListener,
} from '../engine/index.ts'

/**
 * The subset of the generated jsonrpc `RawClient` the call bridge uses. The real
 * client (`getCore().dc.rpc`) is structurally assignable to this, so the runtime
 * passes it straight in — while keeping this package free of a direct dependency
 * on `@deltachat/jsonrpc-client`'s generated types.
 *
 * Payloads are the RAW SDP string (see engine/signaling.ts / INTEROP.md): NOT
 * base64, NOT JSON-wrapped.
 */
export interface CallsRpcClient {
  /** `place_outgoing_call(accountId, chatId, place_call_info, has_video) -> msgId`. */
  placeOutgoingCall(
    accountId: number,
    chatId: number,
    placeCallInfo: string,
    hasVideo: boolean
  ): Promise<number>
  /** `accept_incoming_call(accountId, msgId, accept_call_info)`. */
  acceptIncomingCall(
    accountId: number,
    msgId: number,
    acceptCallInfo: string
  ): Promise<void>
  /** `end_call(accountId, msgId)`. */
  endCall(accountId: number, msgId: number): Promise<void>
  /** `ice_servers(accountId) -> string` (JSON ICE list). */
  iceServers(accountId: number): Promise<string>
}

/**
 * Non-trickle ICE can hang forever on a pathological network (upstream has no
 * wall-clock timer — see engine/ice-gathering.ts). The runtime bridge sets this
 * safety net so a stuck gather resolves with whatever candidates are already in
 * the SDP instead of ringing forever.
 */
export const DEFAULT_GATHER_TIMEOUT_MS = 10_000

/**
 * Parse the JSON returned by `rpc.iceServers(accountId)` into `RTCIceServer[]`.
 * The core emits `[{ urls: string[], username?, credential? }]` (chatmail TURN
 * relay + a STUN default). Defensive: any malformed/empty payload yields `[]`
 * so a call can still attempt host/LAN candidates rather than throwing.
 */
export function parseIceServers(iceServersJson: string): RTCIceServer[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(iceServersJson)
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) {
    return []
  }
  const servers: RTCIceServer[] = []
  for (const entry of parsed) {
    if (entry == null || typeof entry !== 'object') continue
    const record = entry as Record<string, unknown>
    const urls = record.urls
    const normalizedUrls =
      typeof urls === 'string'
        ? urls
        : Array.isArray(urls)
          ? urls.filter((u): u is string => typeof u === 'string')
          : null
    if (normalizedUrls == null || (Array.isArray(normalizedUrls) && normalizedUrls.length === 0)) {
      continue
    }
    const server: RTCIceServer = { urls: normalizedUrls }
    if (typeof record.username === 'string') server.username = record.username
    if (typeof record.credential === 'string') server.credential = record.credential
    servers.push(server)
  }
  return servers
}

/**
 * Fetch and parse the account's ICE servers. Best-effort: on RPC failure or a
 * malformed payload it warns and resolves to `[]` so the call still proceeds
 * (host/LAN candidates only) rather than the whole call throwing.
 *
 * NOTE (docs/calls.md risk): `ice_servers()` may resolve TURN hostnames
 * host-side; on the WASM core that DNS path is stubbed, which would surface as
 * an empty/failed result here at M1 verify — a core-side concern to escalate.
 * We surface it (console.warn) instead of papering over it, but do not crash.
 */
export async function fetchIceServers(
  rpc: CallsRpcClient,
  accountId: number
): Promise<RTCIceServer[]> {
  try {
    return parseIceServers(await rpc.iceServers(accountId))
  } catch (error) {
    console.warn('calls: rpc.iceServers failed; proceeding without STUN/TURN', error)
    return []
  }
}

/**
 * The real platform seams for the engine: `getUserMedia` bound to
 * `navigator.mediaDevices`, and a live `RTCPeerConnection` factory. Tests inject
 * fakes instead.
 */
export function defaultMediaFactories(): AudioCallMediaFactories {
  return {
    getUserMedia: (constraints) => navigator.mediaDevices.getUserMedia(constraints),
    // A real RTCPeerConnection is structurally a PeerConnectionLike; the cast
    // only bridges TS's narrowed event-listener overloads in the interface.
    createPeerConnection: (configuration) =>
      new RTCPeerConnection(configuration) as unknown as PeerConnectionLike,
  }
}

export interface CallBridgeCallbacks {
  /** Observe engine call-state (drives "calling…/connected" and teardown in the UI). */
  onStateChange?: CallStateListener
  /** The peer's inbound audio stream — attach to an `<audio>` sink. */
  onRemoteStream?: (stream: MediaStream) => void
  /**
   * The outgoing call now has a `callMessageId` (from `placeOutgoingCall`). The
   * runtime uses this to index the call so it can route `OutgoingCallAccepted` /
   * `CallEnded` events back to it.
   */
  onCallMessageId?: (callMessageId: number) => void
  /** A fatal error tore the call down; the engine is already ended. */
  onError?: (error: Error) => void
}

export interface OutgoingCallParams {
  accountId: number
  chatId: number
  /** Whether we advertise video. M1 is audio-only, so the runtime passes false. */
  hasVideo: boolean
  iceServers: RTCIceServer[]
}

export interface IncomingCallParams {
  accountId: number
  chatId: number
  /** The info message id of the call (from the `IncomingCall` event). */
  callMessageId: number
  /** The caller's raw-SDP offer (`place_call_info`). */
  offerSdp: string
  iceServers: RTCIceServer[]
}

/**
 * One call's lifecycle: owns an {@link AudioCallEngine} and performs the jsonrpc
 * side effects (`placeOutgoingCall` / `acceptIncomingCall` / `endCall`) at the
 * right moments. The runtime creates one per call, renders UI against its
 * {@link state}, and forwards the matching core events into
 * {@link provideAnswer} / {@link remoteEnded} / {@link acceptedElsewhere}.
 */
export class CallBridge {
  readonly accountId: number
  readonly chatId: number
  readonly direction: CallDirection
  readonly hasVideo: boolean
  /** Known once placed (outgoing) or from the `IncomingCall` event (incoming). */
  callMessageId: number | null

  private readonly rpc: CallsRpcClient
  private readonly engine: AudioCallEngine
  private readonly callbacks: CallBridgeCallbacks
  private readonly pendingOfferSdp: string | null

  private constructor(init: {
    rpc: CallsRpcClient
    direction: CallDirection
    accountId: number
    chatId: number
    hasVideo: boolean
    callMessageId: number | null
    pendingOfferSdp: string | null
    iceServers: RTCIceServer[]
    factories: AudioCallMediaFactories
    callbacks: CallBridgeCallbacks
  }) {
    this.rpc = init.rpc
    this.direction = init.direction
    this.accountId = init.accountId
    this.chatId = init.chatId
    this.hasVideo = init.hasVideo
    this.callMessageId = init.callMessageId
    this.pendingOfferSdp = init.pendingOfferSdp
    this.callbacks = init.callbacks

    this.engine = new AudioCallEngine({
      iceServers: init.iceServers,
      factories: init.factories,
      gatherOptions: { overallTimeoutMs: DEFAULT_GATHER_TIMEOUT_MS },
      callbacks: {
        onStateChange: init.callbacks.onStateChange,
        onRemoteStream: init.callbacks.onRemoteStream,
        onError: init.callbacks.onError,
        onLocalOffer: (sdp) => {
          void this.placeOutgoing(sdp)
        },
        onLocalAnswer: (sdp) => {
          void this.sendAnswer(sdp)
        },
      },
    })
  }

  static outgoing(
    rpc: CallsRpcClient,
    params: OutgoingCallParams,
    factories: AudioCallMediaFactories,
    callbacks: CallBridgeCallbacks = {}
  ): CallBridge {
    return new CallBridge({
      rpc,
      direction: 'outgoing',
      accountId: params.accountId,
      chatId: params.chatId,
      hasVideo: params.hasVideo,
      callMessageId: null,
      pendingOfferSdp: null,
      iceServers: params.iceServers,
      factories,
      callbacks,
    })
  }

  static incoming(
    rpc: CallsRpcClient,
    params: IncomingCallParams,
    factories: AudioCallMediaFactories,
    callbacks: CallBridgeCallbacks = {}
  ): CallBridge {
    return new CallBridge({
      rpc,
      direction: 'incoming',
      accountId: params.accountId,
      chatId: params.chatId,
      hasVideo: false,
      callMessageId: params.callMessageId,
      pendingOfferSdp: params.offerSdp,
      iceServers: params.iceServers,
      factories,
      callbacks,
    })
  }

  get state(): CallState {
    return this.engine.state
  }

  get remoteStream(): MediaStream | null {
    return this.engine.remoteMediaStream
  }

  /** Local mic mute state (see {@link AudioCallEngine.muted}). */
  get muted(): boolean {
    return this.engine.muted
  }

  /** Mute/unmute the local mic. Local-only; no signaling round-trip. */
  setMuted(muted: boolean): void {
    this.engine.setMuted(muted)
  }

  /** Flip mute and return the new value. */
  toggleMuted(): boolean {
    return this.engine.toggleMuted()
  }

  /**
   * Begin the call. Outgoing: acquire mic → gather → build offer → (on offer
   * ready) `placeOutgoingCall`. Incoming: register the offer and start ringing;
   * the mic is not touched until {@link accept}. Call inside a user gesture for
   * the outgoing path so the mic-permission prompt is allowed.
   */
  async start(): Promise<void> {
    if (this.direction === 'outgoing') {
      await this.engine.placeCall()
    } else {
      if (this.pendingOfferSdp == null) {
        throw new Error('CallBridge.start: incoming call has no offer')
      }
      this.engine.receiveCall(this.pendingOfferSdp)
    }
  }

  /** Incoming only: accept the ringing call (acquire mic → build answer → send). */
  async accept(): Promise<void> {
    await this.engine.accept()
  }

  /** Outgoing only: feed the peer's answer from an `OutgoingCallAccepted` event. */
  provideAnswer(acceptCallInfo: string): void {
    void this.engine.provideAnswer(acceptCallInfo)
  }

  /**
   * The user hung up / declined. Tears down media+peer immediately and tells the
   * far end via `endCall` (once the call has a message id). Idempotent.
   */
  hangup(): void {
    const msgId = this.callMessageId
    this.engine.end()
    if (msgId != null) {
      this.rpc.endCall(this.accountId, msgId).catch(() => {
        /* best-effort; local teardown already done */
      })
    }
  }

  /** A `CallEnded` event arrived — tear down locally WITHOUT re-sending endCall. */
  remoteEnded(): void {
    this.engine.end()
  }

  /**
   * An `IncomingCallAccepted{ from_this_device: false }` arrived — the call was
   * picked up on another device. Stop ringing here; do NOT send `endCall`.
   */
  acceptedElsewhere(): void {
    this.engine.end()
  }

  private async placeOutgoing(offerSdp: string): Promise<void> {
    try {
      const msgId = await this.rpc.placeOutgoingCall(
        this.accountId,
        this.chatId,
        offerSdp,
        this.hasVideo
      )
      this.callMessageId = msgId
      // Hung up during the (message round-trip) placeOutgoingCall await: cancel
      // the call we just placed so we don't leave the far end ringing.
      if (this.engine.state === 'ended') {
        this.rpc.endCall(this.accountId, msgId).catch(() => {})
        return
      }
      this.callbacks.onCallMessageId?.(msgId)
    } catch (error) {
      this.engine.end()
      this.callbacks.onError?.(
        error instanceof Error ? error : new Error(String(error))
      )
    }
  }

  private async sendAnswer(answerSdp: string): Promise<void> {
    const msgId = this.callMessageId
    if (msgId == null) {
      this.engine.end()
      this.callbacks.onError?.(new Error('CallBridge: accept without a call message id'))
      return
    }
    try {
      await this.rpc.acceptIncomingCall(this.accountId, msgId, answerSdp)
    } catch (error) {
      this.engine.end()
      this.callbacks.onError?.(
        error instanceof Error ? error : new Error(String(error))
      )
    }
  }
}
