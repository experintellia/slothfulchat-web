/**
 * Non-trickle ICE gathering, ported faithfully from upstream
 * `deltachat/calls-webapp` `gatheredEnoughIce()` (`src/lib/calls.ts`).
 *
 * WHY non-trickle: the offer/answer travels as a (slow, store-and-forward)
 * DeltaChat message, so there is no live channel to trickle candidates over
 * before connecting. We must therefore embed candidates INTO the SDP before
 * sending it. We don't wait for gathering to fully complete (that can hang on
 * bad networks); we send as soon as we have "enough".
 *
 * "Enough" (a `Promise.race`, first to settle wins):
 *   1. gotRelayCandidate  — first `icecandidate` with `type === "relay"` (TURN),
 *      then a `RELAY_CANDIDATE_SETTLE_MS` (0ms) tick. Because of
 *      `bundlePolicy: "max-bundle"` only one relay candidate is expected, and a
 *      relay candidate essentially guarantees connectivity. This is the happy
 *      path when a TURN server is configured (Delta Chat's `ice_servers()`
 *      always returns a chatmail TURN relay).
 *   2. gotSrflxCandidate  — first `srflx` (STUN) candidate + a
 *      `SRFLX_CANDIDATE_SETTLE_MS` (150ms) settle. ONLY entered into the race
 *      when NO TURN server is configured. "Fail fast / succeed fast".
 *   3. iceGatheringComplete — `iceGatheringState === "complete"`. This is the
 *      "or timeout" fallback: upstream has NO wall-clock timer; the natural end
 *      of gathering is the backstop. (An optional `overallTimeoutMs` escape
 *      hatch is offered below; it defaults OFF so behavior matches upstream.)
 *
 * CRITICAL ORDERING: call this BEFORE `setLocalDescription`, so the candidate
 * listeners are attached before candidates start flowing. Upstream warns about
 * exactly this and does:
 *      const gatheredEnoughIceP = gatheredEnoughIce(pc);
 *      ... addTrack ...
 *      pc.setLocalDescription(await pc.createOffer());
 *      await gatheredEnoughIceP;
 *      const offer = pc.localDescription!.sdp;
 *
 * Pure module: no DOM/React imports. WebRTC types are ambient (erased at
 * runtime); the function operates on a minimal structural `pc` so it is
 * unit-testable with a fake.
 */

import { RELAY_CANDIDATE_SETTLE_MS, SRFLX_CANDIDATE_SETTLE_MS } from './constants.ts';

/**
 * The subset of `RTCPeerConnection` that {@link gatherUntilEnoughIce} touches.
 * A real `RTCPeerConnection` is assignable to this; so is a test fake.
 */
export interface GatheringPeerConnection {
  readonly iceGatheringState: RTCIceGatheringState;
  getConfiguration(): RTCConfiguration;
  addEventListener(
    type: 'icecandidate',
    listener: (event: { candidate: RTCIceCandidate | null }) => void
  ): void;
  addEventListener(type: 'icegatheringstatechange', listener: () => void): void;
  removeEventListener(
    type: 'icecandidate',
    listener: (event: { candidate: RTCIceCandidate | null }) => void
  ): void;
  removeEventListener(type: 'icegatheringstatechange', listener: () => void): void;
}

export interface GatherOptions {
  /**
   * OPTIONAL, defaults to disabled to stay byte-identical with upstream. A hard
   * wall-clock cap (ms): if neither a satisfying candidate nor gathering
   * completion happens in time, resolve anyway with whatever is in the SDP.
   * Use only as a safety net on pathological networks.
   */
  overallTimeoutMs?: number;
  /** Injectable timers for deterministic tests. Default: global set/clear. */
  setTimeoutFn?: (cb: () => void, ms: number) => unknown;
  clearTimeoutFn?: (handle: unknown) => void;
  /**
   * Optional abort. When it fires, gathering resolves immediately and every
   * candidate/state listener is detached. Without this, a caller that tears the
   * call down while parked at `await gatherUntilEnoughIce(pc)` would wait
   * forever: a closed `pc` emits no further `icecandidate` /
   * `icegatheringstatechange` events and never reaches `iceGatheringState ===
   * "complete"`, so none of the racers below would ever settle — leaking this
   * promise and the (closed) `pc` it closes over. The engine wires this to its
   * teardown (see audio-call.ts).
   */
  signal?: AbortSignal;
}

