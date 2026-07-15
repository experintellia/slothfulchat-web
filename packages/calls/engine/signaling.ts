/**
 * Wire (de)serializer for Delta Chat native calls signaling.
 *
 * The `place_call_info` / `accept_call_info` payload is the RAW SDP string —
 * NOT base64, NOT JSON-wrapped, NOT url-encoded. The base64+url-encoding seen
 * in calls-webapp is a different boundary (its URL hash) and must never touch
 * the wire. Full evidence: see `INTEROP.md`.
 *
 * Pure module: no DOM/React imports.
 */

export type CallSdpType = 'offer' | 'answer';

/**
 * Minimal offer/answer shape. Structurally assignable from a real
 * `RTCSessionDescription` and TO `RTCSessionDescriptionInit`, so deserialize
 * results can be passed to `pc.setRemoteDescription` directly.
 */
export interface CallSessionDescription {
  type: CallSdpType;
  sdp: string;
}

function assertNonEmptySdp(sdp: unknown): asserts sdp is string {
  if (typeof sdp !== 'string' || sdp.length === 0) {
    throw new TypeError(
      `calls signaling: expected a non-empty SDP string, got ${
        typeof sdp === 'string' ? 'empty string' : typeof sdp
      }`
    );
  }
}

/** Serialize an outgoing OFFER for `rpc.placeOutgoingCall`: the raw SDP, verbatim. */
export function serializeOffer(
  description: Pick<CallSessionDescription, 'type' | 'sdp'>
): string {
  if (description?.type !== 'offer') {
    throw new TypeError(
      `serializeOffer: expected an offer, got ${JSON.stringify(description?.type)}`
    );
  }
  assertNonEmptySdp(description.sdp);
  return description.sdp;
}

/** Serialize an ANSWER for `rpc.acceptIncomingCall`: the raw SDP, verbatim. */
export function serializeAnswer(
  description: Pick<CallSessionDescription, 'type' | 'sdp'>
): string {
  if (description?.type !== 'answer') {
    throw new TypeError(
      `serializeAnswer: expected an answer, got ${JSON.stringify(description?.type)}`
    );
  }
  assertNonEmptySdp(description.sdp);
  return description.sdp;
}

/**
 * Deserialize `place_call_info` (from an `IncomingCall` event) into the
 * `pc.setRemoteDescription` arg. Mirrors calls-webapp: `{ type: "offer", sdp: payload }`.
 */
export function deserializeOffer(placeCallInfo: string): CallSessionDescription {
  assertNonEmptySdp(placeCallInfo);
  return { type: 'offer', sdp: placeCallInfo };
}

/** Deserialize `accept_call_info` (from an `OutgoingCallAccepted` event). */
export function deserializeAnswer(acceptCallInfo: string): CallSessionDescription {
  assertNonEmptySdp(acceptCallInfo);
  return { type: 'answer', sdp: acceptCallInfo };
}
