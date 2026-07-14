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
 *
 * M2 also adds the level-metering tap (`createTrackAnalyser` below): the only
 * piece of this file that reaches for a real `AudioContext`, mirroring how
 * `defaultMediaFactories` is the only piece that reaches for a real
 * `RTCPeerConnection`/`getUserMedia` — `engine/level-meter.ts` stays
 * DOM-import-free by taking an already-constructed analyser.
 */

import {
  AudioCallEngine,
  TrackLevelMeter,
  enumerateInputDevices,
  type AnalyserLike,
  type AudioCallMediaFactories,
  type CallDirection,
  type CallState,
  type CallStateListener,
  type DeviceEnumerator,
  type InputDevices,
  type PeerConnectionLike,
} from '../engine/index.ts'

export {
  AudioCallEngine,
  type AudioCallMediaFactories,
  type CallDirection,
  type CallState,
  type CallStateChange,
  type CallStateListener,
  type CallDeviceInfo,
  type DeviceEnumerator,
  type InputDevices,
  shouldShowDevicePicker,
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

/**
 * The real platform seam for M2 device enumeration: `enumerateDevices` bound
 * to `navigator.mediaDevices`. Tests inject a fake {@link DeviceEnumerator}
 * instead (see `engine/devices.test.ts`).
 */
export function defaultDeviceEnumerator(): DeviceEnumerator {
  return {
    enumerateDevices: () => navigator.mediaDevices.enumerateDevices(),
  }
}

/**
 * Enumerate the mic/camera picker options using the real platform seam. A
 * thin convenience wrapper over `engine`'s {@link enumerateInputDevices} so
 * `packages/web-app/src/runtime.ts` doesn't need to import `engine/` directly
 * just for this one call (docs/calls.md: engine/ is consumed via `ui`/`bridge`).
 */
export function listInputDevices(): Promise<InputDevices> {
  return enumerateInputDevices(defaultDeviceEnumerator())
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
  /**
   * Smoothed local-mic level, 0..1 (M2 speaking rings, docs/calls.md:
   * "Web-Audio level meters driving avatar rings"). Starts firing (~10x/sec)
   * as soon as the local stream exists — i.e. once `state` is `ringing`
   * (outgoing, mic already acquired to build the offer) or `connecting`
   * (incoming, mic acquired on accept). Never fires for an incoming call
   * still ringing (mic deliberately untouched — see `AudioCallEngine.receiveCall`).
   */
  onLocalLevel?: (level: number) => void
  /** Smoothed remote-peer level, 0..1, same cadence, starting once
   * `onRemoteStream` has fired. */
  onRemoteLevel?: (level: number) => void
  /**
   * `AudioCallEngine.switchMicrophone` failed (M2 device selection) — the
   * previous mic keeps flowing untouched; surface this next to the device
   * picker (a toast/inline note), not as a call-ending error.
   */
  onDeviceSwitchError?: (error: Error) => void
}

/**
 * Lazily-created `AudioContext` shared by every level-metering tap on the
 * page (M2). One instance rather than one per track: browsers cap the number
 * of concurrent `AudioContext`s, and there is nothing to gain from separate
 * contexts here — each tap is just its own `MediaStreamAudioSourceNode` →
 * `AnalyserNode` chain hung off the same clock. Created on first use (not at
 * module load) so a page that never places/receives a call never pays for one.
 */
let sharedMeterAudioContext: AudioContext | null = null

function getSharedMeterAudioContext(): AudioContext {
  if (sharedMeterAudioContext == null) {
    sharedMeterAudioContext = new AudioContext()
  }
  if (sharedMeterAudioContext.state === 'suspended') {
    // Best-effort: by the time a track exists to meter, the call started from
    // a user gesture (call button / Accept click), so this is expected to
    // succeed; if it doesn't, the meter just reads a flat 0 until it does
    // rather than throwing.
    void sharedMeterAudioContext.resume().catch(() => {})
  }
  return sharedMeterAudioContext
}

export interface TrackAnalyserHandle {
  readonly analyser: AnalyserLike
  /** Disconnect this tap from the shared `AudioContext`. Does NOT stop the
   * underlying `MediaStreamTrack` — that stays owned by the engine/call. */
  dispose(): void
}

/**
 * Wire a real Web Audio `AnalyserNode` to one live audio track, for
 * `engine/level-meter.ts`'s `TrackLevelMeter` to poll (M2 speaking rings).
 * The only file in `packages/calls` that constructs a real `AudioContext` —
 * everything downstream (`TrackLevelMeter`) only sees the structural
 * {@link AnalyserLike}.
 *
 * The analyser is routed through a zero-gain node to the shared context's
 * `destination`: not to be heard (gain 0 = silent — the actual remote-audio
 * playback is the separate `<audio>` element in `CallOverlay`), but because a
 * Web Audio node with no path to `destination` is not guaranteed to keep
 * being pulled/processed in every browser, which would silently stop the
 * meter from producing fresh samples.
 */
export function createTrackAnalyser(track: MediaStreamTrack): TrackAnalyserHandle {
  const context = getSharedMeterAudioContext()
  const source = context.createMediaStreamSource(new MediaStream([track]))
  const analyser = context.createAnalyser()
  analyser.fftSize = 512
  const silentSink = context.createGain()
  silentSink.gain.value = 0
  source.connect(analyser)
  analyser.connect(silentSink)
  silentSink.connect(context.destination)
  return {
    analyser,
    dispose: () => {
      // best-effort: disconnecting an already-disconnected/torn-down node is
      // harmless, but guard anyway since dispose() must never throw into a
      // teardown path.
      try {
        source.disconnect()
      } catch {
        /* best-effort */
      }
      try {
        analyser.disconnect()
      } catch {
        /* best-effort */
      }
      try {
        silentSink.disconnect()
      } catch {
        /* best-effort */
      }
    },
  }
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

  /** M2 speaking-ring metering (local + remote), lazily created once each
   * stream exists — see {@link ensureLocalLevelMeter}/{@link startRemoteLevelMeter}
   * and torn down together in {@link stopLevelMeters}. */
  private localLevelMeter: TrackLevelMeter | null = null
  private localMeterTap: TrackAnalyserHandle | null = null
  private remoteLevelMeter: TrackLevelMeter | null = null
  private remoteMeterTap: TrackAnalyserHandle | null = null

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
        onStateChange: (state, change) => {
          init.callbacks.onStateChange?.(state, change)
          // Centralizing on the state machine (rather than also hooking
          // hangup()/remoteEnded()/acceptedElsewhere() directly) covers every
          // teardown path uniformly — including the engine's own internal
          // failure path — since ALL of them funnel through
          // AudioCallEngine.end(), which the state machine notifies exactly
          // once no matter which caller reached `ended` first.
          if (state === 'ended') {
            this.stopLevelMeters()
          }
        },
        onRemoteStream: (stream) => {
          init.callbacks.onRemoteStream?.(stream)
          this.startRemoteLevelMeter(stream)
        },
        onError: init.callbacks.onError,
        onDeviceSwitchError: init.callbacks.onDeviceSwitchError,
        // Fires for the FIRST mic acquisition (placeCall/accept) AND every
        // successful `switchMicrophone` (M2 device selection) — one precise
        // "local track (re)ready" seam, so the local meter always listens to
        // whatever device is actually live rather than assuming
        // `localMediaStream`'s first audio track never changes identity
        // (`switchMicrophone` mutates the stream's tracks in place via
        // `removeTrack`/`addTrack`, so the *stream* reference is stable but
        // the *track* underneath it is not).
        onLocalTrackChanged: (track) => {
          this.retapLocalLevelMeter(track)
        },
        onLocalOffer: (sdp) => {
          void this.placeOutgoing(sdp)
        },
        onLocalAnswer: (sdp) => {
          void this.sendAnswer(sdp)
        },
      },
    })
  }

  /** (Re)start metering the local mic on `track` — used both for the initial
   * mic and every subsequent {@link switchMicrophone}, via
   * `onLocalTrackChanged` above. Disposes any previous tap/meter first so a
   * mid-call switch doesn't leak the old device's analyser. */
  private retapLocalLevelMeter(track: MediaStreamTrack): void {
    this.localLevelMeter?.stop()
    this.localMeterTap?.dispose()
    const tap = createTrackAnalyser(track)
    this.localMeterTap = tap
    this.localLevelMeter = new TrackLevelMeter({
      analyser: tap.analyser,
      onLevel: (level) => this.callbacks.onLocalLevel?.(level),
    })
    this.localLevelMeter.start()
  }

  /** Start metering the remote peer's audio the moment its stream arrives. */
  private startRemoteLevelMeter(stream: MediaStream): void {
    this.stopRemoteLevelMeter() // defensive: a stream swap isn't expected in M1/M2, but don't leak if it happens
    const track = stream.getAudioTracks()[0]
    if (track == null) return
    const tap = createTrackAnalyser(track)
    this.remoteMeterTap = tap
    this.remoteLevelMeter = new TrackLevelMeter({
      analyser: tap.analyser,
      onLevel: (level) => this.callbacks.onRemoteLevel?.(level),
    })
    this.remoteLevelMeter.start()
  }

  private stopRemoteLevelMeter(): void {
    this.remoteLevelMeter?.stop()
    this.remoteLevelMeter = null
    this.remoteMeterTap?.dispose()
    this.remoteMeterTap = null
  }

  /** Stop and dispose both meters — called once, from the `ended` branch of
   * the wrapped `onStateChange` above, covering every teardown path. */
  private stopLevelMeters(): void {
    this.localLevelMeter?.stop()
    this.localLevelMeter = null
    this.localMeterTap?.dispose()
    this.localMeterTap = null
    this.stopRemoteLevelMeter()
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

  /** The local mic's `MediaStream` (M2: lets the runtime read the ACTUAL
   * in-use device off `getAudioTracks()[0].getSettings().deviceId` to seed
   * the device picker's initial selection — see `AudioCallEngine.localMediaStream`
   * for why the *stream* reference stays stable across a `switchMicrophone`
   * hot-swap while the *track* underneath it doesn't). `null` while an
   * incoming call is still ringing (mic not yet acquired). */
  get localStream(): MediaStream | null {
    return this.engine.localMediaStream
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

  /** The mic `deviceId` currently in use, or `null` if none was ever
   * explicitly selected (browser default). See {@link switchMicrophone}. */
  get audioInputDeviceId(): string | null {
    return this.engine.audioInputDeviceId
  }

  /**
   * Hot-switch the outgoing mic mid-call (M2 device selection) — see
   * `AudioCallEngine.switchMicrophone`. A failure reports
   * `callbacks.onDeviceSwitchError` and leaves the call/previous mic
   * untouched; it never ends the call.
   */
  async switchMicrophone(deviceId: string): Promise<void> {
    await this.engine.switchMicrophone(deviceId)
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
