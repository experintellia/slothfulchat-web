/**
 * The WebRTC call engine — audio-first, optional camera video + screen share.
 * One instance == one call; after `ended` it is spent, create a new one.
 *
 * Pure TS: everything platform-touching (`getUserMedia`, `RTCPeerConnection`
 * construction) is injected via {@link AudioCallMediaFactories}, keeping the
 * engine unit-testable under Node and location-agnostic (overlay or popup).
 *
 * Single-negotiation constraint: exactly ONE offer/answer exchange per call —
 * renegotiating would mean another store-and-forward DeltaChat message
 * round-trip. So a video sender is ALWAYS negotiated up front (audio-started
 * calls included, matching calls-webapp) and every mid-call media change
 * (mic/camera switch, camera toggle, screen share) rides
 * `RTCRtpSender.replaceTrack` on the existing senders; such failures never
 * end the call, they report onDeviceSwitchError/onScreenShareError.
 *
 * Epoch teardown rule: {@link AudioCallEngine.end} can land at any await
 * boundary. Once `ended`, state transitions are silent no-ops, and an epoch
 * token is re-checked after every `await` ({@link AudioCallEngine.ensureActive});
 * a stale continuation bails, stopping any just-resolved stream so nothing leaks.
 */

import {
  CALLS_WEBAPP_RTC_CONFIGURATION,
  ICE_TRICKLING_DATA_CHANNEL,
  MUTED_STATE_DATA_CHANNEL,
} from './constants.ts';
import {
  gatherUntilEnoughIce,
  type GatherOptions,
  type GatheringPeerConnection,
} from './ice-gathering.ts';
import {
  serializeAnswer,
  serializeOffer,
  deserializeAnswer,
  deserializeOffer,
} from './signaling.ts';
import {
  CallStateMachine,
  type CallDirection,
  type CallState,
  type CallStateListener,
} from './call-state.ts';
import {
  getActiveConnectionRoute,
  type ConnectionRoute,
  type StatsReportLike,
} from './connection-route.ts';

/** The subset of `RTCRtpSender` the engine needs; a real one (or a test fake)
 * is structurally assignable. */
export interface RtpSenderLike {
  readonly track: MediaStreamTrack | null;
  replaceTrack(track: MediaStreamTrack | null): Promise<void>;
  /** Associates streams for the a=msid line without needing a track (real
   * `RTCRtpSender.setStreams`). Needed by the audio-started answerer — see
   * {@link AudioCallEngine.addLocalTracks}'s msid note. */
  setStreams?(...streams: MediaStream[]): void;
}

/**
 * The subset of `RTCRtpTransceiver` the engine needs; a real one (or a test
 * fake) is structurally assignable. `direction` is settable so the answerer
 * can promote the peer-offered video m-line from its `recvonly` default to
 * `sendrecv` before creating the answer — see {@link AudioCallEngine.addLocalTracks}.
 */
export interface RtpTransceiverLike {
  direction: RTCRtpTransceiverDirection;
  /** The NEGOTIATED direction (`null` until negotiation completes). Read only
   * by the post-connect video diagnostics (see {@link AudioCallEngine}). */
  readonly currentDirection?: RTCRtpTransceiverDirection | null;
  readonly sender: RtpSenderLike;
  readonly receiver?: { readonly track: MediaStreamTrack | null };
}

/** The subset of `RTCDataChannel` the engine needs for the negotiated
 * `iceTrickling`/`mutedState` channels (see `constants.ts`). */
export interface DataChannelLike {
  readonly readyState: RTCDataChannelState;
  send(data: string): void;
  addEventListener(type: 'open', listener: () => void): void;
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
  removeEventListener(type: 'open', listener: () => void): void;
  removeEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
}

/**
 * The subset of `RTCPeerConnection` the engine drives; a real one (or a test
 * fake) is structurally assignable. Extends {@link GatheringPeerConnection}
 * so the same object satisfies the ICE-gathering helper.
 */
export interface PeerConnectionLike extends GatheringPeerConnection {
  readonly connectionState: RTCPeerConnectionState;
  readonly localDescription: { readonly type: string; readonly sdp: string } | null;
  createOffer(): Promise<RTCSessionDescriptionInit>;
  createAnswer(): Promise<RTCSessionDescriptionInit>;
  setLocalDescription(description?: RTCLocalSessionDescriptionInit): Promise<void>;
  setRemoteDescription(description: RTCSessionDescriptionInit): Promise<void>;
  addTrack(track: MediaStreamTrack, ...streams: MediaStream[]): unknown;
  /** Establish a transceiver for a media kind without attaching a track yet —
   * how an audio-started offerer still negotiates a video m-line. */
  addTransceiver(
    kind: 'audio' | 'video',
    init?: { direction?: RTCRtpTransceiverDirection; streams?: MediaStream[] }
  ): RtpTransceiverLike;
  getSenders(): RtpSenderLike[];
  /** Used by the answerer to find and promote the recvonly video transceiver
   * `setRemoteDescription` created — see {@link AudioCallEngine.addLocalTracks}. */
  getTransceivers(): RtpTransceiverLike[];
  /** The calls-webapp contract's negotiated data channels (see `constants.ts`):
   * both peers declare identical `{ negotiated, id }` so no in-band negotiation. */
  createDataChannel(
    label: string,
    options?: { negotiated?: boolean; id?: number }
  ): DataChannelLike;
  /** Feeds {@link AudioCallEngine.getConnectionRoute}'s direct-vs-relay indicator. */
  getStats(): Promise<StatsReportLike>;
  close(): void;
  // Overloads are NOT inherited/merged across `extends`: a subtype's
  // addEventListener must be assignable to the base's, so we must restate the
  // GatheringPeerConnection overloads (icecandidate/icegatheringstatechange)
  // here alongside the ones the engine adds (connectionstatechange/track).
  addEventListener(
    type: 'icecandidate',
    listener: (event: { candidate: RTCIceCandidate | null }) => void
  ): void;
  addEventListener(type: 'icegatheringstatechange', listener: () => void): void;
  addEventListener(type: 'connectionstatechange', listener: () => void): void;
  addEventListener(
    type: 'track',
    listener: (event: { readonly streams: ReadonlyArray<MediaStream>; readonly track: MediaStreamTrack }) => void
  ): void;
  removeEventListener(
    type: 'icecandidate',
    listener: (event: { candidate: RTCIceCandidate | null }) => void
  ): void;
  removeEventListener(type: 'icegatheringstatechange', listener: () => void): void;
  removeEventListener(type: 'connectionstatechange', listener: () => void): void;
  removeEventListener(
    type: 'track',
    listener: (event: { readonly streams: ReadonlyArray<MediaStream>; readonly track: MediaStreamTrack }) => void
  ): void;
}

