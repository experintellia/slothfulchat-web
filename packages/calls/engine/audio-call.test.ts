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
  constructor(kind = 'audio') {
    this.kind = kind;
  }
  stop(): void {
    this.stopped = true;
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
}

function micStream(): FakeStream {
  return new FakeStream([new FakeTrack('audio')]);
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
  constructor(track: MediaStreamTrack | null) {
    this.track = track;
  }
  async replaceTrack(track: MediaStreamTrack | null): Promise<void> {
    this.replaceTrackCalls.push(track);
    this.track = track;
  }
}

/** A controllable fake peer connection satisfying PeerConnectionLike. */
class FakePc implements PeerConnectionLike {
  connectionState: RTCPeerConnectionState = 'new';
  localDescription: { type: string; sdp: string } | null = null;
  remoteDescription: RTCSessionDescriptionInit | null = null;
  closed = false;
  addedTracks: unknown[] = [];
  senders: FakeSender[] = [];
  configuration: RTCConfiguration;
  private connListeners = new Set<() => void>();
  private trackListeners = new Set<(e: { streams: ReadonlyArray<MediaStream> }) => void>();

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
  }
  addTrack(track: MediaStreamTrack): unknown {
    this.addedTracks.push(track);
    const sender = new FakeSender(track);
    this.senders.push(sender);
    return sender;
  }
  getSenders(): FakeSender[] {
    return this.senders;
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
    for (const l of [...this.trackListeners]) l({ streams: [stream] });
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
    gather?: AudioCallOptions['gather'];
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
  };
  const pcs: FakePc[] = [];
  const defaultGetUserMedia = async () => micStream() as unknown as MediaStream;

  const engine = new AudioCallEngine({
    iceServers: ICE_SERVERS,
    gather: overrides.gather ?? (async () => {}),
    factories: {
      getUserMedia: overrides.getUserMedia ?? defaultGetUserMedia,
      createPeerConnection: (config) => {
        const pc = new FakePc(config);
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
    },
  });
  return { engine, events, pcs, lastPc: () => pcs[pcs.length - 1] };
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

  assert.equal(pc.senders.length, 1, 'no new sender/renegotiation — same sender, track replaced');
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
