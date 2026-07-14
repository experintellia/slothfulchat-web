/**
 * The WebRTC call engine — audio-first (M1 happy path — outgoing + incoming),
 * with optional camera video + screen share (M3). The class name predates M3
 * and is kept for a stable, well-referenced identifier rather than churning
 * every import across the package for a rename; `hasVideo: false` (the
 * default) reproduces the original audio-only M1/M2 behavior exactly.
 *
 * Framework-agnostic, pure TS: it uses the ambient WebRTC *types*
 * (`RTCPeerConnection`, `MediaStream`, …) but IMPORTS no DOM/React and never
 * reaches for `navigator`/`window`/`new RTCPeerConnection` directly. Everything
 * that touches the platform — `getUserMedia`, `RTCPeerConnection` construction —
 * is injected via {@link AudioCallMediaFactories}, and the ICE servers are fed
 * in from outside (the runtime pulls them from `rpc.iceServers`). This is what
 * keeps the engine unit-testable under Node's type-stripping test runner with a
 * fake peer connection, and location-agnostic (overlay or popup) per
 * docs/calls.md.
 *
 * ── LIFECYCLE (one engine instance == one call) ───────────────────────────────
 *
 *   Outgoing:  new AudioCallEngine(...) → placeCall()
 *                idle → ringing   [acquire mic, gather ICE, create offer]
 *                                 → callbacks.onLocalOffer(sdp)  (runtime places it)
 *              provideAnswer(sdp) ringing → connecting  [setRemoteDescription]
 *              pc 'connected'     connecting → connected
 *              hangup()/CallEnded → ended  [teardown]
 *
 *   Incoming:  new AudioCallEngine(...) → receiveCall(offerSdp)
 *                idle → ringing   [store offer; mic NOT touched yet]
 *              accept()           ringing → connecting  [acquire mic, gather ICE,
 *                                 create answer] → callbacks.onLocalAnswer(sdp)
 *              pc 'connected'     connecting → connected
 *              hangup()/CallEnded → ended  [teardown]
 *
 * After `ended` the instance is spent; create a new one for the next call.
 *
 * ── DEVICE HOT-SWITCHING (M2) ─────────────────────────────────────────────────
 *
 * {@link AudioCallEngine.switchMicrophone} lets the caller swap the outgoing
 * mic mid-call: it acquires a fresh `getUserMedia` stream constrained to the
 * requested `deviceId`, then calls `RTCRtpSender.replaceTrack` on the existing
 * audio sender — the peer's SDP/m-line is untouched, so this needs NO
 * renegotiation (no new offer/answer round-trip over DeltaChat messaging,
 * which per docs/calls.md is the whole point: renegotiating would mean
 * another slow store-and-forward message exchange mid-call). It follows the
 * same epoch-guard discipline as placeCall/accept, but a failure here does
 * NOT end the call — the previous track keeps flowing untouched; only
 * `callbacks.onDeviceSwitchError` fires, so a device going away mid-call
 * degrades to "still on the old mic" rather than dropping the call.
 * `callbacks.onLocalTrackChanged` fires on both the initial mic acquisition
 * AND every successful switch, so a consumer that taps the local track (e.g.
 * the M2 speaking-ring level meter) has one precise seam to re-tap on rather
 * than assuming `localMediaStream`'s first audio track never changes identity.
 *
 * ── VIDEO + SCREEN SHARE (M3) ──────────────────────────────────────────────────
 *
 * `hasVideo` (constructor option) makes `placeCall`/`accept` also acquire a
 * camera track alongside the mic and `addTrack` it onto the peer connection —
 * an ordinary second m-line, nothing interop-special; a `calls-webapp` peer
 * that itself sent `has_video: true` expects (and, symmetrically, sends) one.
 * The resulting `RTCRtpSender` for that track is remembered as
 * {@link videoSender} — the seam {@link startScreenShare}/{@link
 * stopScreenShare} hang off, exactly like {@link switchMicrophone} hangs off
 * the audio sender.
 *
 * {@link startScreenShare} takes over that SAME sender via
 * `getDisplayMedia()` + `RTCRtpSender.replaceTrack` — no renegotiation, no new
 * m-line, so the remote peer (any interop target) sees an ordinary "the video
 * track changed" moment identical to a camera switch, not a screen-share
 * *protocol* the far end would need to understand. {@link stopScreenShare}
 * reverses it the same way: re-acquire the camera, `replaceTrack` it back.
 * Both directions follow the epoch-guard / "failure never ends the call"
 * discipline `switchMicrophone` established — see `onScreenShareError`.
 *
 * ── RACE FREEDOM ──────────────────────────────────────────────────────────────
 *
 * Teardown ({@link AudioCallEngine.end}) can land at ANY await boundary of the
 * async offer/answer orchestration. Two mechanisms make that safe:
 *   1. The state machine (see call-state.ts): once `ended`, every further
 *      transition is a silent no-op, so a late gather-promise or
 *      `connectionstatechange` cannot resurrect the call.
 *   2. An epoch token captured when the call begins. After every `await`, the
 *      orchestration checks {@link AudioCallEngine.ensureActive}; if the epoch
 *      was invalidated (by `end()`), it bails — and if the just-resolved value
 *      is an as-yet-unowned resource (a `getUserMedia` stream that resolved
 *      *after* hang up), it is stopped on the spot so nothing leaks.
 */