/** Injected platform seams — the only things that touch the real WebRTC stack. */
export interface AudioCallMediaFactories {
  /** Typically `navigator.mediaDevices.getUserMedia` bound to `mediaDevices`. */
  getUserMedia(constraints: MediaStreamConstraints): Promise<MediaStream>;
  /** Typically `(config) => new RTCPeerConnection(config)`. */
  createPeerConnection(configuration: RTCConfiguration): PeerConnectionLike;
  /**
   * Screen-capture source for {@link AudioCallEngine.startScreenShare} (M3).
   * Typically `navigator.mediaDevices.getDisplayMedia` bound to `mediaDevices`.
   * Optional: only required if a consumer ever calls `startScreenShare` —
   * `switchMicrophone`/audio-only calls never touch it, so a test harness
   * that never exercises screen share can omit it entirely.
   */
  getDisplayMedia?(constraints?: MediaStreamConstraints): Promise<MediaStream>;
  /**
   * A silent/black, DISABLED video track attached to the always-negotiated
   * video sender so the SDP announces a real `a=ssrc` and that SSRC stays
   * stable across `replaceTrack` — iOS WebKit can't demux RTP on an SSRC it
   * never saw signaled (desktop Chrome demuxes by MID and tolerates it), so an
   * audio-started call's mid-call camera would otherwise render black on iOS.
   * calls-webapp equivalently sends a disabled camera track. Optional: absent =
   * fall back to the old trackless video m-line (fine for Chrome-only tests).
   */
  createPlaceholderVideoTrack?(): MediaStreamTrack;
}

export interface AudioCallCallbacks {
  /** Outgoing: the local OFFER (raw SDP) is ready to hand to `rpc.placeOutgoingCall`. */
  onLocalOffer?(sdp: string): void;
  /** Incoming: the local ANSWER (raw SDP) is ready to hand to `rpc.acceptIncomingCall`. */
  onLocalAnswer?(sdp: string): void;
  /** The remote audio stream became available (attach to an `<audio>` element in the UI). */
  onRemoteStream?(stream: MediaStream): void;
  /**
   * The outgoing local audio track was (re)established — initial acquisition
   * or a mic switch. Track-tapping consumers (level meter) must re-tap here:
   * the *stream* reference is stable across switches, the *track* is not.
   */
  onLocalTrackChanged?(track: MediaStreamTrack): void;
  /**
   * The outgoing local VIDEO track was (re)established (camera acquisition/
   * switch, screen-share swap) — same re-tap rationale as
   * {@link onLocalTrackChanged}. `null` means the outgoing video went away
   * entirely; drop the local preview.
   */
  onLocalVideoTrackChanged?(track: MediaStreamTrack | null): void;
  /** Mirror of the state machine, for convenience (same as `subscribe`). */
  onStateChange?: CallStateListener;
  /** A fatal error tore the call down; the engine is already `ended`. */
  onError?(error: Error): void;
  /** A device switch failed; the call is NOT torn down (the previous track
   * keeps flowing). Surface inline, not as the call-ending {@link onError}. */
  onDeviceSwitchError?(error: Error): void;
  /** {@link AudioCallEngine.screenSharing} flipped (including the browser's
   * own "Stop sharing" affordance ending the capture out-of-band). */
  onScreenShareChanged?(sharing: boolean): void;
  /** Screen-share start/stop failed; call NOT torn down — same contract as
   * {@link onDeviceSwitchError}. */
  onScreenShareError?(error: Error): void;
  /**
   * The REMOTE side's video went live/away — deduped. Driven by the peer's
   * `mutedState` data-channel messages (authoritative once the first valid
   * one arrives) with track mute/unmute/ended events as the fallback.
   */
  onRemoteVideoActiveChanged?(active: boolean): void;
  /** The REMOTE side muted/unmuted its mic (`!audioEnabled` from the peer's
   * `mutedState` data-channel messages) — deduped. Drives a mute badge. */
  onRemoteAudioMutedChanged?(muted: boolean): void;
}

export interface AudioCallOptions {
  /** ICE servers fed in from outside (runtime: `rpc.iceServers(accountId)`). */
  iceServers: RTCIceServer[];
  /** Platform seams (see {@link AudioCallMediaFactories}). */
  factories: AudioCallMediaFactories;
  callbacks?: AudioCallCallbacks;
  /**
   * Non-trickle ICE gathering. Defaults to the real {@link gatherUntilEnoughIce};
   * injectable so the engine's orchestration can be unit-tested without emitting
   * candidate events.
   */
  gather?: (pc: GatheringPeerConnection, options?: GatherOptions) => Promise<void>;
  /** Options forwarded to the gather function (e.g. `overallTimeoutMs`). */
  gatherOptions?: GatherOptions;
  /** Audio track constraints. Default: `true` (default mic). */
  audioConstraints?: MediaTrackConstraints | boolean;
  /** Preferred mic `deviceId`, seeds the initial `getUserMedia` only; mid-call
   * changes go through {@link AudioCallEngine.switchMicrophone}. */
  audioInputDeviceId?: string;
  /**
   * Whether a camera track is attached at START (a video sender is negotiated
   * regardless — see class doc). Outgoing: the caller's choice (also passed as
   * `has_video` to `rpc.placeOutgoingCall`). Incoming: should mirror the
   * remote offer's `has_video`. Default `false`.
   */
  hasVideo?: boolean;
  /** Video track constraints (when {@link hasVideo}). Default: `true` (default camera). */
  videoConstraints?: MediaTrackConstraints | boolean;
  /** Preferred camera `deviceId`; mirrors {@link audioInputDeviceId}. */
  videoInputDeviceId?: string;
}

type ConnectionListener = () => void;
type TrackListener = (event: {
  readonly streams: ReadonlyArray<MediaStream>;
  readonly track: MediaStreamTrack;
}) => void;

export class AudioCallEngine {
  private readonly machine = new CallStateMachine();
  private readonly factories: AudioCallMediaFactories;
  private readonly iceServers: RTCIceServer[];
  private readonly callbacks: AudioCallCallbacks;
  private readonly gather: (pc: GatheringPeerConnection, options?: GatherOptions) => Promise<void>;
  private readonly gatherOptions: GatherOptions | undefined;
  private readonly audioConstraints: MediaTrackConstraints | boolean;
  /** Current mic selection; `null` = browser default. */
  private selectedAudioInputDeviceId: string | null = null;
  /** See {@link AudioCallOptions.hasVideo}. */
  private readonly wantsVideo: boolean;
  private readonly videoConstraints: MediaTrackConstraints | boolean;
  /** Current camera selection; `null` = browser default. */
  private selectedVideoInputDeviceId: string | null = null;

