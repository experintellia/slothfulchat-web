import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  AudioCallEngine,
  type AudioCallOptions,
  type PeerConnectionLike,
  type RtpSenderLike,
} from './audio-call.ts';
import { gatherUntilEnoughIce } from './ice-gathering.ts';
import type { CallState } from './call-state.ts';

// ── Test doubles ──────────────────────────────────────────────────────────────
//
// Erasable-syntax only (no constructor parameter properties / enums): Node's
// type-stripping `node --test *.test.ts` runs these sources unmodified.

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
}
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

class FakeTrack {
  kind: string;
  stopped = false;
  /** Mirrors real `MediaStreamTrack.enabled`, which defaults to `true`. */
  enabled = true;
  /** Mirrors real `MediaStreamTrack.muted` (defaults to `false`). */
  muted = false;
  private listeners = new Map<string, Set<() => void>>();
  constructor(kind = 'audio') {
    this.kind = kind;
  }
  stop(): void {
    this.stopped = true;
  }
  /** Mirrors just enough of `MediaStreamTrack.addEventListener` for the
   * engine's 'ended' (screen share, M3) and 'mute'/'unmute'/'ended' (remote
   * video fallback) listeners. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  addEventListener(type: string, listener: any): void {
    let set = this.listeners.get(type);
    if (set == null) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(listener);
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  removeEventListener(type: string, listener: any): void {
    this.listeners.get(type)?.delete(listener);
  }
  private fire(type: string): void {
    for (const l of [...(this.listeners.get(type) ?? [])]) l();
  }
  /** Test driver helper: simulate the browser's native "Stop sharing" button
   * (local screen track) or a remote video track going away. */
  fireEnded(): void {
    this.fire('ended');
  }
  fireMute(): void {
    this.muted = true;
    this.fire('mute');
  }
  fireUnmute(): void {
    this.muted = false;
    this.fire('unmute');
  }
}

class FakeStream {
  tracks: FakeTrack[];
  constructor(tracks: FakeTrack[]) {
    this.tracks = tracks;
  }
  /** Mirrors real `MediaStream.removeTrack` — used by
   * `AudioCallEngine.switchMicrophone` to drop the old track from the
   * existing local stream in place. */
  removeTrack(track: FakeTrack): void {
    this.tracks = this.tracks.filter((t) => t !== track);
  }
  /** Mirrors real `MediaStream.addTrack`. */
  addTrack(track: FakeTrack): void {
    this.tracks.push(track);
  }
  getTracks(): FakeTrack[] {
    return this.tracks;
  }
  getAudioTracks(): FakeTrack[] {
    return this.tracks.filter((t) => t.kind === 'audio');
  }
  /** Mirrors real `MediaStream.getVideoTracks` (M3: `addLocalTracks` calls
   * this unconditionally, same as `getAudioTracks`, so every fake stream —
   * even an audio-only `micStream()` — must implement it). */
  getVideoTracks(): FakeTrack[] {
    return this.tracks.filter((t) => t.kind === 'video');
  }
}

function micStream(): FakeStream {
  return new FakeStream([new FakeTrack('audio')]);
}

/** A mic + camera stream, for M3 video-call tests. */
function avStream(): FakeStream {
  return new FakeStream([new FakeTrack('audio'), new FakeTrack('video')]);
}

/** A `getDisplayMedia()`-shaped capture stream: one video track, no audio
 * (matches `startScreenShare`'s `{ video: true, audio: false }` request). */
function screenStream(): FakeStream {
  return new FakeStream([new FakeTrack('video')]);
}

/** A controllable fake `RTCRtpSender` — tracks `replaceTrack` calls so tests
 * can assert the hot-switch actually swapped the outgoing track. Typed
 * against the ambient `MediaStreamTrack`/`RtpSenderLike` shape (not
 * `FakeTrack` directly) the same way the rest of this file's fakes are — the
 * `getUserMedia`/stream boundary is where the `as unknown as` cast to the
 * ambient WebRTC types happens; a `FakeTrack` instance flows through as a
 * `MediaStreamTrack` from that point on. */
class FakeSender implements RtpSenderLike {
  track: MediaStreamTrack | null;
  replaceTrackCalls: Array<MediaStreamTrack | null> = [];
  setStreamsCalls: MediaStream[][] = [];
  constructor(track: MediaStreamTrack | null) {
    this.track = track;
  }
  async replaceTrack(track: MediaStreamTrack | null): Promise<void> {
    this.replaceTrackCalls.push(track);
    this.track = track;
  }
  setStreams(...streams: MediaStream[]): void {
    this.setStreamsCalls.push(streams);
  }
}