import { CALLS_WEBAPP_RTC_CONFIGURATION } from './constants.ts';
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

/**
 * The subset of `RTCRtpSender` {@link AudioCallEngine.switchMicrophone} needs.
 * A real `RTCRtpSender` (as returned by `RTCPeerConnection.getSenders()`) is
 * structurally assignable to this, and so is a test fake.
 */
export interface RtpSenderLike {
  readonly track: MediaStreamTrack | null;
  replaceTrack(track: MediaStreamTrack | null): Promise<void>;
}

/**
 * The subset of `RTCPeerConnection` the engine drives. A real
 * `RTCPeerConnection` is structurally assignable to this, and so is a test
 * fake. Extends {@link GatheringPeerConnection} so the same object satisfies the
 * ICE-gathering helper.
 */
export interface PeerConnectionLike extends GatheringPeerConnection {
  readonly connectionState: RTCPeerConnectionState;
  readonly localDescription: { readonly type: string; readonly sdp: string } | null;
  createOffer(): Promise<RTCSessionDescriptionInit>;
  createAnswer(): Promise<RTCSessionDescriptionInit>;
  setLocalDescription(description?: RTCLocalSessionDescriptionInit): Promise<void>;
  setRemoteDescription(description: RTCSessionDescriptionInit): Promise<void>;
  addTrack(track: MediaStreamTrack, ...streams: MediaStream[]): unknown;
  getSenders(): RtpSenderLike[];
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
    listener: (event: { readonly streams: ReadonlyArray<MediaStream> }) => void
  ): void;
  removeEventListener(
    type: 'icecandidate',
    listener: (event: { candidate: RTCIceCandidate | null }) => void
  ): void;
  removeEventListener(type: 'icegatheringstatechange', listener: () => void): void;
  removeEventListener(type: 'connectionstatechange', listener: () => void): void;
  removeEventListener(
    type: 'track',
    listener: (event: { readonly streams: ReadonlyArray<MediaStream> }) => void
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
}

