/**
 * Non-trickle ICE gathering, ported faithfully from upstream
 * `deltachat/calls-webapp` `gatheredEnoughIce()` (`src/lib/calls.ts`).
 *
 * WHY non-trickle: the offer/answer travels as a store-and-forward DeltaChat
 * message — no live channel to trickle over — so candidates must be embedded
 * INTO the SDP before sending. We don't wait for gathering to fully complete
 * (can hang on bad networks); we send once we have "enough", a `Promise.race`:
 *   1. first `relay` (TURN) candidate + 0ms settle — only one expected under
 *      max-bundle, and a relay candidate essentially guarantees connectivity;
 *   2. first `srflx` (STUN) candidate + 150ms settle — ONLY raced when no
 *      TURN server is configured;
 *   3. `iceGatheringState === "complete"` as the natural backstop (upstream
 *      has no wall-clock timer; `overallTimeoutMs` is an opt-in extra).
 *
 * CRITICAL ORDERING: call this BEFORE `setLocalDescription`, so the candidate
 * listeners are attached before candidates start flowing (upstream warns
 * about exactly this).
 *
 * Pure module, no DOM imports; operates on a structural `pc` for testability.
 */

import { RELAY_CANDIDATE_SETTLE_MS, SRFLX_CANDIDATE_SETTLE_MS } from './constants.ts';

/** The subset of `RTCPeerConnection` that {@link gatherUntilEnoughIce} touches. */
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
  /** Opt-in hard wall-clock cap (ms); defaults OFF to match upstream. On
   * expiry, resolve with whatever is already in the SDP. */
  overallTimeoutMs?: number;
  /** Injectable timers for deterministic tests. Default: global set/clear. */
  setTimeoutFn?: (cb: () => void, ms: number) => unknown;
  clearTimeoutFn?: (handle: unknown) => void;
  /** Optional abort: resolves immediately and detaches all listeners. Needed
   * because a closed `pc` emits no further events, so teardown while awaiting
   * this would otherwise hang forever. Wired to engine teardown (audio-call.ts). */
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
 * Resolves once "enough" ICE has been gathered to send the local description
 * (heuristic in the module doc). Faithful to upstream, except `turns:` is also
 * treated as TURN (upstream only checks `turn:`) plus the opt-in timeout.
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