/** A controllable fake negotiated data channel satisfying DataChannelLike. */
class FakeDataChannel {
  label: string;
  options: { negotiated?: boolean; id?: number } | undefined;
  readyState: RTCDataChannelState = 'connecting';
  /** Everything `send()` was called with — deliberately recorded even while
   * not 'open', so a missing readyState guard in the engine shows up here. */
  sent: string[] = [];
  private openListeners = new Set<() => void>();
  private messageListeners = new Set<(event: { data: unknown }) => void>();
  constructor(label: string, options?: { negotiated?: boolean; id?: number }) {
    this.label = label;
    this.options = options;
  }
  send(data: string): void {
    this.sent.push(data);
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  addEventListener(type: string, listener: any): void {
    if (type === 'open') this.openListeners.add(listener);
    else if (type === 'message') this.messageListeners.add(listener);
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  removeEventListener(type: string, listener: any): void {
    if (type === 'open') this.openListeners.delete(listener);
    else if (type === 'message') this.messageListeners.delete(listener);
  }
  // Test driver helpers.
  fireOpen(): void {
    this.readyState = 'open';
    for (const l of [...this.openListeners]) l();
  }
  fireMessage(data: unknown): void {
    for (const l of [...this.messageListeners]) l({ data });
  }
}

type FakeTransceiver = {
  kind: string;
  sender: FakeSender;
  direction: RTCRtpTransceiverDirection;
  /** The NEGOTIATED direction — settable so tests can drive the post-connect
   * video diagnostics. */
  currentDirection?: RTCRtpTransceiverDirection | null;
  receiver: { track: MediaStreamTrack | null };
  /** Records every `setCodecPreferences` call so tests can assert the engine
   * applied `videoCodecPreferences` to the video transceiver. */
  setCodecPreferencesCalls?: RTCRtpCodec[][];
  setCodecPreferences?(codecs: RTCRtpCodec[]): void;
};

/** Attach a recording `setCodecPreferences` to a fake transceiver in place;
 * `throwOnSet` makes it record then throw (real browsers throw on an
 * unsupported/empty preference list — the engine must degrade, not die). */
function withCodecPrefRecording(t: FakeTransceiver, throwOnSet = false): FakeTransceiver {
  t.setCodecPreferencesCalls = [];
  t.setCodecPreferences = (codecs) => {
    t.setCodecPreferencesCalls!.push(codecs);
    if (throwOnSet) throw new Error('setCodecPreferences: unsupported codecs');
  };
  return t;
}

/** A controllable fake peer connection satisfying PeerConnectionLike. */
class FakePc implements PeerConnectionLike {
  connectionState: RTCPeerConnectionState = 'new';
  localDescription: { type: string; sdp: string } | null = null;
  remoteDescription: RTCSessionDescriptionInit | null = null;
  closed = false;
  addedTracks: unknown[] = [];
  senders: FakeSender[] = [];
  /** All transceivers on this pc, mirroring `RTCPeerConnection.getTransceivers()`:
   * the audio-only call's always-present video m-line created via `addTransceiver`
   * (M3), AND the recvonly video transceiver `setRemoteDescription(offer)` seeds
   * on the answerer (see {@link seedRemoteVideoSender}). `direction` is settable
   * so a test can assert the answerer promotes the recvonly one to `sendrecv`
   * (BUG 1 / interop). */
  transceivers: FakeTransceiver[] = [];
  /** Every channel `createDataChannel` produced, in creation order (the
   * engine creates iceTrickling then mutedState). */
  dataChannels: FakeDataChannel[] = [];
  /** How many times `addTransceiver` was called — distinct from
   * `transceivers.length`, which also counts the seeded recvonly one. An answer
   * MUST NOT `addTransceiver` (it can't add an m-line the offer lacked), so
   * tests assert this stays 0 on the answer side. */
  addTransceiverCount = 0;
  transceiverInits: Array<{ direction?: RTCRtpTransceiverDirection; streams?: MediaStream[] } | undefined> = [];
  configuration: RTCConfiguration;
  /** M5: what {@link getStats} resolves with — tests set this to a `Map` of
   * `RtcStatsEntry`-shaped objects to drive `getConnectionRoute()`. Empty by
   * default (no candidate-pair stats yet), matching a fresh/unconnected pc. */
  statsReport: Map<string, { id: string; type: string; [key: string]: unknown }> = new Map();
  /** When true, `setRemoteDescription({type:'offer'})` seeds a trackless video
   * sender — mimicking the browser creating a sender for the peer's
   * always-present video m-line (upstream calls-webapp offers audio+video).
   * Lets a test exercise the answerer adopting that sender instead of adding a
   * duplicate m-line. */
  seedRemoteVideoSender = false;
  /** The sender seeded by {@link seedRemoteVideoSender}, for assertions. */
  seededVideoSender: FakeSender | null = null;
  /** When true, every video transceiver's `setCodecPreferences` throws — so a
   * test can prove a throwing preference set never breaks the call. */
  throwOnSetCodecPreferences = false;
  private connListeners = new Set<() => void>();
  private trackListeners = new Set<
    (e: { streams: ReadonlyArray<MediaStream>; track: MediaStreamTrack }) => void
  >();

  constructor(configuration: RTCConfiguration) {
    this.configuration = configuration;
  }

  get iceGatheringState(): RTCIceGatheringState {
    return 'complete';
  }
  getConfiguration(): RTCConfiguration {
    return this.configuration;
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  addEventListener(type: string, listener: any): void {
    if (type === 'connectionstatechange') this.connListeners.add(listener);
    else if (type === 'track') this.trackListeners.add(listener);
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  removeEventListener(type: string, listener: any): void {
    if (type === 'connectionstatechange') this.connListeners.delete(listener);
    else if (type === 'track') this.trackListeners.delete(listener);
  }
  async createOffer(): Promise<RTCSessionDescriptionInit> {
    return { type: 'offer', sdp: 'OFFER_SDP' };
  }
  async createAnswer(): Promise<RTCSessionDescriptionInit> {
    return { type: 'answer', sdp: 'ANSWER_SDP' };
  }
  async setLocalDescription(description?: RTCLocalSessionDescriptionInit): Promise<void> {
    this.localDescription = {
      type: description?.type ?? 'offer',
      sdp: description?.sdp ?? '',
    };
  }
  async setRemoteDescription(description: RTCSessionDescriptionInit): Promise<void> {
    this.remoteDescription = description;
    if (this.seedRemoteVideoSender && description.type === 'offer') {
      // Mimic the browser creating a sender AND a transceiver for the peer's
      // always-present video m-line (upstream calls-webapp offers audio+video).
      // The transceiver's direction defaults to `recvonly` — the answerer must
      // promote it to `sendrecv` or web→peer video/screenshare never flows.
      const sender = new FakeSender(null);
      this.seededVideoSender = sender;
      this.senders.push(sender);
      this.transceivers.push(
        withCodecPrefRecording(
          {
            kind: 'video',
            sender,
            direction: 'recvonly',
            receiver: { track: null },
          },
          this.throwOnSetCodecPreferences
        )
      );
    }
  }
  addTrack(track: MediaStreamTrack): unknown {
    this.addedTracks.push(track);
    const sender = new FakeSender(track);
    this.senders.push(sender);
    // Real `addTrack` finds/creates a transceiver for the track. Model it for
    // video so the sender-identity lookups (codec preferences, diagnostics)
    // find a matching transceiver on the camera-at-start path.
    if ((track as unknown as FakeTrack).kind === 'video') {
      this.transceivers.push(
        withCodecPrefRecording(
          {
            kind: 'video',
            sender,
            direction: 'sendrecv',
            receiver: { track: null },
          },
          this.throwOnSetCodecPreferences
        )
      );
    }
    return sender;
  }
  /** Mirrors `RTCPeerConnection.addTransceiver(kind, init)` just enough for
   * `AudioCallEngine.addLocalTracks`: creates a trackless sender (an audio-only
   * call's always-present video m-line — see the M3 "always negotiate video"
   * change) and returns the transceiver (`{ sender, direction, ... }`).
   * Recorded in `getSenders()`/`getTransceivers()` so `switchMicrophone`/
   * screen-share sender lookups and the answerer's direction promotion see it. */
  addTransceiver(
    kind: string,
    init?: { direction?: RTCRtpTransceiverDirection; streams?: MediaStream[] }
  ): FakeTransceiver {
    this.addTransceiverCount += 1;
    this.transceiverInits.push(init);
    const sender = new FakeSender(null);
    const transceiver: FakeTransceiver = withCodecPrefRecording(
      {
        kind,
        sender,
        direction: init?.direction ?? 'sendrecv',
        receiver: { track: null },
      },
      this.throwOnSetCodecPreferences
    );
    this.transceivers.push(transceiver);
    this.senders.push(sender);
    return transceiver;
  }
  createDataChannel(
    label: string,
    options?: { negotiated?: boolean; id?: number }
  ): FakeDataChannel {
    const channel = new FakeDataChannel(label, options);
    this.dataChannels.push(channel);
    return channel;
  }
  getSenders(): FakeSender[] {
    return this.senders;
  }
  getTransceivers(): FakeTransceiver[] {
    return this.transceivers;
  }
  async getStats(): Promise<Map<string, { id: string; type: string; [key: string]: unknown }>> {
    return this.statsReport;
  }
  close(): void {
    this.closed = true;
  }

  // Test driver helpers.
  fireConnectionState(state: RTCPeerConnectionState): void {
    this.connectionState = state;
    for (const l of [...this.connListeners]) l();
  }
  fireTrack(stream: MediaStream): void {
    const track = (stream as unknown as FakeStream).getTracks()[0] as unknown as MediaStreamTrack;
    for (const l of [...this.trackListeners]) l({ streams: [stream], track });
  }
  /** ontrack for an m-line with no stream association (a=msid:- ...). */
  fireStreamlessTrack(track: MediaStreamTrack): void {
    for (const l of [...this.trackListeners]) l({ streams: [], track });
  }
  listenerCount(): number {
    return this.connListeners.size + this.trackListeners.size;
  }
}

const ICE_SERVERS: RTCIceServer[] = [{ urls: 'turn:relay.example:3478' }];

/** Build an engine plus captured handles for driving/asserting it. */
function makeEngine(
  overrides: {
    getUserMedia?: (constraints: MediaStreamConstraints) => Promise<MediaStream>;
    getDisplayMedia?: (constraints?: MediaStreamConstraints) => Promise<MediaStream>;
    gather?: AudioCallOptions['gather'];
    hasVideo?: boolean;
    /** Seed a trackless video sender on the answerer's `setRemoteDescription`
     * (see {@link FakePc.seedRemoteVideoSender}). */
    seedRemoteVideoSender?: boolean;
    /** Opt-in `createPlaceholderVideoTrack` factory (iOS/ssrc). Left undefined
     * by default so the existing trackless-transceiver tests stay unchanged. */
    makePlaceholderTrack?: () => FakeTrack;
    /** Codec preferences applied to the video transceiver (Firefox/H264). */
    videoCodecPreferences?: RTCRtpCodec[];
    /** Make every video transceiver's `setCodecPreferences` throw. */
    throwOnSetCodecPreferences?: boolean;
  } = {}
) {
  const events = {
    states: [] as CallState[],
    offers: [] as string[],
    answers: [] as string[],
    remoteStreams: [] as MediaStream[],
    errors: [] as Error[],
    deviceSwitchErrors: [] as Error[],
    localTrackChanges: [] as MediaStreamTrack[],
    localVideoTrackChanges: [] as Array<MediaStreamTrack | null>,
    screenShareChanges: [] as boolean[],
    screenShareErrors: [] as Error[],
    remoteVideoActive: [] as boolean[],
    remoteAudioMuted: [] as boolean[],
  };
  const pcs: FakePc[] = [];
  const defaultGetUserMedia = async () =>
    (overrides.hasVideo ? avStream() : micStream()) as unknown as MediaStream;

  const engine = new AudioCallEngine({
    iceServers: ICE_SERVERS,
    gather: overrides.gather ?? (async () => {}),
    hasVideo: overrides.hasVideo,
    videoCodecPreferences: overrides.videoCodecPreferences,
    factories: {
      getUserMedia: overrides.getUserMedia ?? defaultGetUserMedia,
      getDisplayMedia: overrides.getDisplayMedia,
      createPlaceholderVideoTrack: overrides.makePlaceholderTrack
        ? () => overrides.makePlaceholderTrack!() as unknown as MediaStreamTrack
        : undefined,
      createPeerConnection: (config) => {
        const pc = new FakePc(config);
        pc.seedRemoteVideoSender = overrides.seedRemoteVideoSender ?? false;
        pc.throwOnSetCodecPreferences = overrides.throwOnSetCodecPreferences ?? false;
        pcs.push(pc);
        return pc;
      },
    },
    callbacks: {
      onStateChange: (s) => events.states.push(s),
      onLocalOffer: (sdp) => events.offers.push(sdp),
      onLocalAnswer: (sdp) => events.answers.push(sdp),
      onRemoteStream: (s) => events.remoteStreams.push(s),
      onError: (e) => events.errors.push(e),
      onDeviceSwitchError: (e) => events.deviceSwitchErrors.push(e),
      onLocalTrackChanged: (t) => events.localTrackChanges.push(t),
      onLocalVideoTrackChanged: (t) => events.localVideoTrackChanges.push(t),
      onScreenShareChanged: (sharing) => events.screenShareChanges.push(sharing),
      onScreenShareError: (e) => events.screenShareErrors.push(e),
      onRemoteVideoActiveChanged: (active) => events.remoteVideoActive.push(active),
      onRemoteAudioMutedChanged: (muted) => events.remoteAudioMuted.push(muted),
    },
  });
  return {
    engine,
    events,
    pcs,
    lastPc: () => pcs[pcs.length - 1],
    /** The last pc's `mutedState` channel (the engine always creates it). */
    mutedChannel: () =>
      pcs[pcs.length - 1].dataChannels.find((c) => c.label === 'mutedState')!,
  };
}

// ── Outgoing ──────────────────────────────────────────────────────────────────

test('outgoing happy path: place -> ring -> answer -> connect -> hang up', async () => {
  const { engine, events, lastPc } = makeEngine();

  await engine.placeCall();
  assert.equal(engine.state, 'ringing');
  assert.deepEqual(events.offers, ['OFFER_SDP'], 'offer surfaced for rpc.placeOutgoingCall');
  const pc = lastPc();
  assert.equal(pc.addedTracks.length, 1, 'mic track added');
  assert.equal(pc.configuration.iceServers, ICE_SERVERS, 'ICE servers fed in from outside');
  assert.equal(pc.configuration.bundlePolicy, 'max-bundle', 'uses interop RTC config');

  await engine.provideAnswer('ANSWER_FROM_PEER');
  assert.equal(engine.state, 'connecting');
  assert.deepEqual(pc.remoteDescription, { type: 'answer', sdp: 'ANSWER_FROM_PEER' });

  pc.fireConnectionState('connected');
  assert.equal(engine.state, 'connected');

  engine.hangup();
  assert.equal(engine.state, 'ended');
  assert.equal(pc.closed, true, 'peer connection closed on teardown');
  assert.equal(pc.listenerCount(), 0, 'listeners removed on teardown');
  assert.deepEqual(events.states, ['ringing', 'connecting', 'connected', 'ended']);
});

test('outgoing: remote stream surfaced via ontrack', async () => {
  const { engine, events, lastPc } = makeEngine();
  await engine.placeCall();
  const remote = micStream() as unknown as MediaStream;
  lastPc().fireTrack(remote);
  assert.deepEqual(events.remoteStreams, [remote]);
  assert.equal(engine.remoteMediaStream, remote);
});

// ── Incoming ──────────────────────────────────────────────────────────────────

test('incoming happy path: receive -> ring (no mic) -> accept -> answer -> connect', async () => {
  const { engine, events, pcs, lastPc } = makeEngine();

  engine.receiveCall('OFFER_FROM_PEER');
  assert.equal(engine.state, 'ringing');
  assert.equal(engine.callDirection, 'incoming');
  assert.equal(pcs.length, 0, 'no peer connection / mic before accept');
  assert.equal(engine.localMediaStream, null, 'mic not touched while ringing');

  await engine.accept();
  assert.equal(engine.state, 'connecting');
  assert.deepEqual(events.answers, ['ANSWER_SDP'], 'answer surfaced for rpc.acceptIncomingCall');
  const pc = lastPc();
  assert.deepEqual(pc.remoteDescription, { type: 'offer', sdp: 'OFFER_FROM_PEER' });
  assert.equal(pc.addedTracks.length, 1);
  assert.notEqual(engine.localMediaStream, null, 'mic acquired on accept');

  pc.fireConnectionState('connected');
  assert.equal(engine.state, 'connected');
});

test('INTEROP: audio-started answerer adopts the peer-offered video sender (no duplicate m-line), so camera works', async () => {
  // The peer (calls-webapp) always offers audio+video; the browser creates a
  // trackless video sender for that m-line on setRemoteDescription. The
  // answerer must ADOPT it, not addTransceiver a duplicate an answer can't add.
  const camera = new FakeTrack('video');
  let call = 0;
  const { engine, lastPc } = makeEngine({
    seedRemoteVideoSender: true,
    getUserMedia: async () => {
      call += 1;
      return (call === 1 ? micStream() : new FakeStream([camera])) as unknown as MediaStream;
    },
  });
  engine.receiveCall('OFFER_FROM_PEER');
  await engine.accept();

  const pc = lastPc();
  assert.equal(pc.addTransceiverCount, 0, 'no addTransceiver on the answer side (would be an unmatched m-line)');
  assert.ok(pc.seededVideoSender, 'the peer-offered video sender exists');
  // BUG 1 / interop regression guard: the peer-offered video transceiver
  // defaults to `recvonly`; the answerer MUST promote it to `sendrecv` before
  // the answer is created, or web→peer video/screenshare never flows.
  const videoTransceiver = pc.transceivers.find((t) => t.sender === pc.seededVideoSender);
  assert.ok(videoTransceiver, 'the peer-offered video transceiver exists');
  assert.equal(
    videoTransceiver!.direction,
    'sendrecv',
    'answerer promoted the peer-offered recvonly video transceiver to sendrecv'
  );
  assert.equal(engine.cameraEnabled, false, 'audio-started');

  await engine.setCameraEnabled(true);

  assert.equal(engine.cameraEnabled, true);
  assert.equal(
    pc.seededVideoSender!.track,
    camera as unknown as MediaStreamTrack,
    'camera replaced onto the ADOPTED peer video sender — reaches the peer'
  );
});

test('INTEROP: audio-started answerer can screen-share to the peer (replaceTrack onto the promoted sendrecv sender)', async () => {
  // Same interop scenario as above but via screen share (the live-confirmed
  // broken path): the answer's video m-line must be sendrecv so getDisplayMedia
  // → replaceTrack onto the adopted peer video sender actually reaches DC.
  const screen = screenStream();
  const { engine, events, lastPc } = makeEngine({
    seedRemoteVideoSender: true,
    getDisplayMedia: async () => screen as unknown as MediaStream,
  });
  engine.receiveCall('OFFER_FROM_PEER');
  await engine.accept();

  const pc = lastPc();
  assert.equal(pc.addTransceiverCount, 0, 'no addTransceiver on the answer side');
  const videoTransceiver = pc.transceivers.find((t) => t.sender === pc.seededVideoSender);
  assert.equal(videoTransceiver!.direction, 'sendrecv', 'video m-line promoted to sendrecv');

  await engine.startScreenShare();

  assert.equal(engine.screenSharing, true);
  assert.equal(events.screenShareErrors.length, 0);
  assert.equal(
    pc.seededVideoSender!.track,
    screen.tracks[0] as unknown as MediaStreamTrack,
    'screen track replaced onto the ADOPTED, now-sendrecv peer video sender — reaches DC'
  );
});

test('INTEROP: audio-started offerer associates the local stream with the video m-line (msid)', async () => {
  // A trackless addTransceiver yields `a=msid:- ...` — the peer's ontrack then
  // fires with empty event.streams and stream-based consumers (calls-webapp)
  // never see the later replaceTrack'd camera: RTP flows but renders black.
  const { engine, lastPc } = makeEngine();
  await engine.placeCall();
  const pc = lastPc();
  assert.equal(pc.transceiverInits.length, 1);
  assert.deepEqual(
    pc.transceiverInits[0]?.streams,
    [engine.localMediaStream],
    'video transceiver carries the local stream so the offer has a real a=msid'
  );
});

test('INTEROP: audio-started answerer associates the local stream via setStreams (msid)', async () => {
  const { engine, lastPc } = makeEngine({ seedRemoteVideoSender: true });
  engine.receiveCall('OFFER_FROM_PEER');
  await engine.accept();
  const pc = lastPc();
  assert.deepEqual(
    pc.seededVideoSender!.setStreamsCalls,
    [[engine.localMediaStream]],
    'adopted trackless video sender got setStreams(localStream) before the answer'
  );
});

test('streamless ontrack folds the track into the existing remote stream', async () => {
  // A peer whose video m-line has no msid (e.g. an old build offering a bare
  // trackless transceiver) fires ontrack with empty event.streams — the track
  // must still land in remoteStream for the UI to render it.
  const { engine, events, lastPc } = makeEngine();
  await engine.placeCall();
  const remote = micStream() as unknown as MediaStream;
  lastPc().fireTrack(remote);
  const strayVideo = new FakeTrack('video') as unknown as MediaStreamTrack;
  lastPc().fireStreamlessTrack(strayVideo);
  assert.equal(engine.remoteMediaStream, remote, 'same remote stream kept');
  assert.ok(
    (remote as unknown as FakeStream).getTracks().includes(strayVideo as unknown as FakeTrack),
    'streamless video track folded into the remote stream'
  );
  assert.equal(events.remoteStreams.length, 2, 'onRemoteStream re-fired with the updated stream');
});

// ── Mute ──────────────────────────────────────────────────────────────────────

test('setMuted toggles track.enabled on the local audio track', async () => {
  const { engine } = makeEngine();
  await engine.placeCall();
  const track = (engine.localMediaStream as unknown as FakeStream).getTracks()[0] as unknown as MediaStreamTrack;
  assert.equal(engine.muted, false);
  assert.equal(track.enabled, true);

  engine.setMuted(true);
  assert.equal(engine.muted, true);
  assert.equal(track.enabled, false);

  const nowMuted = engine.toggleMuted();
  assert.equal(nowMuted, false);
  assert.equal(engine.muted, false);
  assert.equal(track.enabled, true);
});

test('mute intent set before the mic is acquired is applied once it is', async () => {
  const gum = deferred<MediaStream>();
  const { engine } = makeEngine({ getUserMedia: () => gum.promise });

  engine.receiveCall('OFFER_FROM_PEER');
  engine.setMuted(true); // ringing, no local stream yet — must not throw
  assert.equal(engine.muted, true);

  const accepting = engine.accept();
  const stream = micStream();
  gum.resolve(stream as unknown as MediaStream);
  await accepting;

  assert.equal(stream.getTracks()[0].enabled, false, 'mute intent applied once the mic arrives');
});

// ── Device switching (M2) ─────────────────────────────────────────────────────

test('switchMicrophone replaces the sender track via RTCRtpSender.replaceTrack, no renegotiation', async () => {
  const gumCalls: MediaStreamConstraints[] = [];
  const { engine, lastPc } = makeEngine({
    getUserMedia: async (constraints) => {
      gumCalls.push(constraints);
      return micStream() as unknown as MediaStream;
    },
  });
  await engine.placeCall();
  await engine.provideAnswer('ANSWER');
  const pc = lastPc();
  pc.fireConnectionState('connected');
  const originalTrack = pc.senders[0].track;
  assert.equal(engine.audioInputDeviceId, null, 'no device explicitly selected yet');

  await engine.switchMicrophone('mic-2');

  // Two senders now: the audio sender (senders[0]) plus the always-present
  // video transceiver (senders[1]); switchMicrophone must not add a THIRD.
  assert.equal(pc.senders.length, 2, 'no new sender/renegotiation — same sender, track replaced');
  assert.equal(pc.senders[0].replaceTrackCalls.length, 1);
  assert.notEqual(pc.senders[0].track, originalTrack, 'sender now carries the new track');
  assert.equal((originalTrack as unknown as FakeTrack).stopped, true, 'old track stopped');
  assert.equal(engine.audioInputDeviceId, 'mic-2');
  const constraints = gumCalls[1].audio;
  assert.ok(typeof constraints === 'object' && 'deviceId' in constraints);
  assert.deepEqual((constraints as MediaTrackConstraints).deviceId, { exact: 'mic-2' });
});

test('onLocalTrackChanged fires on initial mic acquisition and again on a successful switch (re-tap seam for the level meter)', async () => {
  const { engine, events } = makeEngine();
  await engine.placeCall();
  await engine.provideAnswer('ANSWER');
  assert.equal(events.localTrackChanges.length, 1, 'fired once for the initial mic');

  await engine.switchMicrophone('mic-2');
  assert.equal(events.localTrackChanges.length, 2, 'fired again after the hot-switch');
  assert.notEqual(events.localTrackChanges[0], events.localTrackChanges[1], 'a distinct track object');
});

test('switchMicrophone preserves mute state across the swap', async () => {
  const { engine, lastPc } = makeEngine();
  await engine.placeCall();
  await engine.provideAnswer('ANSWER');
  lastPc().fireConnectionState('connected');
  engine.setMuted(true);

  await engine.switchMicrophone('mic-2');

  const pc = lastPc();
  const newTrack = pc.senders[0].track as unknown as FakeTrack;
  assert.equal(newTrack.enabled, false, 'mute intent carried over to the new track');
});

test('switchMicrophone failure reports onDeviceSwitchError and leaves the call/old track intact', async () => {
  let call = 0;
  const { engine, events, lastPc } = makeEngine({
    getUserMedia: async () => {
      call += 1;
      if (call === 1) return micStream() as unknown as MediaStream; // initial acquire succeeds
      throw new Error('NotFoundError'); // the switch fails
    },
  });
  await engine.placeCall();
  await engine.provideAnswer('ANSWER');
  const pc = lastPc();
  pc.fireConnectionState('connected');
  const originalTrack = pc.senders[0].track;

  await engine.switchMicrophone('missing-device');

  assert.equal(events.deviceSwitchErrors.length, 1);
  assert.match(events.deviceSwitchErrors[0].message, /NotFoundError/);
  assert.equal(engine.state, 'connected', 'call is NOT torn down by a failed switch');
  assert.equal(pc.senders[0].track, originalTrack, 'the old track is left flowing, untouched');
  assert.equal(pc.senders[0].replaceTrackCalls.length, 0, 'replaceTrack never reached');
});

test('switchMicrophone before a peer connection exists (incoming, still ringing) reports an error, does not throw', async () => {
  const { engine, events } = makeEngine();
  engine.receiveCall('OFFER_FROM_PEER');
  assert.equal(engine.state, 'ringing');

  await engine.switchMicrophone('mic-2'); // must not throw

  assert.equal(events.deviceSwitchErrors.length, 1);
  assert.equal(engine.state, 'ringing', 'no side effect on call state');
});

test('switchMicrophone after hang up is a silent no-op', async () => {
  const { engine, events } = makeEngine();
  await engine.placeCall();
  await engine.provideAnswer('ANSWER');
  engine.hangup();

  await engine.switchMicrophone('mic-2'); // must not throw, must not resurrect

  assert.equal(engine.state, 'ended');
  assert.equal(events.deviceSwitchErrors.length, 0, 'ended is a silent no-op, not an error');
});

test('RACE: switchMicrophone in flight when hang up lands — new stream is stopped, not adopted', async () => {
  const gum = deferred<MediaStream>();
  let call = 0;
  const { engine, lastPc } = makeEngine({
    getUserMedia: async () => {
      call += 1;
      return call === 1 ? (micStream() as unknown as MediaStream) : gum.promise;
    },
  });
  await engine.placeCall();
  await engine.provideAnswer('ANSWER');
  const pc = lastPc();
  const originalTrack = pc.senders[0].track;

  const switching = engine.switchMicrophone('mic-2');
  engine.hangup(); // torn down while the new getUserMedia is in flight
  const lateStream = micStream();
  gum.resolve(lateStream as unknown as MediaStream);
  await switching;

  assert.equal(engine.state, 'ended');
  assert.equal(pc.senders[0].track, originalTrack, 'sender untouched — replaceTrack never called');
  assert.equal(pc.senders[0].replaceTrackCalls.length, 0);
  assert.equal(lateStream.tracks[0].stopped, true, 'the orphaned new-device stream is stopped');
});

// ── Video + screen share (M3) ─────────────────────────────────────────────────

test('hasVideo: placeCall adds a video track/sender alongside the mic', async () => {
  const { engine, events, lastPc } = makeEngine({ hasVideo: true });
  await engine.placeCall();

  const pc = lastPc();
  assert.equal(pc.addedTracks.length, 2, 'audio + video both added');
  assert.equal(pc.senders.length, 2);
  assert.ok(
    pc.senders.some((s) => (s.track as unknown as { kind: string } | null)?.kind === 'video'),
    'a video sender exists'
  );
  assert.equal(engine.hasVideo, true);
  assert.equal(
    events.localVideoTrackChanges.length,
    1,
    'onLocalVideoTrackChanged fires for the initial camera track'
  );
});

test('hasVideo: accept adds a video track/sender alongside the mic', async () => {
  const { engine, lastPc } = makeEngine({ hasVideo: true });
  engine.receiveCall('OFFER_FROM_PEER');
  await engine.accept();

  const pc = lastPc();
  assert.equal(pc.addedTracks.length, 2);
  assert.ok(pc.senders.some((s) => (s.track as unknown as { kind: string } | null)?.kind === 'video'));
});

test('BUG 3: a video-started call with no camera degrades to audio-only (non-fatal, call proceeds)', async () => {
  let call = 0;
  const gumConstraints: MediaStreamConstraints[] = [];
  const { engine, events, lastPc } = makeEngine({
    hasVideo: true,
    getUserMedia: async (constraints) => {
      call += 1;
      gumConstraints.push(constraints);
      // First acquisition (audio+video) fails — no camera. The audio-only
      // retry succeeds, so the camera (not the mic) was the problem.
      if (call === 1) throw new Error('NotFoundError: requested device not found');
      return micStream() as unknown as MediaStream;
    },
  });

  await engine.placeCall();

  assert.equal(engine.state, 'ringing', 'a missing camera does NOT tear the call down');
  assert.deepEqual(events.errors, [], 'no fatal onError');
  assert.deepEqual(events.offers, ['OFFER_SDP'], 'the offer is still placed');
  assert.equal(events.deviceSwitchErrors.length, 1, 'camera failure surfaced as a non-fatal device error');
  assert.match(events.deviceSwitchErrors[0].message, /NotFoundError/);
  assert.equal(engine.cameraEnabled, false, 'started audio-only (camera off)');
  assert.notEqual(gumConstraints[0].video, false, 'first acquisition requested video');
  assert.equal(gumConstraints[1].video, false, 'retry acquired audio only');
  // The video m-line is still negotiated (offerer addTransceiver sendrecv), so
  // the peer's video can still be RECEIVED and the screen can still be SHARED.
  const pc = lastPc();
  assert.equal(pc.transceivers.length, 1, 'a video sender is still negotiated despite no camera');
  assert.equal(pc.transceivers[0].kind, 'video');
});

test('BUG 3: a video-started call whose MIC also fails still ends the call (onError)', async () => {
  // Distinguishes camera failure (degrade) from mic failure (fatal): when BOTH
  // the combined and the audio-only acquisitions fail, it is a mic/permission
  // problem and the call must fail as before.
  const { engine, events } = makeEngine({
    hasVideo: true,
    getUserMedia: async () => {
      throw new Error('NotAllowedError: permission denied');
    },
  });

  await engine.placeCall();

  assert.equal(engine.state, 'ended', 'a mic failure still ends the call');
  assert.equal(events.errors.length, 1, 'reported as a fatal onError');
  assert.match(events.errors[0].message, /NotAllowedError/);
  assert.equal(events.deviceSwitchErrors.length, 0, 'not a device-switch error — the call ended');
});

test('audio-started call (hasVideo false, default): no camera track/constraint, but a video sender IS negotiated', async () => {
  const gumCalls: MediaStreamConstraints[] = [];
  const { engine, lastPc } = makeEngine({
    getUserMedia: async (constraints) => {
      gumCalls.push(constraints);
      return micStream() as unknown as MediaStream;
    },
  });
  await engine.placeCall();
  assert.equal(gumCalls[0].video, false, 'no camera acquired at start (audio-vs-video is only what is ENABLED)');
  const pc = lastPc();
  assert.equal(pc.addedTracks.length, 1, 'only the mic is addTrack-ed');
  assert.equal(engine.hasVideo, false, 'started audio-only');
  assert.equal(engine.cameraEnabled, false, 'camera is off at start');
  // Upstream calls-webapp always negotiates BOTH m-lines; we mirror that with a
  // trackless video transceiver so camera/screen-share can turn on with no
  // renegotiation. Senders: audio (addTrack) + video (addTransceiver).
  assert.equal(pc.senders.length, 2, 'a video sender exists even on an audio call');
  assert.equal(pc.transceivers.length, 1, 'the trackless video m-line was negotiated');
  assert.equal(pc.transceivers[0].kind, 'video');
  assert.equal(pc.transceivers[0].sender.track, null, 'no camera track on the video sender yet');
});

test('startScreenShare replaces the video sender track via replaceTrack — no renegotiation', async () => {
  const screen = screenStream();
  const { engine, events, lastPc } = makeEngine({
    hasVideo: true,
    getDisplayMedia: async () => screen as unknown as MediaStream,
  });
  await engine.placeCall();
  await engine.provideAnswer('ANSWER');
  const pc = lastPc();
  const videoSenderBefore = pc.senders.find((s) => (s.track as unknown as FakeTrack).kind === 'video');
  assert.ok(videoSenderBefore);
  const cameraTrack = videoSenderBefore!.track;

  await engine.startScreenShare();

  assert.equal(engine.screenSharing, true);
  assert.equal(pc.senders.length, 2, 'no new sender — same video sender, track replaced');
  assert.equal(videoSenderBefore!.replaceTrackCalls.length, 1);
  assert.equal(videoSenderBefore!.track, screen.tracks[0], 'sender now carries the screen track');
  assert.notEqual(videoSenderBefore!.track, cameraTrack);
  assert.deepEqual(events.screenShareChanges, [true]);
  assert.equal(events.localVideoTrackChanges.at(-1), screen.tracks[0]);
});

test('startScreenShare while the camera is on turns the camera OFF (mutually exclusive) and sends videoEnabled true', async () => {
  const screen = screenStream();
  const { engine, mutedChannel } = makeEngine({
    hasVideo: true,
    getDisplayMedia: async () => screen as unknown as MediaStream,
  });
  await engine.placeCall();
  await engine.provideAnswer('ANSWER');
  assert.equal(engine.cameraEnabled, true, 'video call starts with the camera on');
  const channel = mutedChannel();
  channel.fireOpen();
  channel.sent.length = 0;

  await engine.startScreenShare();

  assert.equal(engine.screenSharing, true);
  assert.equal(engine.cameraEnabled, false, 'camera is OFF for real — the share owns the sender');
  assert.deepEqual(
    channel.sent.map((s) => JSON.parse(s)),
    [{ audioEnabled: true, videoEnabled: true }],
    'one send: video stays enabled (screen replaced camera)'
  );
});

test('stopScreenShare clears the outgoing video — never auto-restores the camera', async () => {
  const screen = screenStream();
  let cameraCalls = 0;
  const { engine, events, lastPc } = makeEngine({
    hasVideo: true,
    getUserMedia: async () => {
      cameraCalls += 1;
      return avStream() as unknown as MediaStream;
    },
    getDisplayMedia: async () => screen as unknown as MediaStream,
  });
  await engine.placeCall();
  await engine.provideAnswer('ANSWER');
  const pc = lastPc();
  await engine.startScreenShare();
  const videoSender = pc.senders.find((s) => s.track === (screen.tracks[0] as unknown as MediaStreamTrack));
  assert.ok(videoSender);

  await engine.stopScreenShare();

  assert.equal(engine.screenSharing, false);
  assert.equal(engine.cameraEnabled, false, 'camera stays off — no auto-restore');
  assert.equal(videoSender!.track, null, 'the sender is cleared, not restored');
  assert.equal(cameraCalls, 1, 'no camera reacquisition (only the initial one)');
  assert.equal(screen.tracks[0].stopped, true, 'the screen-capture track is stopped');
  assert.deepEqual(events.screenShareChanges, [true, false]);
  assert.equal(events.localVideoTrackChanges.at(-1), null);
});

test('toggleScreenShare flips between camera and screen', async () => {
  const screen = screenStream();
  const { engine } = makeEngine({
    hasVideo: true,
    getDisplayMedia: async () => screen as unknown as MediaStream,
  });
  await engine.placeCall();
  await engine.provideAnswer('ANSWER');

  await engine.toggleScreenShare();
  assert.equal(engine.screenSharing, true);
  await engine.toggleScreenShare();
  assert.equal(engine.screenSharing, false);
});

test('the browser\'s native "Stop sharing" (track ended) ends with video off — no camera restore', async () => {
  const screen = screenStream();
  let cameraCalls = 0;
  const { engine, events, lastPc } = makeEngine({
    hasVideo: true,
    getUserMedia: async () => {
      cameraCalls += 1;
      return avStream() as unknown as MediaStream;
    },
    getDisplayMedia: async () => screen as unknown as MediaStream,
  });
  await engine.placeCall();
  await engine.provideAnswer('ANSWER');
  await engine.startScreenShare();
  const pc = lastPc();
  const videoSender = pc.senders.find((s) => s.track === (screen.tracks[0] as unknown as MediaStreamTrack));

  screen.tracks[0].fireEnded(); // simulate the browser's native "Stop sharing" button
  await new Promise((r) => setTimeout(r, 0)); // let the fire-and-forget stopScreenShare() settle

  assert.equal(engine.screenSharing, false);
  assert.equal(engine.cameraEnabled, false, 'camera stays off');
  assert.equal(videoSender!.track, null, 'video cleared, not restored');
  assert.equal(cameraCalls, 1, 'no camera reacquisition');
  assert.deepEqual(events.screenShareChanges, [true, false]);
});

test('startScreenShare works on an audio-STARTED call (the video sender is always present)', async () => {
  const screen = screenStream();
  const { engine, events, lastPc } = makeEngine({
    // hasVideo defaults to false — audio-started call
    getDisplayMedia: async () => screen as unknown as MediaStream,
  });
  await engine.placeCall();
  await engine.provideAnswer('ANSWER');
  const pc = lastPc();
  // The always-present (trackless) video sender the audio call negotiated.
  const videoSender = pc.transceivers[0].sender;
  assert.equal(videoSender.track, null, 'trackless before sharing');

  await engine.startScreenShare();

  assert.equal(engine.screenSharing, true, 'screen share works on an audio-started call');
  assert.equal(events.screenShareErrors.length, 0);
  assert.equal(videoSender.replaceTrackCalls.length, 1, 'screen track replaced onto the video sender');
  assert.equal(videoSender.track, screen.tracks[0] as unknown as MediaStreamTrack);
  assert.deepEqual(events.screenShareChanges, [true]);
});

test('startScreenShare when getDisplayMedia is not provided reports onScreenShareError', async () => {
  const { engine, events } = makeEngine({ hasVideo: true }); // no getDisplayMedia override
  await engine.placeCall();
  await engine.provideAnswer('ANSWER');

  await engine.startScreenShare();

  assert.equal(events.screenShareErrors.length, 1);
  assert.match(events.screenShareErrors[0].message, /screen capture is not available/);
});

test('startScreenShare: user cancelling the browser share picker reports onScreenShareError, no call impact', async () => {
  const { engine, events } = makeEngine({
    hasVideo: true,
    getDisplayMedia: async () => {
      throw new Error('NotAllowedError');
    },
  });
  await engine.placeCall();
  await engine.provideAnswer('ANSWER');

  await engine.startScreenShare();

  assert.equal(engine.screenSharing, false);
  assert.equal(events.screenShareErrors.length, 1);
  assert.match(events.screenShareErrors[0].message, /NotAllowedError/);
  assert.equal(engine.state, 'connecting');
});

test('startScreenShare is a no-op while already sharing', async () => {
  const screen = screenStream();
  let getDisplayMediaCalls = 0;
  const { engine } = makeEngine({
    hasVideo: true,
    getDisplayMedia: async () => {
      getDisplayMediaCalls += 1;
      return screen as unknown as MediaStream;
    },
  });
  await engine.placeCall();
  await engine.provideAnswer('ANSWER');
  await engine.startScreenShare();

  await engine.startScreenShare(); // already sharing

  assert.equal(getDisplayMediaCalls, 1, 'getDisplayMedia only called once');
});

test('stopScreenShare is a no-op when not sharing', async () => {
  const { engine, events } = makeEngine({ hasVideo: true });
  await engine.placeCall();
  await engine.provideAnswer('ANSWER');

  await engine.stopScreenShare(); // never started

  assert.equal(events.screenShareChanges.length, 0);
  assert.equal(events.screenShareErrors.length, 0);
});

test('switchCamera replaces the video sender track via replaceTrack, no renegotiation', async () => {
  const gumCalls: MediaStreamConstraints[] = [];
  let call = 0;
  const { engine, lastPc } = makeEngine({
    hasVideo: true,
    getUserMedia: async (constraints) => {
      call += 1;
      gumCalls.push(constraints);
      return (call === 1 ? avStream() : new FakeStream([new FakeTrack('video')])) as unknown as MediaStream;
    },
  });
  await engine.placeCall();
  await engine.provideAnswer('ANSWER');
  const pc = lastPc();
  const videoSender = pc.senders.find((s) => (s.track as unknown as FakeTrack).kind === 'video');
  const originalTrack = videoSender!.track;

  await engine.switchCamera('cam-2');

  assert.equal(pc.senders.length, 2, 'no new sender/renegotiation');
  assert.equal(videoSender!.replaceTrackCalls.length, 1);
  assert.notEqual(videoSender!.track, originalTrack);
  assert.equal((originalTrack as unknown as FakeTrack).stopped, true);
  assert.equal(engine.videoInputDeviceId, 'cam-2');
  const constraints = gumCalls[1].video;
  assert.ok(typeof constraints === 'object' && 'deviceId' in constraints);
  assert.deepEqual((constraints as MediaTrackConstraints).deviceId, { exact: 'cam-2' });
});

test('switchCamera while screen sharing only records the preference (nothing live to replace)', async () => {
  const screen = screenStream();
  const { engine, lastPc } = makeEngine({
    hasVideo: true,
    getDisplayMedia: async () => screen as unknown as MediaStream,
  });
  await engine.placeCall();
  await engine.provideAnswer('ANSWER');
  await engine.startScreenShare();
  const pc = lastPc();
  const videoSender = pc.senders.find((s) => s.track === (screen.tracks[0] as unknown as MediaStreamTrack));
  const replaceTrackCallsBefore = videoSender!.replaceTrackCalls.length;

  await engine.switchCamera('cam-2');

  assert.equal(engine.videoInputDeviceId, 'cam-2', 'preference recorded');
  assert.equal(
    videoSender!.replaceTrackCalls.length,
    replaceTrackCallsBefore,
    'screen-share track untouched'
  );
  assert.equal(engine.screenSharing, true, 'still sharing');
});

test('switchCamera while the camera is off records the preference only (no getUserMedia); setCameraEnabled(true) then uses it', async () => {
  const gumCalls: MediaStreamConstraints[] = [];
  let call = 0;
  const { engine, events, lastPc } = makeEngine({
    // hasVideo: false — audio-started call, camera off.
    getUserMedia: async (constraints) => {
      call += 1;
      gumCalls.push(constraints);
      return (call === 1 ? micStream() : new FakeStream([new FakeTrack('video')])) as unknown as MediaStream;
    },
  });
  await engine.placeCall();
  await engine.provideAnswer('ANSWER');
  const videoSender = lastPc().transceivers[0].sender;
  assert.equal(engine.cameraEnabled, false);

  await engine.switchCamera('cam-2');

  assert.equal(events.deviceSwitchErrors.length, 0);
  assert.equal(engine.videoInputDeviceId, 'cam-2', 'preference recorded');
  assert.equal(engine.cameraEnabled, false, 'camera NOT turned on as a side effect');
  assert.equal(gumCalls.length, 1, 'no camera getUserMedia — only the initial mic');
  assert.equal(videoSender.replaceTrackCalls.length, 0, 'nothing put on the wire');

  await engine.setCameraEnabled(true);

  assert.equal(engine.cameraEnabled, true);
  assert.deepEqual(
    (gumCalls[1].video as MediaTrackConstraints).deviceId,
    { exact: 'cam-2' },
    'enabling the camera acquires the recorded device'
  );
});

// ── Camera toggle (M3: setCameraEnabled on any call) ──────────────────────────

test('setCameraEnabled(true) on an audio-started call attaches a camera track to the always-present video sender', async () => {
  const camera = new FakeTrack('video');
  let call = 0;
  const { engine, events, lastPc } = makeEngine({
    getUserMedia: async () => {
      call += 1;
      return (call === 1 ? micStream() : new FakeStream([camera])) as unknown as MediaStream;
    },
  });
  await engine.placeCall();
  await engine.provideAnswer('ANSWER');
  const pc = lastPc();
  const videoSender = pc.transceivers[0].sender;
  assert.equal(engine.cameraEnabled, false);

  await engine.setCameraEnabled(true);

  assert.equal(engine.cameraEnabled, true);
  assert.equal(videoSender.replaceTrackCalls.length, 1);
  assert.equal(videoSender.track, camera as unknown as MediaStreamTrack, 'camera on the video sender');
  assert.equal(events.localVideoTrackChanges.at(-1), camera as unknown as MediaStreamTrack);
  // No renegotiation — same two senders as before (audio + video).
  assert.equal(pc.senders.length, 2);
});

test('setCameraEnabled(false) removes the camera track and fires onLocalVideoTrackChanged(null)', async () => {
  const { engine, events, lastPc } = makeEngine({ hasVideo: true });
  await engine.placeCall();
  await engine.provideAnswer('ANSWER');
  const pc = lastPc();
  const videoSender = pc.senders.find((s) => (s.track as unknown as FakeTrack | null)?.kind === 'video');
  assert.ok(videoSender);
  assert.equal(engine.cameraEnabled, true, 'video call starts with the camera on');
  const cameraTrack = videoSender!.track as unknown as FakeTrack;

  await engine.setCameraEnabled(false);

  assert.equal(engine.cameraEnabled, false);
  assert.equal(videoSender!.replaceTrackCalls.at(-1), null, 'replaceTrack(null) clears the outgoing video');
  assert.equal(cameraTrack.stopped, true, 'the camera track is stopped');
  assert.equal(engine.localMediaStream!.getVideoTracks().length, 0, 'no video track left on the local stream');
  assert.equal(events.localVideoTrackChanges.at(-1), null, 'onLocalVideoTrackChanged(null) fired');
});

test('setCameraEnabled(false) while screen sharing is a no-op (camera is already off)', async () => {
  const screen = screenStream();
  const { engine, lastPc } = makeEngine({
    hasVideo: true,
    getDisplayMedia: async () => screen as unknown as MediaStream,
  });
  await engine.placeCall();
  await engine.provideAnswer('ANSWER');
  await engine.startScreenShare();
  const pc = lastPc();
  const videoSender = pc.senders.find((s) => s.track === (screen.tracks[0] as unknown as MediaStreamTrack));
  const replaceCallsBefore = videoSender!.replaceTrackCalls.length;

  await engine.setCameraEnabled(false);

  assert.equal(engine.cameraEnabled, false);
  assert.equal(engine.screenSharing, true, 'still sharing');
  assert.equal(videoSender!.replaceTrackCalls.length, replaceCallsBefore, 'screen track untouched');
});

test('setCameraEnabled(true) while screen sharing stops the share and turns the camera on', async () => {
  const screen = screenStream();
  let call = 0;
  const camera = new FakeTrack('video');
  const { engine, events, lastPc } = makeEngine({
    hasVideo: true,
    getUserMedia: async () => {
      call += 1;
      return (call === 1 ? avStream() : new FakeStream([camera])) as unknown as MediaStream;
    },
    getDisplayMedia: async () => screen as unknown as MediaStream,
  });
  await engine.placeCall();
  await engine.provideAnswer('ANSWER');
  await engine.startScreenShare();
  const pc = lastPc();
  const videoSender = pc.senders.find((s) => s.track === (screen.tracks[0] as unknown as MediaStreamTrack));
  assert.ok(videoSender);

  await engine.setCameraEnabled(true);

  assert.equal(engine.screenSharing, false, 'share stopped — mutually exclusive');
  assert.equal(engine.cameraEnabled, true);
  assert.equal(videoSender!.track, camera as unknown as MediaStreamTrack, 'camera on the SAME sender');
  assert.equal(screen.tracks[0].stopped, true, 'the capture is released');
  assert.deepEqual(events.screenShareChanges, [true, false]);
});

test('RACE: setCameraEnabled(true) in flight when hang up lands — new stream stopped, not adopted', async () => {
  const gum = deferred<MediaStream>();
  let call = 0;
  const { engine, lastPc } = makeEngine({
    getUserMedia: async () => {
      call += 1;
      return call === 1 ? (micStream() as unknown as MediaStream) : gum.promise;
    },
  });
  await engine.placeCall();
  await engine.provideAnswer('ANSWER');
  const pc = lastPc();
  const videoSender = pc.transceivers[0].sender;

  const enabling = engine.setCameraEnabled(true);
  engine.hangup(); // torn down while the camera getUserMedia is in flight
  const lateCamera = new FakeStream([new FakeTrack('video')]);
  gum.resolve(lateCamera as unknown as MediaStream);
  await enabling;

  assert.equal(engine.state, 'ended');
  assert.equal(videoSender.replaceTrackCalls.length, 0, 'replaceTrack never called after hang up');
  assert.equal(lateCamera.tracks[0].stopped, true, 'the orphaned camera stream is stopped');
});

test('RACE: screen share ending after hang up is a silent no-op', async () => {
  const screen = screenStream();
  const { engine, events } = makeEngine({
    hasVideo: true,
    getDisplayMedia: async () => screen as unknown as MediaStream,
  });
  await engine.placeCall();
  await engine.provideAnswer('ANSWER');
  await engine.startScreenShare();
  engine.hangup();

  await engine.stopScreenShare(); // must not throw, must not resurrect anything

  assert.equal(engine.state, 'ended');
  assert.deepEqual(events.screenShareChanges, [true]); // no extra "false" after hangup
});

test('RACE: startScreenShare in flight when hang up lands — capture is stopped, not adopted', async () => {
  const gdm = deferred<MediaStream>();
  const { engine, lastPc } = makeEngine({
    hasVideo: true,
    getDisplayMedia: () => gdm.promise,
  });
  await engine.placeCall();
  await engine.provideAnswer('ANSWER');
  const pc = lastPc();
  const videoSender = pc.senders.find((s) => (s.track as unknown as FakeTrack).kind === 'video');
  const originalTrack = videoSender!.track;

  const sharing = engine.startScreenShare();
  engine.hangup();
  const lateScreen = screenStream();
  gdm.resolve(lateScreen as unknown as MediaStream);
  await sharing;

  assert.equal(engine.state, 'ended');
  assert.equal(videoSender!.track, originalTrack, 'sender untouched — replaceTrack never called');
  assert.equal(lateScreen.tracks[0].stopped, true, 'the orphaned capture is stopped');
});

test('end() while screen sharing stops the capture track', async () => {
  const screen = screenStream();
  const { engine } = makeEngine({
    hasVideo: true,
    getDisplayMedia: async () => screen as unknown as MediaStream,
  });
  await engine.placeCall();
  await engine.provideAnswer('ANSWER');
  await engine.startScreenShare();

  engine.hangup();

  assert.equal(screen.tracks[0].stopped, true);
});

// ── Race freedom ──────────────────────────────────────────────────────────────

test('RACE: hang up while getUserMedia is in flight — stream stopped, no offer, ended', async () => {
  const gum = deferred<MediaStream>();
  const { engine, events, pcs } = makeEngine({ getUserMedia: () => gum.promise });

  const placing = engine.placeCall();
  assert.equal(engine.state, 'ringing');

  engine.hangup(); // teardown BEFORE the mic resolves
  assert.equal(engine.state, 'ended');

  const late = micStream();
  gum.resolve(late as unknown as MediaStream);
  await placing;

  assert.equal(engine.state, 'ended', 'a late getUserMedia must not resurrect the call');
  assert.deepEqual(events.offers, [], 'no offer emitted after hang up');
  assert.equal(late.tracks[0].stopped, true, 'the orphaned mic stream is stopped (no leak)');
  assert.equal(pcs.length, 0, 'no peer connection was created');
});

test('RACE: hang up while ICE gathering is in flight — no offer, ended, mic stopped', async () => {
  const gather = deferred<void>();
  const { engine, events, pcs } = makeEngine({ gather: () => gather.promise });

  const placing = engine.placeCall();
  // Flush microtasks so placeCall progresses past getUserMedia/createOffer and
  // parks at `await gathered` (the pc now exists; the gather promise is pending).
  await new Promise((r) => setTimeout(r, 0));
  const pc = pcs[pcs.length - 1];
  assert.ok(pc, 'peer connection created before gather resolves');

  engine.hangup();
  gather.resolve();
  await placing;

  assert.equal(engine.state, 'ended');
  assert.deepEqual(events.offers, [], 'gather resolving after hang up emits nothing');
  assert.equal(pc.closed, true);
});

test('RACE: hang up during the REAL ICE gather does not hang placeCall (abort settles it)', async () => {
  // Regression for the teardown/gather deadlock: use the real
  // gatherUntilEnoughIce (NOT an injected deferred) against a pc that never
  // emits a candidate and never completes gathering. Only the engine's
  // teardown AbortController can settle the gather; if it doesn't, `await
  // placeCall()` below hangs forever and the test times out.
  const { engine, events, pcs } = makeEngine({ gather: gatherUntilEnoughIce });

  const placing = engine.placeCall();
  // Park at `await gathered`: pc exists, gather promise is pending (no
  // candidate will ever arrive; the fake reports 'complete' but never fires
  // icegatheringstatechange, so none of the real racers settle on their own).
  await new Promise((r) => setTimeout(r, 0));
  const pc = pcs[pcs.length - 1];
  assert.ok(pc, 'peer connection created before gather resolves');

  engine.hangup(); // must abort the gather so `placing` can resolve
  await placing; // hangs (test times out) if the abort wiring is missing

  assert.equal(engine.state, 'ended');
  assert.deepEqual(events.offers, [], 'no offer emitted after hang up');
  assert.equal(pc.closed, true);
});

test('RACE: late connectionstatechange after hang up is ignored', async () => {
  const { engine, lastPc } = makeEngine();
  await engine.placeCall();
  await engine.provideAnswer('ANSWER');
  const pc = lastPc();
  engine.hangup();
  assert.equal(engine.state, 'ended');
  // The pc emits a stray 'connected' after we already tore down (listener was
  // removed, but assert direct call is harmless too).
  pc.fireConnectionState('connected');
  assert.equal(engine.state, 'ended', 'must not resurrect to connected');
});

test('RACE: provideAnswer after hang up is a silent no-op', async () => {
  const { engine } = makeEngine();
  await engine.placeCall();
  engine.hangup();
  await engine.provideAnswer('ANSWER'); // must not throw, must not change state
  assert.equal(engine.state, 'ended');
});

test('peer connection "failed" tears the call down to ended', async () => {
  const { engine, lastPc } = makeEngine();
  await engine.placeCall();
  await engine.provideAnswer('ANSWER');
  const pc = lastPc();
  pc.fireConnectionState('failed');
  assert.equal(engine.state, 'ended');
  assert.equal(pc.closed, true);
});

// ── Errors ────────────────────────────────────────────────────────────────────

test('getUserMedia rejection ends the call and reports onError', async () => {
  const { engine, events } = makeEngine({
    getUserMedia: () => Promise.reject(new Error('NotAllowedError')),
  });
  await engine.placeCall();
  assert.equal(engine.state, 'ended');
  assert.equal(events.errors.length, 1);
  assert.match(events.errors[0].message, /NotAllowedError/);
});

test('end() is idempotent', async () => {
  const { engine, events, lastPc } = makeEngine();
  await engine.placeCall();
  engine.end();
  engine.end();
  engine.hangup();
  assert.equal(engine.state, 'ended');
  // Only one 'ended' notification despite three teardown calls.
  assert.equal(events.states.filter((s) => s === 'ended').length, 1);
  assert.equal(lastPc().closed, true);
});

// ── Guard rails ───────────────────────────────────────────────────────────────

test('placeCall twice throws (one call per engine)', async () => {
  const { engine } = makeEngine();
  await engine.placeCall();
  await assert.rejects(() => engine.placeCall(), /expected idle/);
});

test('accept without an incoming call throws', async () => {
  const { engine } = makeEngine();
  await assert.rejects(() => engine.accept(), /not an incoming call/);
});

test('receiveCall rejects an empty offer payload', () => {
  const { engine } = makeEngine();
  assert.throws(() => engine.receiveCall(''), /non-empty SDP/);
});

// ── Connection route (M5) ──────────────────────────────────────────────────────

test('getConnectionRoute: unknown before any call is placed (no peer connection yet)', async () => {
  const { engine } = makeEngine();
  assert.equal(await engine.getConnectionRoute(), 'unknown');
});

test('getConnectionRoute: reflects the live pc\'s active candidate pair once connected', async () => {
  const { engine, lastPc } = makeEngine();
  await engine.placeCall();
  await engine.provideAnswer('ANSWER_FROM_PEER');
  const pc = lastPc();
  pc.fireConnectionState('connected');

  pc.statsReport = new Map([
    ['local1', { id: 'local1', type: 'local-candidate', candidateType: 'relay' }],
    ['remote1', { id: 'remote1', type: 'remote-candidate', candidateType: 'srflx' }],
    [
      'pair1',
      {
        id: 'pair1',
        type: 'candidate-pair',
        state: 'succeeded',
        nominated: true,
        localCandidateId: 'local1',
        remoteCandidateId: 'remote1',
      },
    ],
  ]);
  assert.equal(await engine.getConnectionRoute(), 'relay');

  pc.statsReport = new Map([
    ['local1', { id: 'local1', type: 'local-candidate', candidateType: 'host' }],
    ['remote1', { id: 'remote1', type: 'remote-candidate', candidateType: 'host' }],
    [
      'pair1',
      {
        id: 'pair1',
        type: 'candidate-pair',
        state: 'succeeded',
        nominated: true,
        localCandidateId: 'local1',
        remoteCandidateId: 'remote1',
      },
    ],
  ]);
  assert.equal(await engine.getConnectionRoute(), 'direct');
});

test('getConnectionRoute: unknown again after the call ends (pc torn down)', async () => {
  const { engine, lastPc } = makeEngine();
  await engine.placeCall();
  const pc = lastPc();
  pc.statsReport = new Map([
    ['local1', { id: 'local1', type: 'local-candidate', candidateType: 'host' }],
    ['remote1', { id: 'remote1', type: 'remote-candidate', candidateType: 'host' }],
    [
      'pair1',
      {
        id: 'pair1',
        type: 'candidate-pair',
        state: 'succeeded',
        nominated: true,
        localCandidateId: 'local1',
        remoteCandidateId: 'remote1',
      },
    ],
  ]);
  assert.equal(await engine.getConnectionRoute(), 'direct');

  engine.end();
  assert.equal(await engine.getConnectionRoute(), 'unknown', 'no live pc to query once ended');
});

// ── mutedState / iceTrickling data channels ───────────────────────────────────

test('the negotiated data channels are created with ids 1 and 3 on the OFFER path', async () => {
  const { engine, lastPc } = makeEngine();
  await engine.placeCall();

  assert.deepEqual(
    lastPc().dataChannels.map((c) => [c.label, c.options]),
    [
      ['iceTrickling', { negotiated: true, id: 1 }],
      ['mutedState', { negotiated: true, id: 3 }],
    ]
  );
});

test('the negotiated data channels are created with ids 1 and 3 on the ANSWER path', async () => {
  const { engine, lastPc } = makeEngine();
  engine.receiveCall('OFFER_FROM_PEER');
  await engine.accept();

  assert.deepEqual(
    lastPc().dataChannels.map((c) => [c.label, c.options]),
    [
      ['iceTrickling', { negotiated: true, id: 1 }],
      ['mutedState', { negotiated: true, id: 3 }],
    ]
  );
});

test('mutedState open sends the current local state (nothing sent while the channel is not open)', async () => {
  const { engine, mutedChannel } = makeEngine();
  await engine.placeCall();
  engine.setMuted(true); // channel not open yet — must not send (or throw)
  const channel = mutedChannel();
  assert.deepEqual(channel.sent, [], 'no send before the channel opens');

  channel.fireOpen();

  assert.deepEqual(JSON.parse(channel.sent[0]), { audioEnabled: false, videoEnabled: false });
});

test('every mute/camera/screen-share flip pushes the new state over mutedState', async () => {
  const screen = screenStream();
  let call = 0;
  const { engine, mutedChannel } = makeEngine({
    getUserMedia: async () => {
      call += 1;
      return (call === 1 ? micStream() : new FakeStream([new FakeTrack('video')])) as unknown as MediaStream;
    },
    getDisplayMedia: async () => screen as unknown as MediaStream,
  });
  await engine.placeCall();
  await engine.provideAnswer('ANSWER');
  const channel = mutedChannel();
  channel.fireOpen();
  channel.sent.length = 0; // drop the on-open snapshot

  engine.setMuted(true);
  await engine.setCameraEnabled(true);
  await engine.startScreenShare(); // camera flips OFF (mutually exclusive)
  await engine.stopScreenShare(); // no camera restore — video goes off
  engine.setMuted(false);
  await engine.setCameraEnabled(true);

  assert.deepEqual(
    channel.sent.map((s) => JSON.parse(s)),
    [
      { audioEnabled: false, videoEnabled: false }, // muted
      { audioEnabled: false, videoEnabled: true }, // camera on
      { audioEnabled: false, videoEnabled: true }, // share started (screen replaced camera)
      { audioEnabled: false, videoEnabled: false }, // share stopped — video off, no restore
      { audioEnabled: true, videoEnabled: false }, // unmuted
      { audioEnabled: true, videoEnabled: true }, // camera back on explicitly
    ]
  );
});

test('incoming mutedState messages drive onRemoteVideoActiveChanged/onRemoteAudioMutedChanged, deduped; malformed ignored', async () => {
  const { engine, events, mutedChannel } = makeEngine();
  await engine.placeCall();
  const channel = mutedChannel();

  channel.fireMessage('{not json');
  channel.fireMessage('42'); // valid JSON but not an object
  channel.fireMessage('null');
  channel.fireMessage(12345); // non-string data
  assert.deepEqual(events.remoteVideoActive, [], 'malformed payloads are ignored');
  assert.deepEqual(events.remoteAudioMuted, []);

  channel.fireMessage(JSON.stringify({ audioEnabled: true, videoEnabled: true }));
  channel.fireMessage(JSON.stringify({ audioEnabled: true, videoEnabled: true })); // duplicate
  channel.fireMessage(JSON.stringify({ audioEnabled: false, videoEnabled: false }));

  assert.deepEqual(events.remoteVideoActive, [true, false], 'deduped');
  assert.deepEqual(events.remoteAudioMuted, [false, true], 'muted = !audioEnabled, deduped');
});

// ── Remote-video signal: track fallback vs mutedState precedence ──────────────

test('remote video track events are the pre-message fallback; mutedState messages override them once received', async () => {
  const { engine, events, lastPc, mutedChannel } = makeEngine();
  await engine.placeCall();
  const remoteVideo = new FakeTrack('video');
  const remote = new FakeStream([new FakeTrack('audio'), remoteVideo]);
  lastPc().fireTrack(remote as unknown as MediaStream);
  assert.deepEqual(events.remoteVideoActive, [true], 'initialized from the live unmuted track');

  remoteVideo.fireMute();
  remoteVideo.fireUnmute();
  assert.deepEqual(events.remoteVideoActive, [true, false, true], 'track events drive the fallback');

  mutedChannel().fireMessage(JSON.stringify({ audioEnabled: true, videoEnabled: false }));
  assert.deepEqual(events.remoteVideoActive, [true, false, true, false], 'message is authoritative');

  remoteVideo.fireUnmute(); // messages own the signal now — ignored
  remoteVideo.fireMute();
  assert.deepEqual(events.remoteVideoActive, [true, false, true, false]);
});

test('remote video track "ended" clears the fallback signal; an audio-only remote stream initializes it inactive', async () => {
  const { engine, events, lastPc } = makeEngine();
  await engine.placeCall();
  const pc = lastPc();
  pc.fireTrack(micStream() as unknown as MediaStream);
  assert.deepEqual(events.remoteVideoActive, [false], 'no remote video track → inactive');

  const remoteVideo = new FakeTrack('video');
  pc.fireTrack(new FakeStream([remoteVideo]) as unknown as MediaStream);
  assert.deepEqual(events.remoteVideoActive, [false, true]);

  remoteVideo.fireEnded();
  assert.deepEqual(events.remoteVideoActive, [false, true, false]);
});

// ── D diagnostics (post-connect video negotiation observability) ──────────────

test('D diagnostic: warns once when the peer negotiated no video m-line (videoSender null)', async (t) => {
  const warns: string[] = [];
  t.mock.method(console, 'warn', (...args: unknown[]) => {
    warns.push(args.map(String).join(' '));
  });
  // Audio-started ANSWERER whose peer offered no video m-line: no seeded
  // sender to adopt, and an answer cannot add one → videoSender stays null.
  const { engine, lastPc } = makeEngine();
  engine.receiveCall('OFFER_FROM_PEER');
  await engine.accept();

  lastPc().fireConnectionState('connected');
  lastPc().fireConnectionState('connected'); // once per call, not per event

  assert.equal(warns.length, 1);
  assert.match(warns[0], /no video m-line/);
});

test('D diagnostic: warns when the negotiated video direction excludes send (recvonly)', async (t) => {
  const warns: string[] = [];
  t.mock.method(console, 'warn', (...args: unknown[]) => {
    warns.push(args.map(String).join(' '));
  });
  const { engine, lastPc } = makeEngine({ seedRemoteVideoSender: true });
  engine.receiveCall('OFFER_FROM_PEER');
  await engine.accept();
  const pc = lastPc();
  // Despite our sendrecv ask, negotiation left the m-line recvonly.
  pc.transceivers.find((tr) => tr.sender === pc.seededVideoSender)!.currentDirection = 'recvonly';

  pc.fireConnectionState('connected');

  assert.equal(warns.length, 1);
  assert.match(warns[0], /no send direction/);
});

test('D diagnostic: silent on a normally negotiated call (sendrecv)', async (t) => {
  const warns: unknown[] = [];
  t.mock.method(console, 'warn', (...args: unknown[]) => {
    warns.push(args);
  });
  const { engine, lastPc } = makeEngine();
  await engine.placeCall();
  await engine.provideAnswer('ANSWER');
  const pc = lastPc();
  pc.transceivers[0].currentDirection = 'sendrecv';

  pc.fireConnectionState('connected');

  assert.deepEqual(warns, []);
});

// ── iOS/ssrc: disabled placeholder video track ────────────────────────────────
//
// With a `createPlaceholderVideoTrack` factory the always-negotiated video
// sender carries a disabled black track (so the SDP has a real a=ssrc) instead
// of being trackless — WebKit can't demux RTP on an unsignaled SSRC. All tests
// above run WITHOUT the factory (old trackless behavior) and must stay green.

test('iOS/ssrc: audio-started OFFERER addTrack()s the placeholder (real a=ssrc), no addTransceiver, camera stays off', async () => {
  const placeholder = new FakeTrack('video');
  const { engine, lastPc } = makeEngine({ makePlaceholderTrack: () => placeholder });
  await engine.placeCall();

  const pc = lastPc();
  assert.ok(
    pc.addedTracks.includes(placeholder as unknown as MediaStreamTrack),
    'the placeholder was addTrack()ed so the offer carries a real a=ssrc'
  );
  assert.equal(pc.addTransceiverCount, 0, 'addTrack replaced the trackless addTransceiver');
  const videoSender = pc.senders.find(
    (s) => s.track === (placeholder as unknown as MediaStreamTrack)
  );
  assert.ok(videoSender, 'the video sender carries the placeholder track');
  assert.equal(engine.cameraEnabled, false, 'placeholder is not the camera');
});

test('iOS/ssrc: audio-started ANSWERER replaceTrack()s the placeholder onto the adopted sender before the answer', async () => {
  const placeholder = new FakeTrack('video');
  const { engine, lastPc } = makeEngine({
    seedRemoteVideoSender: true,
    makePlaceholderTrack: () => placeholder,
  });
  engine.receiveCall('OFFER_FROM_PEER');
  await engine.accept();

  const pc = lastPc();
  assert.equal(pc.addTransceiverCount, 0, 'no addTransceiver on the answer side');
  assert.deepEqual(
    pc.seededVideoSender!.replaceTrackCalls,
    [placeholder as unknown as MediaStreamTrack],
    'placeholder replaced onto the adopted sender (before createAnswer)'
  );
  assert.deepEqual(
    pc.seededVideoSender!.setStreamsCalls,
    [[engine.localMediaStream]],
    'still associates the local stream (msid) as before'
  );
});

test('iOS/ssrc: setCameraEnabled(false) restores the placeholder (not null) and never stops it', async () => {
  const placeholder = new FakeTrack('video');
  const camera = new FakeTrack('video');
  let call = 0;
  const { engine, lastPc } = makeEngine({
    makePlaceholderTrack: () => placeholder,
    getUserMedia: async () => {
      call += 1;
      return (call === 1 ? micStream() : new FakeStream([camera])) as unknown as MediaStream;
    },
  });
  await engine.placeCall();
  await engine.provideAnswer('ANSWER');
  const pc = lastPc();
  const videoSender = pc.senders.find(
    (s) => s.track === (placeholder as unknown as MediaStreamTrack)
  )!;

  await engine.setCameraEnabled(true);
  assert.equal(videoSender.track, camera as unknown as MediaStreamTrack, 'camera on the sender');

  await engine.setCameraEnabled(false);
  assert.equal(
    videoSender.replaceTrackCalls.at(-1),
    placeholder as unknown as MediaStreamTrack,
    'camera-off restores the placeholder, not null (keeps the a=ssrc signaled)'
  );
  assert.equal(placeholder.stopped, false, 'the placeholder is reused across swaps, never stopped');
});

test('iOS/ssrc: teardown stops the placeholder track', async () => {
  const placeholder = new FakeTrack('video');
  const { engine } = makeEngine({ makePlaceholderTrack: () => placeholder });
  await engine.placeCall();
  assert.equal(placeholder.stopped, false);

  engine.hangup();

  assert.equal(placeholder.stopped, true, 'the placeholder is released on teardown');
});

test('iOS/ssrc: a lone placeholder does not count as video in mutedState (videoEnabled stays false)', async () => {
  const placeholder = new FakeTrack('video');
  const { engine, mutedChannel } = makeEngine({ makePlaceholderTrack: () => placeholder });
  await engine.placeCall();
  const channel = mutedChannel();

  channel.fireOpen();

  assert.deepEqual(
    JSON.parse(channel.sent[0]),
    { audioEnabled: true, videoEnabled: false },
    'placeholder alone (no camera/screen) reports videoEnabled false'
  );
});

// ── Firefox/H264: videoCodecPreferences ───────────────────────────────────────
//
// Firefox negotiates H264 via the on-demand OpenH264 GMP plugin and silently
// encodes nothing when it's unavailable — the platform layer passes codec
// preferences that exclude H264 so negotiation lands on VP8. The engine applies
// them to the video transceiver before createOffer/createAnswer.

const VIDEO_CODEC_PREFS: RTCRtpCodec[] = [
  { mimeType: 'video/VP8', clockRate: 90000 },
];

test('videoCodecPreferences: audio-started OFFERER applies them to the video transceiver (trackless path)', async () => {
  const { engine, lastPc } = makeEngine({ videoCodecPreferences: VIDEO_CODEC_PREFS });
  await engine.placeCall();

  const pc = lastPc();
  const videoTransceiver = pc.transceivers.find((t) => t.kind === 'video');
  assert.ok(videoTransceiver, 'the video transceiver exists');
  assert.deepEqual(
    videoTransceiver!.setCodecPreferencesCalls,
    [VIDEO_CODEC_PREFS],
    'preferences applied to the video transceiver before the offer'
  );
});

test('videoCodecPreferences: audio-started ANSWERER applies them to the adopted sender before the answer', async () => {
  const { engine, lastPc } = makeEngine({
    seedRemoteVideoSender: true,
    videoCodecPreferences: VIDEO_CODEC_PREFS,
  });
  engine.receiveCall('OFFER_FROM_PEER');
  await engine.accept();

  const pc = lastPc();
  const videoTransceiver = pc.transceivers.find((t) => t.sender === pc.seededVideoSender);
  assert.ok(videoTransceiver, 'the adopted peer-offered video transceiver exists');
  assert.deepEqual(
    videoTransceiver!.setCodecPreferencesCalls,
    [VIDEO_CODEC_PREFS],
    'preferences applied to the adopted video transceiver before the answer'
  );
  assert.deepEqual(pc.localDescription, { type: 'answer', sdp: 'ANSWER_SDP' }, 'answer still produced');
});

test('videoCodecPreferences: camera-at-start applies them to the video transceiver', async () => {
  const { engine, lastPc } = makeEngine({
    hasVideo: true,
    videoCodecPreferences: VIDEO_CODEC_PREFS,
  });
  await engine.placeCall();

  const pc = lastPc();
  const videoTransceiver = pc.transceivers.find((t) => t.kind === 'video');
  assert.ok(videoTransceiver, 'the camera video transceiver exists');
  assert.deepEqual(videoTransceiver!.setCodecPreferencesCalls, [VIDEO_CODEC_PREFS]);
});

test('videoCodecPreferences: absent — setCodecPreferences is never called', async () => {
  const { engine, lastPc } = makeEngine(); // no videoCodecPreferences
  await engine.placeCall();

  const pc = lastPc();
  const videoTransceiver = pc.transceivers.find((t) => t.kind === 'video');
  assert.deepEqual(
    videoTransceiver!.setCodecPreferencesCalls,
    [],
    'nothing applied when the option is unset'
  );
});

test('videoCodecPreferences: a throwing setCodecPreferences never breaks the call', async () => {
  const { engine, events } = makeEngine({
    videoCodecPreferences: VIDEO_CODEC_PREFS,
    throwOnSetCodecPreferences: true,
  });

  await engine.placeCall();

  assert.equal(engine.state, 'ringing', 'call still reaches ringing despite the throw');
  assert.deepEqual(events.offers, ['OFFER_SDP'], 'the offer is still produced');
  assert.deepEqual(events.errors, [], 'not reported as a fatal error');
});