  private direction: CallDirection | null = null;
  private pc: PeerConnectionLike | null = null;
  private localStream: MediaStream | null = null;
  private remoteStream: MediaStream | null = null;
  /** The always-negotiated outgoing video sender that camera/screen-share
   * `replaceTrack` on (see class doc); `null` only if the peer offered no
   * video m-line at all. */
  private videoSender: RtpSenderLike | null = null;
  /** The disabled black placeholder on {@link videoSender} (see
   * {@link AudioCallMediaFactories.createPlaceholderVideoTrack}); lazily made
   * by {@link getPlaceholderTrack}. Kept out of `localStream` (not user media,
   * preserves localHasVideo semantics); stopped only in {@link teardown}. */
  private placeholderVideoTrack: MediaStreamTrack | null = null;
  /** The live `getDisplayMedia()` stream while screen-sharing. */
  private screenShareStream: MediaStream | null = null;
  private screenSharingState = false;
  /** Whether a live camera track is the current outgoing video. Mutually
   * exclusive with {@link screenSharingState} — they share the one video
   * sender, so at most one is true. */
  private cameraOnState = false;
  /** Local mute intent; re-applied whenever `localStream` is (re)assigned so
   * it survives ringing → connected. */
  private mutedState = false;
  /** Incoming: the remote offer SDP, held until the user accepts. */
  private pendingRemoteOffer: string | null = null;
  /** A video-started call whose camera acquisition failed degrades to
   * audio-only; the non-fatal error is held here and surfaced via
   * `onDeviceSwitchError` once the call is set up ({@link flushCameraStartError}). */
  private pendingCameraStartError: Error | null = null;
  /** Epoch guard: a fresh object per call, nulled by {@link end}. */
  private epoch: object | null = null;
  /** Aborted by {@link end} to unblock a pending `await gathered`: a closed pc
   * emits no candidate/completion events, so without this placeCall()/accept()
   * would hang forever and retain the closed pc. */
  private gatherAbort: AbortController | null = null;
  private pcConnectionListener: ConnectionListener | null = null;
  private pcTrackListener: TrackListener | null = null;
  /** The `mutedState` negotiated data channel — outgoing mute/camera state
   * rides it; incoming messages drive the onRemote* callbacks. */
  private mutedStateChannel: DataChannelLike | null = null;
  private mutedStateOpenListener: (() => void) | null = null;
  private mutedStateMessageListener: ((event: { data: unknown }) => void) | null = null;
  /** Created only so our SDP carries the m=application section the wire
   * contract expects. */
  private iceTricklingChannel: DataChannelLike | null = null;
  /** Once the first valid `mutedState` message arrives, messages are the
   * authoritative remote-video signal; the track-event fallback is ignored. */
  private remoteMutedStateReceived = false;
  /** Last emitted onRemoteVideoActiveChanged / onRemoteAudioMutedChanged
   * values, for dedupe. `null` = never emitted. */
  private remoteVideoActive: boolean | null = null;
  private remoteAudioMuted: boolean | null = null;
  /** The remote video track being watched (fallback signal) + its cleanup. */
  private remoteVideoTrack: MediaStreamTrack | null = null;
  private remoteVideoTrackCleanup: (() => void) | null = null;
  /** Diagnostics run once per call, on reaching connected. */
  private videoDiagnosticsLogged = false;

  constructor(options: AudioCallOptions) {
    this.factories = options.factories;
    this.iceServers = options.iceServers;
    this.callbacks = options.callbacks ?? {};
    this.gather = options.gather ?? gatherUntilEnoughIce;
    this.gatherOptions = options.gatherOptions;
    this.audioConstraints = options.audioConstraints ?? true;
    this.selectedAudioInputDeviceId = options.audioInputDeviceId ?? null;
    this.wantsVideo = options.hasVideo ?? false;
    this.videoConstraints = options.videoConstraints ?? true;
    this.selectedVideoInputDeviceId = options.videoInputDeviceId ?? null;
    if (this.callbacks.onStateChange) {
      this.machine.subscribe(this.callbacks.onStateChange);
    }
  }

  // ── Observation ─────────────────────────────────────────────────────────────

  get state(): CallState {
    return this.machine.state;
  }

  get callDirection(): CallDirection | null {
    return this.direction;
  }

  get localMediaStream(): MediaStream | null {
    return this.localStream;
  }

  get remoteMediaStream(): MediaStream | null {
    return this.remoteStream;
  }

  /** Whether the local mic is currently muted (see {@link setMuted}). */
  get muted(): boolean {
    return this.mutedState;
  }

  /** The mic `deviceId` currently in use; `null` = browser default. */
  get audioInputDeviceId(): string | null {
    return this.selectedAudioInputDeviceId;
  }

  /** Whether this call STARTED with the camera enabled. Initial choice only —
   * a video sender always exists regardless (see {@link addLocalTracks});
   * use {@link cameraEnabled} for the live camera state. */
  get hasVideo(): boolean {
    return this.wantsVideo;
  }

  /** Whether a live CAMERA track is currently the outgoing video. `false`
   * while {@link screenSharing} (the screen occupies the single video sender). */
  get cameraEnabled(): boolean {
    return this.cameraOnState;
  }

  /** The camera `deviceId` currently selected — kept even while screen-sharing
   * (used by the next camera acquisition). `null` = never selected. */
  get videoInputDeviceId(): string | null {
    return this.selectedVideoInputDeviceId;
  }

  /** Whether the outgoing video is currently a screen capture. */
  get screenSharing(): boolean {
    return this.screenSharingState;
  }

  /**
   * The direct-vs-relay connection indicator. Purely informational: never
   * blocks call setup, never changes ICE behavior (no forced-relay setting —
   * deferred to issue #93). `'unknown'` before a pc exists or after teardown;
   * pollers should stop once `state` leaves `connected`.
   */
  async getConnectionRoute(): Promise<ConnectionRoute> {
    if (this.pc == null) return 'unknown';
    return getActiveConnectionRoute(this.pc);
  }

  /**
   * Mute/unmute the local mic via `track.enabled` (no core RPC involved); the
   * state is also pushed over the `mutedState` channel, best-effort. Safe to
   * call before a local stream exists — the intent is recorded and applied
   * once the mic is acquired.
   */
  setMuted(muted: boolean): void {
    this.mutedState = muted;
    this.applyMutedToLocalStream();
    this.sendLocalMutedState();
  }

  /** Flip {@link muted} and return the new value. */
  toggleMuted(): boolean {
    this.setMuted(!this.mutedState);
    return this.mutedState;
  }

  private applyMutedToLocalStream(): void {
    if (this.localStream == null) return;
    for (const track of this.localStream.getAudioTracks()) {
      track.enabled = !this.mutedState;
    }
  }

  /** Observe call-state changes. Returns an unsubscribe function. */
  subscribe(listener: CallStateListener): () => void {
    return this.machine.subscribe(listener);
  }

  // ── Outgoing ────────────────────────────────────────────────────────────────

  /**
   * Place an outgoing call: acquire the mic, gather ICE (relay-or-timeout),
   * build the offer, and surface it via `callbacks.onLocalOffer`. Moves
   * idle → ringing and stays there until {@link provideAnswer}.
   */
  async placeCall(): Promise<void> {
    if (this.machine.state !== 'idle') {
      throw new Error(`placeCall: expected idle, engine is "${this.machine.state}"`);
    }
    this.direction = 'outgoing';
    const epoch = this.beginEpoch();
    this.machine.transition('ringing');

    try {
      const stream = await this.acquireInitialLocalStream();
      if (!this.ensureActive(epoch)) {
        this.stopStream(stream); // resolved after hang up — stop it, don't adopt it
        return;
      }
      this.localStream = stream;
      this.applyMutedToLocalStream();
      this.notifyLocalTrackChanged(stream);
      this.flushCameraStartError(epoch); // non-fatal degraded-to-audio camera failure

      const pc = this.createPeerConnection(epoch);
      // Attach the gather listeners BEFORE setLocalDescription so no candidate
      // is missed (see ice-gathering.ts CRITICAL ORDERING).
      const gathered = this.gather(pc, this.gatherOptionsWithSignal());
      await this.addLocalTracks(pc, stream, /* isOfferer */ true);
      if (!this.ensureActive(epoch)) return;
      const offer = await pc.createOffer();
      if (!this.ensureActive(epoch)) return;
      await pc.setLocalDescription(offer);
      if (!this.ensureActive(epoch)) return;
      await gathered;
      if (!this.ensureActive(epoch)) return;

      const sdp = pc.localDescription?.sdp ?? '';
      this.callbacks.onLocalOffer?.(serializeOffer({ type: 'offer', sdp }));
    } catch (error) {
      this.fail(epoch, error);
    }
  }

