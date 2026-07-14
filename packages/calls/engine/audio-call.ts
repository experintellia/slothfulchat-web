/**
 * The audio-only WebRTC call engine (M1 happy path — outgoing + incoming).
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

  private direction: CallDirection | null = null;
  private pc: PeerConnectionLike | null = null;
  private localStream: MediaStream | null = null;
  private remoteStream: MediaStream | null = null;
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
      for (const track of stream.getAudioTracks()) {
        pc.addTrack(track, stream);
      }
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
      for (const track of stream.getAudioTracks()) {
        pc.addTrack(track, stream);
      }
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

  /** Fire {@link AudioCallCallbacks.onLocalTrackChanged} for `stream`'s first
   * audio track, if any (a fresh `getUserMedia({ audio: true, video: false })`
   * stream always has exactly one). */
  private notifyLocalTrackChanged(stream: MediaStream): void {
    const track = stream.getAudioTracks()[0];
    if (track != null) this.callbacks.onLocalTrackChanged?.(track);
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
    this.teardown();
  }

  /** Alias for {@link end}, for call sites that read better as "hang up". */
  hangup(): void {
    this.end();
  }

  // ── Internals ───────────────────────────────────────────────────────────────

  private mediaConstraints(): MediaStreamConstraints {
    return { audio: this.audioConstraintsFor(this.selectedAudioInputDeviceId), video: false };
  }

  /** Merge a preferred `deviceId` (if any) into the base audio constraints. */
  private audioConstraintsFor(deviceId: string | null): MediaTrackConstraints | boolean {
    if (deviceId == null) return this.audioConstraints;
    const base = typeof this.audioConstraints === 'object' ? this.audioConstraints : {};
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