/** True if any configured ICE server has a `turn:`/`turns:` URL. */
export function hasTurnServer(configuration: RTCConfiguration | undefined): boolean {
  const iceServers = configuration?.iceServers;
  if (iceServers == undefined) {
    return false;
  }
  const isTurn = (u: string) => u.startsWith('turn:') || u.startsWith('turns:');
  return iceServers.some((s) =>
    typeof s.urls === 'string' ? isTurn(s.urls) : s.urls.some(isTurn)
  );
}

/**
 * Resolves once "enough" ICE has been gathered to send the local description.
 * See the module doc for the exact heuristic. Faithful to upstream, with the
 * `turns:` URL also treated as TURN (upstream only checks `turn:`) and an
 * opt-in overall timeout.
 */
export function gatherUntilEnoughIce(
  pc: GatheringPeerConnection,
  options: GatherOptions = {}
): Promise<void> {
  const setTimeoutFn = options.setTimeoutFn ?? ((cb, ms) => setTimeout(cb, ms));
  const clearTimeoutFn = options.clearTimeoutFn ?? ((h) => clearTimeout(h as never));

  const cleanups: Array<() => void> = [];
  const runCleanups = () => {
    for (const c of cleanups.splice(0)) {
      c();
    }
  };

  const gotRelayCandidate = new Promise<void>((resolve) => {
    const listener = (event: { candidate: RTCIceCandidate | null }) => {
      if (event.candidate != null && event.candidate.type === 'relay') {
        // Small settle in case candidates arrive in a burst; only one relay
        // candidate is expected thanks to max-bundle.
        setTimeoutFn(resolve, RELAY_CANDIDATE_SETTLE_MS);
        pc.removeEventListener('icecandidate', listener);
      }
    };
    pc.addEventListener('icecandidate', listener);
    cleanups.push(() => pc.removeEventListener('icecandidate', listener));
  });

  const gotSrflxCandidate = new Promise<void>((resolve) => {
    const listener = (event: { candidate: RTCIceCandidate | null }) => {
      if (event.candidate != null && event.candidate.type === 'srflx') {
        // Wait a bit longer than for relay: several srflx candidates may arrive.
        setTimeoutFn(resolve, SRFLX_CANDIDATE_SETTLE_MS);
        pc.removeEventListener('icecandidate', listener);
      }
    };
    pc.addEventListener('icecandidate', listener);
    cleanups.push(() => pc.removeEventListener('icecandidate', listener));
  });

  const iceGatheringComplete = new Promise<void>((resolve) => {
    const listener = () => {
      if (pc.iceGatheringState === 'complete') {
        resolve();
        pc.removeEventListener('icegatheringstatechange', listener);
      }
    };
    pc.addEventListener('icegatheringstatechange', listener);
    cleanups.push(() => pc.removeEventListener('icegatheringstatechange', listener));
  });

  const haveTurnServer = hasTurnServer(pc.getConfiguration());

  const racers: Array<Promise<void>> = [
    gotRelayCandidate,
    // Only accept a bare srflx candidate as "enough" when we have no TURN server
    // to fall back on — matching upstream.
    ...(!haveTurnServer ? [gotSrflxCandidate] : []),
    iceGatheringComplete,
  ];

  if (options.overallTimeoutMs != undefined) {
    racers.push(
      new Promise<void>((resolve) => {
        const handle = setTimeoutFn(resolve, options.overallTimeoutMs!);
        cleanups.push(() => clearTimeoutFn(handle));
      })
    );
  }

  const signal = options.signal;
  if (signal != undefined) {
    racers.push(
      new Promise<void>((resolve) => {
        if (signal.aborted) {
          resolve();
          return;
        }
        const onAbort = () => resolve();
        signal.addEventListener('abort', onAbort);
        cleanups.push(() => signal.removeEventListener('abort', onAbort));
      })
    );
  }

  return Promise.race(racers).finally(runCleanups);
}