  /**
   * Outgoing: feed the answer (raw SDP from `OutgoingCallAccepted`) into the
   * peer connection. Moves ringing → connecting; the peer connection then drives
   * connecting → connected on its own. A no-op if the call already ended.
   */
  async provideAnswer(acceptCallInfo: string): Promise<void> {
    if (this.machine.isTerminal) return;
    if (this.direction !== 'outgoing') {
      throw new Error('provideAnswer: not an outgoing call');
    }
    const remote = deserializeAnswer(acceptCallInfo); // validates non-empty SDP
    const pc = this.pc;
    if (pc == null) {
      throw new Error('provideAnswer: no peer connection (offer not placed yet)');
    }
    // ringing → connecting; if we are no longer ringing (already connecting,
    // connected or ended), this is a silent no-op and we do nothing further.
    if (!this.machine.transition('connecting')) return;
    const epoch = this.epoch;
    if (epoch == null) return;
    try {
      await pc.setRemoteDescription({ type: 'answer', sdp: remote.sdp });
      if (!this.ensureActive(epoch)) return;
      // If the connection is already `connected` (fast local loopback), promote
      // now; otherwise the connectionstatechange listener will.
      this.maybePromoteConnected(epoch, pc);
    } catch (error) {
      this.fail(epoch, error);
    }
  }

  // ── Incoming ────────────────────────────────────────────────────────────────

  /**
   * Register an incoming call from an `IncomingCall` event. Stores the remote
   * offer and moves idle → ringing. Deliberately does NOT acquire the mic yet —
   * that waits for {@link accept} so the permission prompt rides the user's
   * accept gesture.
   */
  receiveCall(placeCallInfo: string): void {
    if (this.machine.state !== 'idle') {
      throw new Error(`receiveCall: expected idle, engine is "${this.machine.state}"`);
    }
    const remote = deserializeOffer(placeCallInfo); // validates non-empty SDP
    this.direction = 'incoming';
    this.pendingRemoteOffer = remote.sdp;
    this.beginEpoch();
    this.machine.transition('ringing');
  }

  /**
   * Incoming: accept the ringing call — acquire the mic, apply the stored
   * offer, gather ICE, build the answer, and surface it via
   * `callbacks.onLocalAnswer`. Moves ringing → connecting.
   */
  async accept(): Promise<void> {
    if (this.direction !== 'incoming') {
      throw new Error('accept: not an incoming call');
    }
    if (this.machine.state !== 'ringing') {
      throw new Error(`accept: expected ringing, engine is "${this.machine.state}"`);
    }
    const offerSdp = this.pendingRemoteOffer;
    if (offerSdp == null) {
      throw new Error('accept: no pending offer');
    }
    if (!this.machine.transition('connecting')) return;
    const epoch = this.epoch;
    if (epoch == null) return;

    try {
      const stream = await this.acquireInitialLocalStream();
      if (!this.ensureActive(epoch)) {
        this.stopStream(stream);
        return;
      }
      this.localStream = stream;
      this.applyMutedToLocalStream();
      this.notifyLocalTrackChanged(stream);
      this.flushCameraStartError(epoch); // non-fatal degraded-to-audio camera failure

      const pc = this.createPeerConnection(epoch);
      const gathered = this.gather(pc, this.gatherOptionsWithSignal());
      await pc.setRemoteDescription({ type: 'offer', sdp: offerSdp });
      if (!this.ensureActive(epoch)) return;
      await this.addLocalTracks(pc, stream, /* isOfferer */ false);
      if (!this.ensureActive(epoch)) return;
      const answer = await pc.createAnswer();
      if (!this.ensureActive(epoch)) return;
      await pc.setLocalDescription(answer);
      if (!this.ensureActive(epoch)) return;
      await gathered;
      if (!this.ensureActive(epoch)) return;

      const sdp = pc.localDescription?.sdp ?? '';
      this.callbacks.onLocalAnswer?.(serializeAnswer({ type: 'answer', sdp }));
      // The offer/answer may have completed the handshake already.
      this.maybePromoteConnected(epoch, pc);
    } catch (error) {
      this.fail(epoch, error);
    }
  }

  // ── Device switching (M2) ────────────────────────────────────────────────────

  /**
   * Hot-switch the outgoing mic to `deviceId`: fresh `getUserMedia` +
   * `replaceTrack` on the existing audio sender (no renegotiation, see class
   * doc). Requires an active pc; no-op once ended. On failure the previous
   * track keeps flowing and `onDeviceSwitchError` fires.
   */
  async switchMicrophone(deviceId: string): Promise<void> {
    const epoch = this.epoch;
    if (epoch == null || this.machine.isTerminal) return; // ended: silent no-op
    const pc = this.pc;
    if (pc == null) {
      this.reportDeviceSwitchError(
        new Error('switchMicrophone: no active peer connection yet')
      );
      return;
    }

    let newStream: MediaStream;
    try {
      newStream = await this.factories.getUserMedia({
        audio: this.audioConstraintsFor(deviceId),
        video: false,
      });
    } catch (error) {
      this.reportDeviceSwitchError(error);
      return;
    }
    if (!this.ensureActive(epoch)) {
      this.stopStream(newStream); // call ended while getUserMedia was in flight
      return;
    }

    const newTrack = newStream.getAudioTracks()[0];
    if (newTrack == null) {
      this.stopStream(newStream);
      this.reportDeviceSwitchError(
        new Error('switchMicrophone: the new stream had no audio track')
      );
      return;
    }
    newTrack.enabled = !this.mutedState; // preserve mute intent across the swap

    try {
      const sender = pc.getSenders().find((s) => s.track != null && s.track.kind === 'audio');
      if (sender == null) {
        throw new Error('switchMicrophone: no audio sender to replace');
      }
      await sender.replaceTrack(newTrack);
    } catch (error) {
      this.stopStream(newStream);
      this.reportDeviceSwitchError(error);
      return;
    }
    if (!this.ensureActive(epoch)) {
      // Torn down during replaceTrack: the pc is already closed (which stops
      // the outgoing track anyway), just release the stream we just made.
      this.stopStream(newStream);
      return;
    }

    // Swap the track within the existing MediaStream so localMediaStream
    // (and anything holding a reference to it) reflects the new device.
    const oldStream = this.localStream;
    if (oldStream != null) {
      for (const oldTrack of oldStream.getAudioTracks()) {
        oldStream.removeTrack(oldTrack);
        oldTrack.stop();
      }
      oldStream.addTrack(newTrack);
    } else {
      this.localStream = newStream;
    }
    this.selectedAudioInputDeviceId = deviceId;
    this.callbacks.onLocalTrackChanged?.(newTrack);
  }

  // ── Video device switching + screen share (M3) ──────────────────────────────

