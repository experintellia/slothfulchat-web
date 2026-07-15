/**
 * bridge/ — the glue connecting the framework-agnostic engine/ to the typed
 * jsonrpc client and the browser platform (getUserMedia, RTCPeerConnection,
 * AudioContext). Consumed by `packages/web-app/src/runtime.ts`, which owns
 * the call event subscriptions and the ring/in-call UI (docs/calls.md).
 * DOM lib is available here, but no React or `document` dependencies.
 */

import {
  AudioCallEngine,
  ConnectionRouteMonitor,
  TrackLevelMeter,
  enumerateInputDevices,
  type AnalyserLike,
  type AudioCallMediaFactories,
  type CallDirection,
  type CallState,
  type CallStateListener,
  type ConnectionRoute,
  type DeviceEnumerator,
  type InputDevices,
  type PeerConnectionLike,
} from '../engine/index.ts'
import type { CallInfoResult } from './call-outcome.ts'

export {
  AudioCallEngine,
  type AudioCallMediaFactories,
  type CallDirection,
  type CallState,
  type CallStateChange,
  type CallStateListener,
  type CallDeviceInfo,
  type ConnectionRoute,
  type DeviceEnumerator,
  type InputDevices,
  shouldShowDevicePicker,
} from '../engine/index.ts'

// The detached call popup ⇄ opener signaling relay — see popup-signaling.ts.
export {
  CALL_POPUP_PROTOCOL,
  PopupRpcClient,
  servePopupRpc,
  parsePopupMessage,
  type SignalingPort,
  type CallPopupInit,
  type PopupCallEvent,
  type PopupRpcMethod,
  type OpenerToPopupMessage,
  type PopupToOpenerMessage,
  type PopupMessage,
} from './popup-signaling.ts'
export { windowSignalingPort } from './window-port.ts'
export {
  openCallPopup,
  CallPopupHost,
  CALL_POPUP_URL,
  CALL_POPUP_TARGET,
  CALL_POPUP_FEATURES,
  DEFAULT_POPUP_READY_TIMEOUT_MS,
  type CallPopupHostOptions,
} from './popup-host.ts'
export { connectCallPopup, type CallPopupConnection } from './popup-client.ts'

// Call-outcome classification and the incoming-call ringtone/vibration.
export {
  classifyCallOutcome,
  type CallInfoResult,
  type CallInfoState,
  type CallResult,
  type CoreCallStateKind,
} from './call-outcome.ts'
export { RingtonePlayer, vibratePattern, type RingtonePlayerOptions } from './ringtone.ts'

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
  /** `call_info(accountId, msgId) -> CallInfo` — a typed object, NOT a JSON
   * string like `iceServers`. Feeds {@link classifyCallOutcome}. */
  callInfo(accountId: number, msgId: number): Promise<CallInfoResult>
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
 * (host/LAN candidates only). NOTE: the WASM core's stubbed DNS path can make
 * `ice_servers()` fail/return empty — surfaced via console.warn, never a crash.
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
    // getDisplayMedia is not universally available — feature-detect so this
    // factory never throws; the engine handles its absence gracefully.
    getDisplayMedia:
      typeof navigator.mediaDevices.getDisplayMedia === 'function'
        ? (constraints) => navigator.mediaDevices.getDisplayMedia(constraints)
        : undefined,
  }
}

/** The real platform seam for device enumeration; tests inject a fake. */
export function defaultDeviceEnumerator(): DeviceEnumerator {
  return {
    enumerateDevices: () => navigator.mediaDevices.enumerateDevices(),
  }
}

/** Enumerate the mic/camera picker options — wraps {@link enumerateInputDevices}
 * so the runtime never imports engine/ directly. */
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
  /** Smoothed local-mic level, 0..1 (~10x/sec), once the local stream exists.
   * Never fires for an incoming call still ringing (mic not yet acquired). */
  onLocalLevel?: (level: number) => void
  /** Smoothed remote-peer level, 0..1, same cadence, starting once
   * `onRemoteStream` has fired. */
  onRemoteLevel?: (level: number) => void
  /** A mic/camera switch failed — the previous device keeps flowing; surface
   * inline, not as a call-ending error. */
  onDeviceSwitchError?: (error: Error) => void
  /** The outgoing local VIDEO track was (re)established — re-attach the local
   * preview's `srcObject` on this event (the track identity changes even
   * though the stream is stable). `null` = video went away, drop the preview. */
  onLocalVideoTrackChanged?: (track: MediaStreamTrack | null) => void
  /**
   * The REMOTE side's video went live/away — deduped, engine-owned (peer
   * `mutedState` messages, remote-track events as pre-message fallback).
   * Show the remote video tile when `true`, the avatar when `false`.
   */
  onRemoteVideoActiveChanged?: (active: boolean) => void
  /** The REMOTE side muted/unmuted its mic — deduped. Drives a mute badge. */
  onRemoteAudioMutedChanged?: (muted: boolean) => void
  /** `screenSharing` flipped — including the browser's own "Stop sharing"
   * affordance ending the capture out-of-band. */
  onScreenShareChanged?: (sharing: boolean) => void
  /** A screen-share start/stop failed — the call keeps running; surface
   * inline, not as the call-ending `onError`. */
  onScreenShareError?: (error: Error) => void
  /** The direct-vs-relay indicator changed. Polled only while `connected`;
   * fires on the first reading, then only on change. Purely informational. */
  onConnectionRouteChanged?: (route: ConnectionRoute) => void
}

