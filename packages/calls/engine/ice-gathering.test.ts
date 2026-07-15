import { test } from 'node:test';
import assert from 'node:assert/strict';

import { gatherUntilEnoughIce, hasTurnServer } from './ice-gathering.ts';
import type { GatheringPeerConnection } from './ice-gathering.ts';

type CandidateListener = (event: { candidate: { type: string } | null }) => void;

/** Minimal fake RTCPeerConnection driving the gathering heuristic. */
class FakePc implements GatheringPeerConnection {
  iceGatheringState: RTCIceGatheringState = 'gathering';
  private candidateListeners = new Set<CandidateListener>();
  private stateListeners = new Set<() => void>();
  private configuration: RTCConfiguration;
  // Plain field + assignment, not a constructor parameter property: Node's
  // type-stripping test runner can't lower parameter properties — see
  // `erasableSyntaxOnly` in tsconfig.base.json.
  constructor(configuration: RTCConfiguration) {
    this.configuration = configuration;
  }

  getConfiguration(): RTCConfiguration {
    return this.configuration;
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  addEventListener(type: string, listener: any): void {
    if (type === 'icecandidate') this.candidateListeners.add(listener);
    else this.stateListeners.add(listener);
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  removeEventListener(type: string, listener: any): void {
    if (type === 'icecandidate') this.candidateListeners.delete(listener);
    else this.stateListeners.delete(listener);
  }

  emitCandidate(type: string | null): void {
    const event = { candidate: type === null ? null : ({ type } as { type: string }) };
    for (const l of [...this.candidateListeners]) l(event);
  }
  complete(): void {
    this.iceGatheringState = 'complete';
    for (const l of [...this.stateListeners]) l();
  }
  listenerCount(): number {
    return this.candidateListeners.size + this.stateListeners.size;
  }
}

const TURN_CONFIG: RTCConfiguration = {
  iceServers: [{ urls: ['stun:stun.example:3478', 'turn:relay.example:3478'] }],
};
const NO_TURN_CONFIG: RTCConfiguration = {
  iceServers: [{ urls: 'stun:stun.example:3478' }],
};
// Resolve `setTimeout` settle delays immediately so tests are deterministic.
const immediateTimers = { setTimeoutFn: (cb: () => void) => (cb(), 0), clearTimeoutFn: () => {} };

test('hasTurnServer detects turn: and turns: across string and array urls', () => {
  assert.equal(hasTurnServer(TURN_CONFIG), true);
  assert.equal(hasTurnServer(NO_TURN_CONFIG), false);
  assert.equal(hasTurnServer({ iceServers: [{ urls: 'turns:secure.example:5349' }] }), true);
  assert.equal(hasTurnServer({ iceServers: [] }), false);
  assert.equal(hasTurnServer(undefined), false);
});

test('resolves shortly after the first relay candidate (TURN happy path)', async () => {
  const pc = new FakePc(TURN_CONFIG);
  const p = gatherUntilEnoughIce(pc, immediateTimers);
  // A host + srflx candidate should NOT satisfy when a TURN server is configured.
  pc.emitCandidate('host');
  pc.emitCandidate('srflx');
  // The relay candidate is what unblocks us.
  pc.emitCandidate('relay');
  await p; // resolves — otherwise the test times out.
});

test('with a TURN server, a bare srflx candidate is NOT enough (waits for relay/complete)', async () => {
  const pc = new FakePc(TURN_CONFIG);
  let resolved = false;
  const p = gatherUntilEnoughIce(pc, immediateTimers).then(() => (resolved = true));
  pc.emitCandidate('srflx');
  await Promise.resolve();
  assert.equal(resolved, false, 'srflx alone must not resolve when TURN is available');
  pc.complete(); // gathering-complete fallback unblocks it
  await p;
  assert.equal(resolved, true);
});

test('without a TURN server, a srflx candidate is enough', async () => {
  const pc = new FakePc(NO_TURN_CONFIG);
  const p = gatherUntilEnoughIce(pc, immediateTimers);
  pc.emitCandidate('host'); // not enough
  pc.emitCandidate('srflx'); // enough (no TURN configured)
  await p;
});

test('falls back to iceGatheringState "complete" (the "or timeout") when no useful candidate', async () => {
  const pc = new FakePc(TURN_CONFIG);
  const p = gatherUntilEnoughIce(pc, immediateTimers);
  pc.emitCandidate('host');
  pc.complete();
  await p;
});

test('optional overallTimeoutMs resolves even if nothing gathers', async () => {
  const pc = new FakePc(TURN_CONFIG);
  await gatherUntilEnoughIce(pc, { ...immediateTimers, overallTimeoutMs: 5 });
});

test('removes all its listeners after settling (no leaks)', async () => {
  const pc = new FakePc(NO_TURN_CONFIG);
  const p = gatherUntilEnoughIce(pc, immediateTimers);
  pc.emitCandidate('srflx');
  await p;
  assert.equal(pc.listenerCount(), 0, 'all listeners cleaned up');
});