  /**
   * Hot-switch the outgoing camera, mirroring {@link switchMicrophone}. Only
   * swaps a LIVE camera track: while the camera is off or a screen share owns
   * the sender, this just records the preference — it never turns the camera
   * on as a side effect.
   */
  async switchCamera(deviceId: string): Promise<void> {
    const epoch = this.epoch;
    if (epoch == null || this.machine.isTerminal) return; // ended: silent no-op
    if (this.screenSharingState) {
      // Nothing live to replace right now; the next setCameraEnabled(true)
      // acquisition uses this deviceId.
      this.selectedVideoInputDeviceId = deviceId;
      return;
    }
    if (!this.cameraOnState) {
      // Camera is off: record the preference for the next setCameraEnabled(true)
      // acquisition — picking a device must not turn the camera on.
      this.selectedVideoInputDeviceId = deviceId;
      return;
    }
    const sender = this.videoSender;
    if (sender == null) {
      this.reportDeviceSwitchError(new Error('switchCamera: no active video sender yet'));
      return;
    }

    let newStream: MediaStream;
    try {
      newStream = await this.factories.getUserMedia({
        audio: false,
        video: this.videoConstraintsFor(deviceId),
      });
    } catch (error) {
      this.reportDeviceSwitchError(error);
      return;
    }
    if (!this.ensureActive(epoch)) {
      this.stopStream(newStream);
      return;
    }
    const newTrack = newStream.getVideoTracks()[0];
    if (newTrack == null) {
      this.stopStream(newStream);
      this.reportDeviceSwitchError(new Error('switchCamera: the new stream had no video track'));
      return;
    }

    try {
      await sender.replaceTrack(newTrack);
    } catch (error) {
      this.stopStream(newStream);
      this.reportDeviceSwitchError(error);
      return;
    }
    if (!this.ensureActive(epoch)) {
      this.stopStream(newStream);
      return;
    }

    this.swapLocalVideoTrack(newTrack);
    this.selectedVideoInputDeviceId = deviceId;
    const cameraWasOff = !this.cameraOnState;
    this.cameraOnState = true; // a live camera track is now on the wire
    if (cameraWasOff) this.sendLocalMutedState(); // defensive; camera-off returns early above
    this.callbacks.onLocalVideoTrackChanged?.(newTrack);
  }

  /**
   * Turn the local camera on/off mid-call — works on ANY call since the video
   * sender always exists. Enabling acquires a camera and `replaceTrack`s it;
   * disabling `replaceTrack(null)`s and stops the track. Camera and screen
   * share are mutually exclusive: enabling while screen-sharing stops the
   * share first, then puts the camera on the sender.
   */
  async setCameraEnabled(enabled: boolean): Promise<void> {
    const epoch = this.epoch;
    if (epoch == null || this.machine.isTerminal) return; // ended: silent no-op
    const sender = this.videoSender;
    if (sender == null) {
      // Defensive only — the sender is always established (see addLocalTracks).
      this.reportDeviceSwitchError(new Error('setCameraEnabled: no active video sender'));
      return;
    }
    // While sharing cameraOnState is false, so this also makes
    // setCameraEnabled(false) during a share a no-op.
    if (enabled === this.cameraOnState) return; // already there
    if (this.screenSharingState) {
      // Mutually exclusive — stop the share (clears the sender, notifies the
      // peer/UI), then fall through to the normal camera acquisition.
      await this.stopScreenShare();
      if (!this.ensureActive(epoch)) return;
    }

    if (!enabled) {
      try {
        // Restore the placeholder (not null) so the video m-line keeps its
        // signaled a=ssrc for the next replaceTrack (iOS/ssrc — see
        // addLocalTracks); null when no placeholder factory, as before.
        await sender.replaceTrack(this.placeholderVideoTrack);
      } catch (error) {
        this.reportDeviceSwitchError(error);
        return;
      }
      if (!this.ensureActive(epoch)) return;
      this.removeLocalVideoTracks();
      this.cameraOnState = false;
      this.sendLocalMutedState();
      this.callbacks.onLocalVideoTrackChanged?.(null);
      return;
    }

    let newStream: MediaStream;
    try {
      newStream = await this.factories.getUserMedia({
        audio: false,
        video: this.videoConstraintsFor(this.selectedVideoInputDeviceId),
      });
    } catch (error) {
      this.reportDeviceSwitchError(error);
      return;
    }
    if (!this.ensureActive(epoch)) {
      this.stopStream(newStream); // call ended while getUserMedia was in flight
      return;
    }
    const newTrack = newStream.getVideoTracks()[0];
    if (newTrack == null) {
      this.stopStream(newStream);
      this.reportDeviceSwitchError(new Error('setCameraEnabled: the new stream had no video track'));
      return;
    }
    try {
      await sender.replaceTrack(newTrack);
    } catch (error) {
      this.stopStream(newStream);
      this.reportDeviceSwitchError(error);
      return;
    }
    if (!this.ensureActive(epoch)) {
      this.stopStream(newStream);
      return;
    }
    this.swapLocalVideoTrack(newTrack);
    this.cameraOnState = true;
    this.sendLocalMutedState();
    this.callbacks.onLocalVideoTrackChanged?.(newTrack);
  }

  /**
   * Start sharing the screen: `getDisplayMedia()` + `replaceTrack` onto the
   * existing video sender, so the peer sees an ordinary video-track change,
   * not a screen-share protocol. The share takes the single video sender, so
   * the camera turns OFF for real (state + UI). Failures report
   * `onScreenShareError` and never tear the call down. The browser's own
   * "Stop sharing" affordance ends the track out-of-band; its `ended`
   * listener below treats that like an explicit {@link stopScreenShare}.
   */
  async startScreenShare(): Promise<void> {
    const epoch = this.epoch;
    if (epoch == null || this.machine.isTerminal) return; // ended: silent no-op
    if (this.screenSharingState) return; // already sharing: no-op
    const sender = this.videoSender;
    if (sender == null) {
      this.reportScreenShareError(
        new Error('startScreenShare: this call has no outgoing video to replace')
      );
      return;
    }
    const getDisplayMedia = this.factories.getDisplayMedia;
    if (getDisplayMedia == null) {
      this.reportScreenShareError(new Error('startScreenShare: screen capture is not available'));
      return;
    }

    let displayStream: MediaStream;
    try {
      displayStream = await getDisplayMedia({ video: true, audio: false });
    } catch (error) {
      // e.g. the user dismissed the browser's share-source picker — not a
      // call-ending error, just "screen share didn't start".
      this.reportScreenShareError(error);
      return;
    }
    if (!this.ensureActive(epoch)) {
      this.stopStream(displayStream);
      return;
    }
    const screenTrack = displayStream.getVideoTracks()[0];
    if (screenTrack == null) {
      this.stopStream(displayStream);
      this.reportScreenShareError(new Error('startScreenShare: capture had no video track'));
      return;
    }

    try {
      await sender.replaceTrack(screenTrack);
    } catch (error) {
      this.stopStream(displayStream);
      this.reportScreenShareError(error);
      return;
    }
    if (!this.ensureActive(epoch)) {
      this.stopStream(displayStream);
      return;
    }

    // The browser's native "Stop sharing" UI (or the OS revoking capture)
    // ends this track out-of-band — treat it identically to the user
    // pressing our own toggle-off control.
    screenTrack.addEventListener('ended', () => {
      void this.stopScreenShare();
    });

    this.swapLocalVideoTrack(screenTrack); // stops the camera track if live
    this.screenShareStream = displayStream;
    this.screenSharingState = true;
    this.cameraOnState = false; // mutually exclusive: the share owns the sender
    this.sendLocalMutedState();
    this.callbacks.onScreenShareChanged?.(true);
    this.callbacks.onLocalVideoTrackChanged?.(screenTrack);
  }