export interface AudioCallCallbacks {
  /** Outgoing: the local OFFER (raw SDP) is ready to hand to `rpc.placeOutgoingCall`. */
  onLocalOffer?(sdp: string): void;
  /** Incoming: the local ANSWER (raw SDP) is ready to hand to `rpc.acceptIncomingCall`. */
  onLocalAnswer?(sdp: string): void;
  /** The remote audio stream became available (attach to an `<audio>` element in the UI). */
  onRemoteStream?(stream: MediaStream): void;
  /**
   * The outgoing local audio track was replaced — either the very first mic
   * acquisition (placeCall/accept) or a successful {@link
   * AudioCallEngine.switchMicrophone}. Consumers that tap the local track
   * (e.g. the M2 speaking-ring level meter, which hangs a Web-Audio analyser
   * off whatever track it first saw) must re-tap on this event rather than
   * assuming `localMediaStream`'s first audio track never changes identity —
   * `switchMicrophone` mutates the stream in place via
   * `removeTrack`/`addTrack`, so the *stream* reference is stable but the
   * *track* underneath it is not.
   */
  onLocalTrackChanged?(track: MediaStreamTrack): void;
  /**
   * The outgoing local VIDEO track was (re)established — the initial camera
   * acquisition (when `hasVideo`), a successful {@link
   * AudioCallEngine.switchCamera}, or a {@link AudioCallEngine.startScreenShare}/
   * {@link AudioCallEngine.stopScreenShare} swap (M3). A consumer rendering a
   * local video preview `<video>` element should re-attach `srcObject` on this
   * event rather than assuming `localMediaStream`'s video track never changes
   * identity — same rationale as {@link onLocalTrackChanged} for audio.
   */
  onLocalVideoTrackChanged?(track: MediaStreamTrack): void;
  /** Mirror of the state machine, for convenience (same as `subscribe`). */
  onStateChange?: CallStateListener;
  /** A fatal error tore the call down; the engine is already `ended`. */
  onError?(error: Error): void;
  /**
   * {@link AudioCallEngine.switchMicrophone} failed (e.g. the device was
   * unplugged, or permission was revoked). The call is NOT torn down — the
   * previous mic track keeps flowing untouched; the UI should surface this as
   * a toast/inline error next to the device picker, not as a call-ending
   * error (contrast {@link onError}).
   */
  onDeviceSwitchError?(error: Error): void;
  /**
   * {@link AudioCallEngine.screenSharing} flipped, on both a successful
   * {@link AudioCallEngine.startScreenShare} and a successful {@link
   * AudioCallEngine.stopScreenShare} (including the browser's own "Stop
   * sharing" affordance ending the capture out-of-band — see {@link
   * startScreenShare}'s doc). Drives the UI's toggle-button state.
   */
  onScreenShareChanged?(sharing: boolean): void;
  /**
   * `startScreenShare`/`stopScreenShare` failed (capture picker cancelled, no
   * outgoing video to hijack, camera didn't come back, …). The call is NOT
   * torn down (mirrors `onDeviceSwitchError`'s contract exactly) — surface
   * this as an inline note next to the screen-share control, not as the
   * call-ending `onError`.
   */
  onScreenShareError?(error: Error): void;
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
  /**
   * Preferred microphone `deviceId` (from {@link CallDeviceInfo}), applied to
   * the very first `getUserMedia` call (placeCall/accept) as `{ deviceId: {
   * exact } }`. Mid-call changes go through {@link AudioCallEngine.switchMicrophone}
   * instead — this only seeds the initial acquisition.
   */
  audioInputDeviceId?: string;
  /**
   * Whether this call carries video (M3, docs/calls.md: "Add camera video
   * (has_video)"). When `true`, `placeCall`/`accept` also acquire a camera
   * track and `addTrack` it alongside the mic — this is what {@link
   * AudioCallEngine.startScreenShare} later hijacks via `replaceTrack`.
   * Outgoing: the caller's choice (also what the runtime passes as `has_video`
   * to `rpc.placeOutgoingCall`). Incoming: should mirror the remote offer's
   * own `has_video` — the peer that sent a video m-line expects one back
   * (ordinary WebRTC offer/answer symmetry), and it is also the only way
   * {@link startScreenShare} has anything to replace. Default `false`
   * (audio-only, M1/M2 behavior unchanged).
   */
  hasVideo?: boolean;
  /** Video track constraints (when {@link hasVideo}). Default: `true` (default camera). */
  videoConstraints?: MediaTrackConstraints | boolean;
  /**
   * Preferred camera `deviceId`, applied to the initial `getUserMedia` call
   * the same way {@link audioInputDeviceId} seeds the mic. Mid-call changes go
   * through {@link AudioCallEngine.switchCamera}.
   */
  videoInputDeviceId?: string;
}