/** Lazily-created `AudioContext` shared by every level-metering tap: browsers
 * cap concurrent AudioContexts, and each tap is just its own source→analyser
 * chain off the same clock. */
let sharedMeterAudioContext: AudioContext | null = null

function getSharedMeterAudioContext(): AudioContext {
  if (sharedMeterAudioContext == null) {
    sharedMeterAudioContext = new AudioContext()
  }
  if (sharedMeterAudioContext.state === 'suspended') {
    // Best-effort: the call started from a user gesture so resume() should
    // succeed; if not, the meter reads a flat 0 rather than throwing.
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
 * Wire a real Web Audio `AnalyserNode` to one live audio track for
 * `TrackLevelMeter` to poll — the only place in `packages/calls` that
 * constructs a real `AudioContext`. The analyser is routed through a
 * zero-gain node to `destination` (silent): a node with no path to
 * `destination` is not guaranteed to keep being processed in every browser,
 * which would silently freeze the meter.
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
      // guards: dispose() must never throw into a teardown path.
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
  /** The caller's choice; `true` acquires the camera alongside the mic and is
   * sent as `has_video` to `rpc.placeOutgoingCall`. */
  hasVideo: boolean
  /** Preferred camera `deviceId`, seeding the initial acquisition when `hasVideo`. */
  cameraInputDeviceId?: string
  iceServers: RTCIceServer[]
}

export interface IncomingCallParams {
  accountId: number
  chatId: number
  /** The info message id of the call (from the `IncomingCall` event). */
  callMessageId: number
  /** The caller's raw-SDP offer (`place_call_info`). */
  offerSdp: string
  /** Mirrors the `IncomingCall` event's `has_video`: a peer that sent a video
   * m-line expects one back (offer/answer symmetry) — `accept_incoming_call`
   * has no `has_video` RPC parameter, so this is the only lever. */
  hasVideo: boolean
  /** Preferred camera `deviceId`, seeding the initial acquisition when `hasVideo`. */
  cameraInputDeviceId?: string
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

  /** Speaking-ring metering (local + remote), lazily created once each stream
   * exists; torn down together in {@link stopLevelMeters}. */
  private localLevelMeter: TrackLevelMeter | null = null
  private localMeterTap: TrackAnalyserHandle | null = null
  private remoteLevelMeter: TrackLevelMeter | null = null
  private remoteMeterTap: TrackAnalyserHandle | null = null

  /** Direct-vs-relay indicator: polls `engine.getConnectionRoute()` only
   * while `connected` (no active candidate pair exists before that). */
  private routeMonitor: ConnectionRouteMonitor | null = null

  /** Guards `rpc.endCall` against being sent more than once — a double hangup,
   * or a hangup landing after the call already ended remotely / was accepted on
   * another device. The engine's teardown is already idempotent; this makes the
   * far-side RPC idempotent too. */
  private endCallSent = false

  private constructor(init: {
    rpc: CallsRpcClient
    direction: CallDirection
    accountId: number
    chatId: number
    hasVideo: boolean
    cameraInputDeviceId?: string
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
      hasVideo: init.hasVideo,
      videoInputDeviceId: init.cameraInputDeviceId,
      callbacks: {
        onStateChange: (state, change) => {
          init.callbacks.onStateChange?.(state, change)
          // Hooking the state machine (not hangup/remoteEnded/etc. directly)
          // covers every teardown path uniformly — all funnel through
          // AudioCallEngine.end(), which notifies exactly once.
          if (state === 'connected') {
            this.startRouteMonitor()
          } else if (state === 'ended') {
            this.stopLevelMeters()
            this.stopRouteMonitor()
          }
        },
        onRemoteStream: (stream) => {
          init.callbacks.onRemoteStream?.(stream)
          this.startRemoteLevelMeter(stream)
        },
        onError: init.callbacks.onError,
        onDeviceSwitchError: init.callbacks.onDeviceSwitchError,
        // Fires on the first mic acquisition AND every successful switch —
        // the meter must re-tap whichever track is actually live (see the
        // engine's onLocalTrackChanged doc).
        onLocalTrackChanged: (track) => {
          this.retapLocalLevelMeter(track)
        },
        onLocalVideoTrackChanged: init.callbacks.onLocalVideoTrackChanged,
        onRemoteVideoActiveChanged: init.callbacks.onRemoteVideoActiveChanged,
        onRemoteAudioMutedChanged: init.callbacks.onRemoteAudioMutedChanged,
        onScreenShareChanged: init.callbacks.onScreenShareChanged,
        onScreenShareError: init.callbacks.onScreenShareError,
        onLocalOffer: (sdp) => {
          void this.placeOutgoing(sdp)
        },
        onLocalAnswer: (sdp) => {
          void this.sendAnswer(sdp)
        },
      },
    })
  }

  /** (Re)start metering the local mic on `track`, disposing any previous
   * tap/meter first so a mid-call switch doesn't leak the old analyser. */
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

  /** Stop and dispose both meters — from the `ended` branch of the wrapped
   * `onStateChange`, covering every teardown path. */
  private stopLevelMeters(): void {
    this.localLevelMeter?.stop()
    this.localLevelMeter = null
    this.localMeterTap?.dispose()
    this.localMeterTap = null
    this.stopRemoteLevelMeter()
  }

  /** Begin polling the direct-vs-relay indicator once `connected`. Idempotent. */
  private startRouteMonitor(): void {
    if (this.routeMonitor == null) {
      this.routeMonitor = new ConnectionRouteMonitor({
        poll: () => this.engine.getConnectionRoute(),
        onRoute: (route) => this.callbacks.onConnectionRouteChanged?.(route),
      })
    }
    this.routeMonitor.start()
  }

  private stopRouteMonitor(): void {
    this.routeMonitor?.stop()
    this.routeMonitor = null
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
      cameraInputDeviceId: params.cameraInputDeviceId,
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
      hasVideo: params.hasVideo,
      cameraInputDeviceId: params.cameraInputDeviceId,
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

  /** The local mic's `MediaStream` (stable reference across device switches;
   * the runtime reads the in-use device off its track's settings). `null`
   * while an incoming call is still ringing. */
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

  /** The mic `deviceId` currently in use; `null` = browser default. */
  get audioInputDeviceId(): string | null {
    return this.engine.audioInputDeviceId
  }

  /** Hot-switch the outgoing mic — see `AudioCallEngine.switchMicrophone`. */
  async switchMicrophone(deviceId: string): Promise<void> {
    await this.engine.switchMicrophone(deviceId)
  }

  /** The camera `deviceId` currently selected; `null` = never selected. */
  get videoInputDeviceId(): string | null {
    return this.engine.videoInputDeviceId
  }

  /** Hot-switch the outgoing camera — see `AudioCallEngine.switchCamera`. */
  async switchCamera(deviceId: string): Promise<void> {
    await this.engine.switchCamera(deviceId)
  }

  /** Whether the outgoing video is currently a screen capture. */
  get screenSharing(): boolean {
    return this.engine.screenSharing
  }

  /** Whether the local camera is currently on. */
  get cameraEnabled(): boolean {
    return this.engine.cameraEnabled
  }

  /** Turn the local camera on/off — see `AudioCallEngine.setCameraEnabled`. */
  async setCameraEnabled(enabled: boolean): Promise<void> {
    await this.engine.setCameraEnabled(enabled)
  }

  /** Flip {@link cameraEnabled} and return the intended new value. */
  async toggleCamera(): Promise<boolean> {
    const next = !this.engine.cameraEnabled
    await this.engine.setCameraEnabled(next)
    return next
  }

  /** The last direct-vs-relay value reported to `onConnectionRouteChanged`;
   * `'unknown'` before the first poll resolves. */
  get connectionRoute(): ConnectionRoute {
    return this.routeMonitor?.route ?? 'unknown'
  }

  /** Start sharing the screen — see `AudioCallEngine.startScreenShare`. */
  async startScreenShare(): Promise<void> {
    await this.engine.startScreenShare()
  }

  /** Stop sharing and restore the camera — see `AudioCallEngine.stopScreenShare`. */
  async stopScreenShare(): Promise<void> {
    await this.engine.stopScreenShare()
  }

  /** Flip {@link screenSharing}. */
  async toggleScreenShare(): Promise<void> {
    await this.engine.toggleScreenShare()
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
    if (msgId != null) this.sendEndCall(msgId)
  }

  /** Send `rpc.endCall` at most once (see {@link endCallSent}). */
  private sendEndCall(msgId: number): void {
    if (this.endCallSent) return
    this.endCallSent = true
    this.rpc.endCall(this.accountId, msgId).catch(() => {
      /* best-effort; local teardown already done */
    })
  }

  /** A `CallEnded` event arrived — tear down locally WITHOUT re-sending endCall. */
  remoteEnded(): void {
    this.endCallSent = true // far end already ended it; a late hangup must not echo
    this.engine.end()
  }

  /**
   * An `IncomingCallAccepted{ from_this_device: false }` arrived — the call was
   * picked up on another device. Stop ringing here; do NOT send `endCall`.
   */
  acceptedElsewhere(): void {
    this.endCallSent = true // this device isn't in the call; never send endCall
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
      // the call we just placed so we don't leave the far end ringing. (hangup()
      // ran with a null msgId, so it couldn't send endCall itself — we do it now.)
      if (this.engine.state === 'ended') {
        this.sendEndCall(msgId)
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