  /**
   * Stop sharing and clear the outgoing video — never auto-restores the
   * camera (camera and screen share are mutually exclusive, so the camera is
   * off by now; turning it back on is an explicit {@link setCameraEnabled}).
   * The capture is stopped unconditionally FIRST: screen sharing is a
   * stronger privacy commitment than a black video tile.
   */
  async stopScreenShare(): Promise<void> {
    if (!this.screenSharingState) return;
    const epoch = this.epoch;
    const sender = this.videoSender;
    this.releaseScreenShareStream(); // stop the capture unconditionally
    this.screenSharingState = false;
    this.sendLocalMutedState();
    this.callbacks.onScreenShareChanged?.(false);
    if (epoch == null || this.machine.isTerminal || sender == null) return;

    try {
      // Restore the placeholder so the SSRC stays signaled (iOS/ssrc — see
      // addLocalTracks); null when no placeholder factory, as before.
      await sender.replaceTrack(this.placeholderVideoTrack);
    } catch (error) {
      this.reportScreenShareError(error);
      return;
    }
    if (!this.ensureActive(epoch)) return;
    this.removeLocalVideoTracks();
    this.callbacks.onLocalVideoTrackChanged?.(null);
  }

  /** Flip {@link screenSharing}. */
  async toggleScreenShare(): Promise<void> {
    if (this.screenSharingState) {
      await this.stopScreenShare();
    } else {
      await this.startScreenShare();
    }
  }

  private releaseScreenShareStream(): void {
    this.stopStream(this.screenShareStream);
    this.screenShareStream = null;
  }

  /** Swap the live outgoing video track within `localStream` so it always
   * reflects whichever source (camera or screen) is actually being sent. */
  private swapLocalVideoTrack(newTrack: MediaStreamTrack): void {
    const stream = this.localStream;
    if (stream == null) return;
    for (const oldTrack of stream.getVideoTracks()) {
      stream.removeTrack(oldTrack);
      oldTrack.stop();
    }
    stream.addTrack(newTrack);
  }

  /** Stop and drop every outgoing video track from `localStream`; the sender
   * stays live but trackless so it can carry a track again later. */
  private removeLocalVideoTracks(): void {
    const stream = this.localStream;
    if (stream == null) return;
    for (const oldTrack of stream.getVideoTracks()) {
      stream.removeTrack(oldTrack);
      oldTrack.stop();
    }
  }

  private reportScreenShareError(error: unknown): void {
    const normalized = error instanceof Error ? error : new Error(String(error));
    this.callbacks.onScreenShareError?.(normalized);
  }

  /** Fire {@link AudioCallCallbacks.onLocalTrackChanged}/{@link
   * AudioCallCallbacks.onLocalVideoTrackChanged} for `stream`'s first
   * audio/video track, if any (a fresh initial `getUserMedia` stream has at
   * most one of each). */
  private notifyLocalTrackChanged(stream: MediaStream): void {
    const track = stream.getAudioTracks()[0];
    if (track != null) this.callbacks.onLocalTrackChanged?.(track);
    const videoTrack = stream.getVideoTracks()[0];
    if (videoTrack != null) this.callbacks.onLocalVideoTrackChanged?.(videoTrack);
  }

  /**
   * `addTrack` the mic onto `pc` and ALWAYS establish an outgoing video
   * sender ({@link videoSender}), matching calls-webapp's both-m-lines-always
   * contract. Called by `placeCall` (offerer) and `accept` (answerer, AFTER
   * `setRemoteDescription`). The interop subtlety is how the video sender is
   * obtained:
   *  - camera track present: `addTrack` it (either side).
   *  - audio-started offerer: `addTransceiver('video', sendrecv)`.
   *  - audio-started answerer: an answer must NOT add an m-line the offer
   *    didn't have — adopt the trackless sender `setRemoteDescription`
   *    created for the peer's video m-line instead (the mic was addTrack'd
   *    first, so the sole trackless sender is the video one). A peer that
   *    offered no video leaves `videoSender` null; camera/screen-share then
   *    degrade gracefully.
   */
  private async addLocalTracks(
    pc: PeerConnectionLike,
    stream: MediaStream,
    isOfferer: boolean
  ): Promise<void> {
    for (const track of stream.getAudioTracks()) {
      pc.addTrack(track, stream);
    }
    const videoTrack = stream.getVideoTracks()[0] ?? null;
    if (videoTrack != null) {
      pc.addTrack(videoTrack, stream);
      this.videoSender =
        pc.getSenders().find((s) => s.track != null && s.track.kind === 'video') ?? null;
      this.cameraOnState = this.videoSender != null;
      return;
    }
    // iOS/ssrc: attach a disabled black placeholder to the always-negotiated
    // video sender so the SDP carries a real a=ssrc; the later camera/screen
    // replaceTrack then sends on a SIGNALED SSRC (WebKit can't demux unsignaled
    // ones — audio-started calls otherwise render black on iOS). Null factory =
    // keep the old trackless behavior.
    const placeholderTrack = this.getPlaceholderTrack();
    // Audio-started: reuse the video sender the remote offer already created
    // (answerer — the sole trackless sender now that the mic is bound), or
    // negotiate our own video m-line (offerer).
    //
    // Interop (msid): the trackless video m-line MUST be associated with the
    // local stream (a=msid:<stream> …, not a=msid:- …), or the peer's ontrack
    // fires with empty `event.streams` and stream-based consumers (calls-webapp,
    // our own trackListener) never see the later replaceTrack'd camera/screen —
    // RTP flows but the peer renders black/avatar (confirmed via
    // scripts/repro-calls-video.mjs).
    const existingTrackless = pc.getSenders().find((s) => s.track == null) ?? null;
    if (existingTrackless != null) {
      this.videoSender = existingTrackless;
      existingTrackless.setStreams?.(stream);
      // Interop: setRemoteDescription's transceiver defaults to `recvonly`;
      // left that way, a later replaceTrack(camera/screen) sends NO media
      // (confirmed live). Promote to sendrecv BEFORE creating the answer.
      this.promoteVideoTransceiverToSendrecv(pc, existingTrackless);
      // Attach the placeholder BEFORE createAnswer so the answer announces the
      // a=ssrc (see rationale above).
      if (placeholderTrack != null) await existingTrackless.replaceTrack(placeholderTrack);
    } else if (isOfferer) {
      if (placeholderTrack != null) {
        // addTrack(placeholder, stream) gives msid + ssrc and stands in for the
        // trackless addTransceiver below.
        this.videoSender = pc.addTrack(placeholderTrack, stream) as RtpSenderLike;
      } else {
        this.videoSender = pc.addTransceiver('video', {
          direction: 'sendrecv',
          streams: [stream],
        }).sender;
      }
    } else {
      // Answerer whose peer offered no video m-line: nothing to hijack.
      this.videoSender = null;
    }
    this.cameraOnState = false; // placeholder ≠ camera
  }

  /** Lazily create the disabled placeholder video track from the injected
   * factory; `null` if no factory was provided (see {@link
   * AudioCallMediaFactories.createPlaceholderVideoTrack}). */
  private getPlaceholderTrack(): MediaStreamTrack | null {
    if (this.placeholderVideoTrack != null) return this.placeholderVideoTrack;
    const factory = this.factories.createPlaceholderVideoTrack;
    if (factory == null) return null;
    this.placeholderVideoTrack = factory();
    return this.placeholderVideoTrack;
  }