type ConnectionListener = () => void;
type TrackListener = (event: { readonly streams: ReadonlyArray<MediaStream> }) => void;

export class AudioCallEngine {
  private readonly machine = new CallStateMachine();
  private readonly factories: AudioCallMediaFactories;
  private readonly iceServers: RTCIceServer[];
  private readonly callbacks: AudioCallCallbacks;
  private readonly gather: (pc: GatheringPeerConnection, options?: GatherOptions) => Promise<void>;
  private readonly gatherOptions: GatherOptions | undefined;
  private readonly audioConstraints: MediaTrackConstraints | boolean;
  /** Current mic selection; `null` until an explicit `switchMicrophone` or an
   * `audioInputDeviceId` constructor option. Read by {@link mediaConstraints}
   * and exposed via {@link audioInputDeviceId} for the UI to pre-select. */
  private selectedAudioInputDeviceId: string | null = null;
  /** Whether this call carries video (M3). See {@link AudioCallOptions.hasVideo}. */
  private readonly wantsVideo: boolean;
  private readonly videoConstraints: MediaTrackConstraints | boolean;
  /** Current camera selection; mirrors {@link selectedAudioInputDeviceId} but
   * for video (constructor's `videoInputDeviceId` or a successful {@link
   * switchCamera}). Also what {@link stopScreenShare} reacquires when
   * restoring the camera. */
  private selectedVideoInputDeviceId: string | null = null;

  private direction: CallDirection | null = null;
  private pc: PeerConnectionLike | null = null;
  private localStream: MediaStream | null = null;
  private remoteStream: MediaStream | null = null;
  /** The outgoing video `RTCRtpSender`, once a video track has been
   * `addTrack`'d (i.e. `hasVideo` was set) — `null` for an audio-only call.
   * {@link startScreenShare}/{@link stopScreenShare}/{@link switchCamera}
   * `replaceTrack` on this SAME sender; no renegotiation, per class doc. */
  private videoSender: RtpSenderLike | null = null;
  /** The live `getDisplayMedia()` stream while screen-sharing, so {@link
   * stopScreenShare}/{@link end} can release it. `null` otherwise. */
  private screenShareStream: MediaStream | null = null;
  private screenSharingState = false;
  /** Local mute (mic-enabled) intent. Applied to the local stream's audio
   * tracks as soon as one exists; survives across the ringing → connected
   * transition since it is re-applied whenever `localStream` is (re)assigned. */
  private mutedState = false;
  /** Incoming: the remote offer SDP, held until the user accepts. */
  private pendingRemoteOffer: string | null = null;
  /** Epoch guard: a fresh object per call, nulled by {@link end}. */
  private epoch: object | null = null;
  /**
   * Aborted by {@link end} to unblock a pending `await gathered`. The epoch
   * guard already prevents any wrong *action* after teardown, but the real
   * {@link gatherUntilEnoughIce} promise only settles on a candidate or
   * gathering completion — a closed pc emits neither — so without this the
   * awaited placeCall()/accept() would hang forever (and retain the closed pc).
   */
  private gatherAbort: AbortController | null = null;
  private pcConnectionListener: ConnectionListener | null = null;
  private pcTrackListener: TrackListener | null = null;

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

  /** The mic `deviceId` currently in use, or `null` if none was ever
   * explicitly selected (browser default). Set via the constructor's
   * `audioInputDeviceId` or a successful {@link switchMicrophone}. */
  get audioInputDeviceId(): string | null {
    return this.selectedAudioInputDeviceId;
  }

