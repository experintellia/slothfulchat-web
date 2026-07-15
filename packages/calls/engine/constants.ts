/**
 * Interop constants mirrored from upstream `deltachat/calls-webapp`
 * (`src/lib/calls.ts`, read at main @ 2026-07). These are the values the far
 * end (a real Delta Chat client running calls-webapp, or chatmail/calls-echobot)
 * uses; matching them keeps our offers/answers wire-compatible.
 *
 * NONE of this touches the DeltaChat message payload — see `signaling.ts` for
 * that. These constants configure the local `RTCPeerConnection` so the SDP we
 * generate has the same shape (single bundled transport, one gathered TURN
 * candidate) the peer expects.
 *
 * Pure data. No DOM/React imports. `RTCConfiguration` etc. are ambient WebRTC
 * lib *types* only (erased at runtime).
 */

/**
 * Base `RTCPeerConnection` configuration, byte-for-byte from calls-webapp
 * `initialRtcConfiguration`. `iceServers` is filled in later from
 * `rpc.iceServers(accountId)`.
 *
 * Rationale captured upstream:
 * - `bundlePolicy: "max-bundle"` — one DTLS transport, so we only gather ONE
 *   TURN candidate; this is what makes the "send after first relay candidate"
 *   non-trickle heuristic safe.
 * - `iceCandidatePoolSize: 1` — pre-gather before `setLocalDescription` so the
 *   offer/answer is ready quickly after `getUserMedia` resolves.
 * - `iceTransportPolicy: "all"` — standard ICE (direct-preferred, relay
 *   fallback). No forced-relay (that is deferred to issue #93 per docs/calls.md).
 */
export const CALLS_WEBAPP_RTC_CONFIGURATION: RTCConfiguration = {
  iceServers: [],
  iceTransportPolicy: 'all',
  bundlePolicy: 'max-bundle',
  iceCandidatePoolSize: 1,
};

/**
 * Negotiated data channels calls-webapp opens in its `CallsManager`
 * constructor. Because they are negotiated with fixed ids, BOTH peers must
 * declare the identical `{ negotiated, id }` for the channel to open — the ids
 * here match upstream. `AudioCallEngine.createPeerConnection` creates both.
 *
 * `iceTrickling` (id 1): created for wire-contract SDP shape only — upstream
 * carries `JSON.stringify(candidate.toJSON())` / literal `null` for
 * end-of-candidates on it; our post-connect ICE promotion is out of scope, so
 * the engine ignores its traffic.
 *
 * `mutedState` (id 3): carries `JSON.stringify({ audioEnabled, videoEnabled })`
 * — sent on every local mute/camera/screen-share flip, consumed to drive
 * `onRemoteVideoActiveChanged`/`onRemoteAudioMutedChanged`.
 */
export const ICE_TRICKLING_DATA_CHANNEL = {
  label: 'iceTrickling',
  options: { negotiated: true, id: 1 } as const,
} as const;

export const MUTED_STATE_DATA_CHANNEL = {
  label: 'mutedState',
  options: { negotiated: true, id: 3 } as const,
} as const;

/**
 * Settle delays used by the non-trickle gathering heuristic (see
 * `ice-gathering.ts`). Upstream `gatheredEnoughIce`:
 * - after the first `relay` candidate: `setTimeout(resolve, 0)` — resolve on the
 *   next tick (only one relay candidate is expected thanks to max-bundle).
 * - after the first `srflx` candidate (only when NO TURN server is configured):
 *   `setTimeout(resolve, 150)` — brief wait in case a couple more srflx arrive.
 */
export const RELAY_CANDIDATE_SETTLE_MS = 0;
export const SRFLX_CANDIDATE_SETTLE_MS = 150;