  /** Set the video transceiver that owns `videoSender` to `sendrecv` (see
   * addLocalTracks). Matched by sender identity first, then by video receiver. */
  private promoteVideoTransceiverToSendrecv(
    pc: PeerConnectionLike,
    videoSender: RtpSenderLike
  ): void {
    const transceivers = pc.getTransceivers();
    const transceiver =
      transceivers.find((t) => t.sender === videoSender) ??
      transceivers.find((t) => t.receiver?.track?.kind === 'video');
    if (transceiver != null) {
      transceiver.direction = 'sendrecv';
    }
  }

  private reportDeviceSwitchError(error: unknown): void {
    const normalized = error instanceof Error ? error : new Error(String(error));
    this.callbacks.onDeviceSwitchError?.(normalized);
  }

  // ── Teardown ──────────────────────────────────────────────────────────────

  /**
   * End the call and release everything. Idempotent — safe from a hang-up
   * button, a `CallEnded` event, and internal failure paths, in any order.
   * Moving to `ended` first invalidates the epoch, so any in-flight async
   * orchestration bails at its next checkpoint.
   */
  end(): void {
    if (this.machine.isTerminal) return;
    this.machine.transition('ended');
    this.epoch = null;
    // Settle any in-flight `await gathered` so placeCall()/accept() unblocks and
    // releases the closed pc it closes over (see gatherAbort).
    this.gatherAbort?.abort();
    this.gatherAbort = null;
    this.releaseScreenShareStream();
    this.screenSharingState = false;
    this.cameraOnState = false;
    this.videoSender = null;
    this.teardown();
  }

  /** Alias for {@link end}, for call sites that read better as "hang up". */
  hangup(): void {
    this.end();
  }

  // ── Internals ───────────────────────────────────────────────────────────────

  private mediaConstraints(): MediaStreamConstraints {
    return {
      audio: this.audioConstraintsFor(this.selectedAudioInputDeviceId),
      video: this.wantsVideo ? this.videoConstraintsFor(this.selectedVideoInputDeviceId) : false,
    };
  }

  /**
   * Acquire the initial mic (+ camera when {@link wantsVideo}) stream. A
   * video-started call with no usable camera must NOT fail the whole call
   * (it can still receive video and screen-share), so a failed audio+video
   * acquisition retries audio-only: success → camera was the problem,
   * degrade and defer the non-fatal error ({@link flushCameraStartError});
   * failure → mic/permission problem, rethrow to fail the call via `onError`.
   */
  private async acquireInitialLocalStream(): Promise<MediaStream> {
    const constraints = this.mediaConstraints();
    if (constraints.video === false || constraints.video == null) {
      return this.factories.getUserMedia(constraints);
    }
    try {
      return await this.factories.getUserMedia(constraints);
    } catch (cameraError) {
      // May be the camera OR the mic. An audio-only retry disambiguates: if it
      // succeeds the camera was at fault (degrade), otherwise the throw here
      // fails the call (mic/permission problem).
      const audioOnly = await this.factories.getUserMedia({
        audio: this.audioConstraintsFor(this.selectedAudioInputDeviceId),
        video: false,
      });
      this.pendingCameraStartError =
        cameraError instanceof Error ? cameraError : new Error(String(cameraError));
      return audioOnly;
    }
  }

  /** Surface a deferred non-fatal camera-start failure once the call is set
   * up and still active — as `onDeviceSwitchError`, never the call-ending
   * `onError`. */
  private flushCameraStartError(epoch: object): void {
    const error = this.pendingCameraStartError;
    this.pendingCameraStartError = null;
    if (error != null && this.ensureActive(epoch)) {
      this.reportDeviceSwitchError(error);
    }
  }

  /** Merge a preferred `deviceId` (if any) into the base audio constraints. */
  private audioConstraintsFor(deviceId: string | null): MediaTrackConstraints | boolean {
    if (deviceId == null) return this.audioConstraints;
    const base = typeof this.audioConstraints === 'object' ? this.audioConstraints : {};
    return { ...base, deviceId: { exact: deviceId } };
  }

  /** Merge a preferred `deviceId` (if any) into the base video constraints —
   * mirrors {@link audioConstraintsFor}. */
  private videoConstraintsFor(deviceId: string | null): MediaTrackConstraints | boolean {
    if (deviceId == null) return this.videoConstraints;
    const base = typeof this.videoConstraints === 'object' ? this.videoConstraints : {};
    return { ...base, deviceId: { exact: deviceId } };
  }

  private beginEpoch(): object {
    const epoch = {};
    this.epoch = epoch;
    this.gatherAbort = new AbortController();
    return epoch;
  }

  /** Merge the teardown abort signal into the caller-supplied gather options. */
  private gatherOptionsWithSignal(): GatherOptions {
    return { ...this.gatherOptions, signal: this.gatherAbort?.signal };
  }

  /** True while `epoch` is still the live call and the machine has not ended. */
  private ensureActive(epoch: object): boolean {
    return this.epoch === epoch && !this.machine.isTerminal;
  }

  private createPeerConnection(epoch: object): PeerConnectionLike {
    const configuration: RTCConfiguration = {
      ...CALLS_WEBAPP_RTC_CONFIGURATION,
      iceServers: this.iceServers,
    };
    const pc = this.factories.createPeerConnection(configuration);
    this.pc = pc;

    // The calls-webapp contract's negotiated data channels (see constants.ts).
    // Creating them (before the offer/answer) is also what puts the
    // m=application section into our SDP, matching what real peers produce.
    // ponytail: iceTrickling is create-and-ignore — post-connect ICE candidate
    // promotion over it is out of scope; the channel only has to exist.
    this.iceTricklingChannel = pc.createDataChannel(
      ICE_TRICKLING_DATA_CHANNEL.label,
      ICE_TRICKLING_DATA_CHANNEL.options
    );
    const mutedChannel = pc.createDataChannel(
      MUTED_STATE_DATA_CHANNEL.label,
      MUTED_STATE_DATA_CHANNEL.options
    );
    this.mutedStateChannel = mutedChannel;
    const mutedOpenListener = () => {
      if (!this.ensureActive(epoch)) return;
      this.sendLocalMutedState();
    };
    const mutedMessageListener = (event: { data: unknown }) => {
      if (!this.ensureActive(epoch)) return;
      this.handleRemoteMutedState(event.data);
    };
    mutedChannel.addEventListener('open', mutedOpenListener);
    mutedChannel.addEventListener('message', mutedMessageListener);
    this.mutedStateOpenListener = mutedOpenListener;
    this.mutedStateMessageListener = mutedMessageListener;

    const connectionListener: ConnectionListener = () => {
      if (!this.ensureActive(epoch)) return;
      const cs = pc.connectionState;
      if (cs === 'connected') {
        this.machine.transition('connected');
        this.logVideoNegotiationDiagnostics(pc);
      } else if (cs === 'failed' || cs === 'closed') {
        this.end();
      }
      // 'disconnected' is transient (may recover); 'new'/'connecting' ignored.
    };
    const trackListener: TrackListener = (event) => {
      if (!this.ensureActive(epoch)) return;
      let stream = event.streams[0];
      if (stream == null) {
        // The peer's m-line had no stream association (a=msid:- …, e.g. a
        // trackless-transceiver offer) — fold the track into our remote
        // stream so stream-based consumers still see it.
        stream = this.remoteStream ?? new MediaStream();
        if (!stream.getTracks().includes(event.track)) stream.addTrack(event.track);
      }
      this.remoteStream = stream;
      this.callbacks.onRemoteStream?.(stream);
      this.watchRemoteVideoTrack(stream);
    };
    pc.addEventListener('connectionstatechange', connectionListener);
    pc.addEventListener('track', trackListener);
    this.pcConnectionListener = connectionListener;
    this.pcTrackListener = trackListener;
    return pc;
  }