  /** Whether this call carries video (constructor's `hasVideo`; M3). `false`
   * means there is no outgoing video sender at all, so {@link
   * startScreenShare} always reports `onScreenShareError` on such a call. */
  get hasVideo(): boolean {
    return this.wantsVideo;
  }

  /** The camera `deviceId` currently selected — kept even while {@link
   * screenSharing} is `true` (it's what {@link stopScreenShare} reacquires),
   * so this does NOT reflect "what is on the wire right now" the way {@link
   * screenSharing} does. `null` if none was ever explicitly selected. */
  get videoInputDeviceId(): string | null {
    return this.selectedVideoInputDeviceId;
  }

  /** Whether the outgoing video is currently a screen capture rather than the
   * camera (M3). Always `false` for an audio-only call (no video sender to
   * hijack in the first place). */
  get screenSharing(): boolean {
    return this.screenSharingState;
  }

  /**
   * Mute/unmute the local mic by toggling `track.enabled` on every local
   * audio track — a local-only operation (stops sending audio, not a
   * signaling message), so it needs no core RPC and works identically before
   * or after `connected`. Safe to call at any time, including before a local
   * stream exists (incoming call still ringing): the intent is recorded and
   * applied as soon as {@link accept}/{@link placeCall} acquires the mic.
   */
  setMuted(muted: boolean): void {
    this.mutedState = muted;
    this.applyMutedToLocalStream();
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
      const stream = await this.factories.getUserMedia(this.mediaConstraints());
      if (!this.ensureActive(epoch)) {
        this.stopStream(stream); // resolved after hang up — stop it, don't adopt it
        return;
      }
      this.localStream = stream;
      this.applyMutedToLocalStream();
      this.notifyLocalTrackChanged(stream);

      const pc = this.createPeerConnection(epoch);
      // Attach the gather listeners BEFORE setLocalDescription so no candidate
      // is missed (see ice-gathering.ts CRITICAL ORDERING).
      const gathered = this.gather(pc, this.gatherOptionsWithSignal());
      this.addLocalTracks(pc, stream);
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
      const stream = await this.factories.getUserMedia(this.mediaConstraints());
      if (!this.ensureActive(epoch)) {
        this.stopStream(stream);
        return;
      }
      this.localStream = stream;
      this.applyMutedToLocalStream();
      this.notifyLocalTrackChanged(stream);

      const pc = this.createPeerConnection(epoch);
      const gathered = this.gather(pc, this.gatherOptionsWithSignal());
      await pc.setRemoteDescription({ type: 'offer', sdp: offerSdp });
      if (!this.ensureActive(epoch)) return;
      this.addLocalTracks(pc, stream);
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
   * Hot-switch the outgoing mic to `deviceId` without renegotiating: acquires
   * a fresh `getUserMedia` stream constrained to that device, then
   * `RTCRtpSender.replaceTrack`s it onto the existing audio sender. Requires
   * an active peer connection (i.e. not while an incoming call is still
   * `ringing` — the mic/pc don't exist yet at that point, same precondition
   * as {@link setMuted} in spirit but this one DOES need a pc to hold a
   * sender). Safe to call from `connecting` or `connected`; a no-op if the
   * call has already ended (mirrors the other public methods' epoch checks).
   *
   * On failure (device gone, permission revoked, etc.) the call is left
   * exactly as it was — the previous track keeps flowing — and
   * `callbacks.onDeviceSwitchError` fires instead of tearing anything down;
   * see the class doc's "DEVICE HOT-SWITCHING" section for the rationale.
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
   * Hot-switch the outgoing camera to `deviceId`, mirroring {@link
   * switchMicrophone} exactly (fresh `getUserMedia` + `RTCRtpSender.replaceTrack`,
   * no renegotiation). If currently {@link screenSharing}, there is no live
   * camera track on the wire to swap — this just records the preference
   * ({@link videoInputDeviceId}) for the camera {@link stopScreenShare} will
   * reacquire, matching `DevicePicker`'s pre-M3 "records a preference" note
   * for that case. A no-op if the call has no video at all ({@link hasVideo}
   * `false`) or has already ended; failures report `onDeviceSwitchError`
   * (same callback `switchMicrophone` uses — same failure class) without
   * touching the call.
   */
  async switchCamera(deviceId: string): Promise<void> {
    const epoch = this.epoch;
    if (epoch == null || this.machine.isTerminal) return; // ended: silent no-op
    if (!this.wantsVideo) {
      this.reportDeviceSwitchError(new Error('switchCamera: this call has no video'));
      return;
    }
    if (this.screenSharingState) {
      // Nothing live to replace right now; stopScreenShare() reacquires with
      // this deviceId when the camera comes back.
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
    this.callbacks.onLocalVideoTrackChanged?.(newTrack);
  }

  /**
   * Start sharing the screen: `getDisplayMedia()` a capture stream and
   * `RTCRtpSender.replaceTrack` it onto the EXISTING outgoing video sender
   * (docs/calls.md M3: "getDisplayMedia() that replaces the outgoing camera
   * track … so the remote sees it as the normal video track"). No
   * renegotiation, no new m-line — same technique as {@link switchMicrophone}/
   * {@link switchCamera} — so a `calls-webapp`-compatible peer sees this as an
   * ordinary video-track update, nothing screen-share-protocol-specific.
   *
   * Requires the call to already carry video ({@link hasVideo}): there is no
   * outgoing video m-line to hijack on an audio-only call, and adding one now
   * would need a fresh offer/answer round-trip over DeltaChat messaging,
   * which mid-call track changes deliberately avoid (see the class doc).
   * Reports {@link AudioCallCallbacks.onScreenShareError} rather than
   * throwing in every failure case (no video, capture factory missing, the
   * user cancelled the browser's share picker, `replaceTrack` rejected) — the
   * call is never torn down by a screen-share failure.
   *
   * The browser's own "Stop sharing" affordance ends the captured track out
   * from under us; the track's `ended` listener below treats that exactly
   * like an explicit {@link stopScreenShare}, so the UI's toggle state and
   * the outgoing video (restored to camera) both recover automatically.
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

    this.swapLocalVideoTrack(screenTrack);
    this.screenShareStream = displayStream;
    this.screenSharingState = true;
    this.callbacks.onScreenShareChanged?.(true);
    this.callbacks.onLocalVideoTrackChanged?.(screenTrack);
  }

  /**
   * Stop sharing the screen and restore the camera: re-acquires a fresh
   * camera stream (the {@link videoInputDeviceId} selected before/during the
   * share, if any) and `replaceTrack`s it back onto the outgoing video
   * sender — mirrors {@link startScreenShare} exactly, so this is equally
   * renegotiation-free. A no-op if not currently {@link screenSharing}.
   *
   * The screen capture is stopped regardless of what follows — screen
   * sharing is a stronger privacy commitment than a frozen/black video tile,
   * so a failed camera reacquisition does not leave the capture running;
   * {@link AudioCallCallbacks.onScreenShareError} surfaces that failure so
   * the UI can offer a retry (the outgoing video sender is left with no live
   * track until one succeeds — same degrade-gracefully contract as a failed
   * {@link switchMicrophone}/{@link switchCamera}).
   */
  async stopScreenShare(): Promise<void> {
    if (!this.screenSharingState) return;
    const epoch = this.epoch;
    const sender = this.videoSender;
    this.releaseScreenShareStream(); // stop the capture unconditionally
    this.screenSharingState = false;
    this.callbacks.onScreenShareChanged?.(false);
    if (epoch == null || this.machine.isTerminal || sender == null) return;

    let camStream: MediaStream;
    try {
      camStream = await this.factories.getUserMedia({
        audio: false,
        video: this.videoConstraintsFor(this.selectedVideoInputDeviceId),
      });
    } catch (error) {
      this.reportScreenShareError(error);
      return;
    }
    if (!this.ensureActive(epoch)) {
      this.stopStream(camStream);
      return;
    }
    const camTrack = camStream.getVideoTracks()[0];
    if (camTrack == null) {
      this.stopStream(camStream);
      this.reportScreenShareError(new Error('stopScreenShare: could not reacquire the camera'));
      return;
    }

    try {
      await sender.replaceTrack(camTrack);
    } catch (error) {
      this.stopStream(camStream);
      this.reportScreenShareError(error);
      return;
    }
    if (!this.ensureActive(epoch)) {
      this.stopStream(camStream);
      return;
    }

    this.swapLocalVideoTrack(camTrack);
    this.callbacks.onLocalVideoTrackChanged?.(camTrack);
  }

  /** Flip {@link screenSharing} (mirrors {@link toggleMuted}'s shape, but
   * async since both directions do real capture/track work). */
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

  /** Swap the live outgoing video track within `localStream` (mirrors
   * `switchMicrophone`'s audio-track swap) so `localMediaStream` always
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

  /** `addTrack` every track of `stream` onto `pc` (audio + video, when
   * present) and remember the resulting video sender for {@link
   * switchCamera}/{@link startScreenShare}/{@link stopScreenShare} to
   * `replaceTrack` on later. Shared by `placeCall`/`accept` (M1 only ever had
   * an audio track here; M3 adds the video one when `hasVideo`). */
  private addLocalTracks(pc: PeerConnectionLike, stream: MediaStream): void {
    for (const track of stream.getAudioTracks()) {
      pc.addTrack(track, stream);
    }
    for (const track of stream.getVideoTracks()) {
      pc.addTrack(track, stream);
    }
    this.videoSender =
      pc.getSenders().find((s) => s.track != null && s.track.kind === 'video') ?? null;
  }

  private reportDeviceSwitchError(error: unknown): void {
    const normalized = error instanceof Error ? error : new Error(String(error));
    this.callbacks.onDeviceSwitchError?.(normalized);
  }

  // ── Teardown ──────────────────────────────────────────────────────────────

  /**
   * End the call and release everything: stop the mic tracks, close the peer
   * connection, drop listeners. Idempotent — safe to call from a hang-up
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
    // Release any in-progress screen capture (M3). Its track also lives
    // inside `localStream` (see `swapLocalVideoTrack`), so `teardown()`'s
    // `stopStream(localStream)` would stop it too — this is just belt and
    // braces plus dropping our own `screenShareStream` reference, and
    // stopping an already-stopped track is a harmless no-op either way.
    this.releaseScreenShareStream();
    this.screenSharingState = false;
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

    const connectionListener: ConnectionListener = () => {
      if (!this.ensureActive(epoch)) return;
      const cs = pc.connectionState;
      if (cs === 'connected') {
        this.machine.transition('connected');
      } else if (cs === 'failed' || cs === 'closed') {
        this.end();
      }
      // 'disconnected' is transient (may recover); 'new'/'connecting' ignored.
    };
    const trackListener: TrackListener = (event) => {
      if (!this.ensureActive(epoch)) return;
      const stream = event.streams[0];
      if (stream == null) return;
      this.remoteStream = stream;
      this.callbacks.onRemoteStream?.(stream);
    };
    pc.addEventListener('connectionstatechange', connectionListener);
    pc.addEventListener('track', trackListener);
    this.pcConnectionListener = connectionListener;
    this.pcTrackListener = trackListener;
    return pc;
  }

  private maybePromoteConnected(epoch: object, pc: PeerConnectionLike): void {
    if (this.ensureActive(epoch) && pc.connectionState === 'connected') {
      this.machine.transition('connected');
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
  }
}