  /**
   * Best-effort push of the local `{ audioEnabled, videoEnabled }` state over
   * the `mutedState` channel — called on channel open and after every
   * successful mute/camera/screen-share flip. Silently a no-op while the
   * channel is absent or not yet open (the open handler re-sends).
   */
  private sendLocalMutedState(): void {
    const channel = this.mutedStateChannel;
    if (channel == null || channel.readyState !== 'open') return;
    try {
      channel.send(
        JSON.stringify({
          audioEnabled: !this.mutedState,
          videoEnabled: this.cameraOnState || this.screenSharingState,
        })
      );
    } catch {
      // best-effort — a failed status send never affects the call
    }
  }

  /** Consume a peer `mutedState` message. Malformed/non-object payloads are
   * ignored; the first valid one makes messages authoritative over the
   * remote-video-track fallback (see {@link watchRemoteVideoTrack}). */
  private handleRemoteMutedState(data: unknown): void {
    if (typeof data !== 'string') return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      return;
    }
    if (typeof parsed !== 'object' || parsed == null) return;
    const { audioEnabled, videoEnabled } = parsed as {
      audioEnabled?: unknown;
      videoEnabled?: unknown;
    };
    this.remoteMutedStateReceived = true;
    this.emitRemoteVideoActive(Boolean(videoEnabled));
    this.emitRemoteAudioMuted(!audioEnabled);
  }

  private emitRemoteVideoActive(active: boolean): void {
    if (this.remoteVideoActive === active) return;
    this.remoteVideoActive = active;
    this.callbacks.onRemoteVideoActiveChanged?.(active);
  }

  private emitRemoteAudioMuted(muted: boolean): void {
    if (this.remoteAudioMuted === muted) return;
    this.remoteAudioMuted = muted;
    this.callbacks.onRemoteAudioMutedChanged?.(muted);
  }

  /**
   * Watch the remote stream's video track (mute/unmute/ended) as the
   * PRE-MESSAGE fallback for {@link AudioCallCallbacks.onRemoteVideoActiveChanged}
   * — unreliable on its own (a sendrecv m-line with no RTP can leave
   * `muted === false` on a black frame), so it is ignored once the first
   * valid `mutedState` message arrives.
   */
  private watchRemoteVideoTrack(stream: MediaStream): void {
    const track = stream.getVideoTracks()[0] ?? null;
    if (track !== this.remoteVideoTrack) {
      this.remoteVideoTrackCleanup?.();
      this.remoteVideoTrackCleanup = null;
      this.remoteVideoTrack = track;
      if (track != null) {
        const update = () => {
          if (this.remoteMutedStateReceived) return;
          this.emitRemoteVideoActive(!track.muted);
        };
        const onEnded = () => {
          if (this.remoteMutedStateReceived) return;
          this.emitRemoteVideoActive(false);
        };
        track.addEventListener('mute', update);
        track.addEventListener('unmute', update);
        track.addEventListener('ended', onEnded);
        this.remoteVideoTrackCleanup = () => {
          track.removeEventListener('mute', update);
          track.removeEventListener('unmute', update);
          track.removeEventListener('ended', onEnded);
        };
      }
    }
    if (!this.remoteMutedStateReceived) {
      this.emitRemoteVideoActive(track != null && !track.muted);
    }
  }

  /**
   * Once per call, after `connected`, warn when outgoing camera/screen-share
   * can never reach the peer (no video m-line, or no send direction granted).
   * Log-only; renegotiation is not in the wire contract.
   */
  private logVideoNegotiationDiagnostics(pc: PeerConnectionLike): void {
    if (this.videoDiagnosticsLogged) return;
    this.videoDiagnosticsLogged = true;
    if (this.videoSender == null) {
      console.warn(
        'calls: peer negotiated no video m-line; outgoing camera/screenshare will not flow'
      );
      return;
    }
    const sender = this.videoSender;
    const transceiver = pc.getTransceivers().find((t) => t.sender === sender);
    const dir = transceiver?.currentDirection;
    if (dir === 'recvonly' || dir === 'inactive') {
      console.warn(
        `calls: peer's answer granted no send direction for video (currentDirection "${dir}"); outgoing camera/screenshare will not flow`
      );
    }
  }

  private maybePromoteConnected(epoch: object, pc: PeerConnectionLike): void {
    if (this.ensureActive(epoch) && pc.connectionState === 'connected') {
      this.machine.transition('connected');
      this.logVideoNegotiationDiagnostics(pc);
    }
  }

  private fail(epoch: object, error: unknown): void {
    // Only the call that owns this epoch may report/teardown; a stale failure
    // (the call was already torn down) is swallowed.
    if (this.epoch !== epoch) return;
    const normalized = error instanceof Error ? error : new Error(String(error));
    this.end();
    this.callbacks.onError?.(normalized);
  }

  private stopStream(stream: MediaStream | null): void {
    if (stream == null) return;
    for (const track of stream.getTracks()) {
      try {
        track.stop();
      } catch {
        // best-effort
      }
    }
  }

  private teardown(): void {
    this.remoteVideoTrackCleanup?.();
    this.remoteVideoTrackCleanup = null;
    this.remoteVideoTrack = null;
    const mutedChannel = this.mutedStateChannel;
    if (mutedChannel != null) {
      if (this.mutedStateOpenListener != null) {
        mutedChannel.removeEventListener('open', this.mutedStateOpenListener);
      }
      if (this.mutedStateMessageListener != null) {
        mutedChannel.removeEventListener('message', this.mutedStateMessageListener);
      }
    }
    this.mutedStateChannel = null;
    this.mutedStateOpenListener = null;
    this.mutedStateMessageListener = null;
    this.iceTricklingChannel = null;

    const pc = this.pc;
    this.pc = null;
    if (pc != null) {
      // Drop listeners BEFORE close() so pc.close()'s own
      // connectionstatechange('closed') cannot re-enter end().
      if (this.pcConnectionListener != null) {
        pc.removeEventListener('connectionstatechange', this.pcConnectionListener);
      }
      if (this.pcTrackListener != null) {
        pc.removeEventListener('track', this.pcTrackListener);
      }
      try {
        pc.close();
      } catch {
        // best-effort
      }
    }
    this.pcConnectionListener = null;
    this.pcTrackListener = null;

    this.stopStream(this.localStream);
    this.localStream = null;
    this.remoteStream = null;
    this.pendingRemoteOffer = null;

    // The placeholder is never stop()ed on a replaceTrack swap (it must be
    // reusable); release it only here. Guard `stop` for fakes.
    try {
      this.placeholderVideoTrack?.stop?.();
    } catch {
      // best-effort
    }
    this.placeholderVideoTrack = null;
  }
}
