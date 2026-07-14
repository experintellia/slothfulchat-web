/**
 * Wire (de)serializer for Delta Chat native calls signaling.
 *
 * ── THE ON-THE-WIRE FORMAT (verified from source, 2026-07) ────────────────────
 *
 * The string carried by the core RPCs
 *   `place_outgoing_call(accountId, chatId, place_call_info, has_video)`
 *   `accept_incoming_call(accountId, msgId, accept_call_info)`
 * and delivered back verbatim on the `IncomingCall{ place_call_info }` /
 * `OutgoingCallAccepted{ accept_call_info }` events is:
 *
 *     the RAW SDP STRING — nothing else.
 *
 * NOT base64. NOT JSON-wrapped. NOT url-encoded.
 *
 * Evidence (three layers, all pointing the same way):
 *
 * 1. calls-webapp `src/lib/calls.ts`
 *      startCall():   const offer  = pc.localDescription!.sdp; window.calls.startCall(offer)
 *      acceptCall():  const answer = pc.localDescription!.sdp; window.calls.acceptCall(answer)
 *    i.e. it hands `window.calls.*` the raw `.sdp` string. When it *receives*
 *    a payload it rewraps it as `{ type: "offer"|"answer", sdp: payload }` and
 *    feeds it to `setRemoteDescription`.
 *
 * 2. deltachat-desktop `packages/target-electron/.../video-call.ts` — the
 *    reference `window.calls` host:
 *      startCall(offerPayload)  -> rpc.placeOutgoingCall(accountId, chatId, offer, ...)
 *      acceptCall(answerPayload)-> rpc.acceptIncomingCall(accountId, msgId, answer)
 *    The payload is passed straight through to the RPC, unencoded.
 *
 * 3. chatmail/core `src/calls.rs` stores it verbatim
 *      call.param.set(Param::WebrtcRoom, &place_call_info)      // offer
 *      .set(Param::WebrtcAccepted, accept_call_info.to_string()) // answer
 *    and re-emits it verbatim on the events. The jsonrpc type documents the
 *    field as the "SDP offer".
 *
 * ── THE base64 + url-encoding IS A DIFFERENT BOUNDARY ─────────────────────────
 *
 * calls-webapp is loaded in a window whose URL *hash* carries the payload
 * (`#offerIncomingCall=`, `#acceptCall=`, `#onAnswer=`). ONLY there is the SDP
 * base64-encoded (and, per the webapp README, the `=` padding url-encoded to
 * `%3D`). That is a client↔webapp transport detail. We reimplement our own peer
 * and DO NOT use the webapp, so the base64/url step MUST NOT be applied to
 * `place_call_info` / `accept_call_info`. Applying it would make us
 * wire-INcompatible with real Delta Chat clients.
 *
 * The `webappHash*` helpers below implement that hash codec ONLY so we can drive
 * / interop-test against an actual calls-webapp instance if we ever want to.
 * They are explicitly NOT part of the DeltaChat message path.
 *
 * Pure module: no DOM/React imports. `RTCSessionDescriptionInit` is an ambient
 * WebRTC lib *type* (erased at runtime).
 */

export type CallSdpType = 'offer' | 'answer';

/**
 * Minimal offer/answer shape. Structurally assignable from a real
 * `RTCSessionDescription` / `RTCSessionDescriptionInit` (both have `type` +
 * `sdp`), and structurally assignable TO `RTCSessionDescriptionInit` so the
 * result of {@link deserializeOffer}/{@link deserializeAnswer} can be passed to
 * `pc.setRemoteDescription` directly.
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

/**
 * Serialize a local description into the `place_call_info` / `accept_call_info`
 * payload: the raw SDP, verbatim. This is intentionally a near-no-op — the
 * whole point of the interop finding is that NO transformation happens here.
 *
 * Accepts anything with `{ type, sdp }` (e.g. `pc.localDescription`).
 */
export function serializeCallInfo(
  description: Pick<CallSessionDescription, 'type' | 'sdp'>
): string {
  if (description == null) {
    throw new TypeError('calls signaling: description is null/undefined');
  }
  if (description.type !== 'offer' && description.type !== 'answer') {
    throw new TypeError(
      `calls signaling: expected type "offer" or "answer", got ${JSON.stringify(
        description.type
      )}`
    );
  }
  assertNonEmptySdp(description.sdp);
  return description.sdp;
}

/** Serialize an outgoing OFFER for `rpc.placeOutgoingCall`. */
export function serializeOffer(
  description: Pick<CallSessionDescription, 'type' | 'sdp'>
): string {
  if (description?.type !== 'offer') {
    throw new TypeError(
      `serializeOffer: expected an offer, got ${JSON.stringify(description?.type)}`
    );
  }
  return serializeCallInfo(description);
}

/** Serialize an ANSWER for `rpc.acceptIncomingCall`. */
export function serializeAnswer(
  description: Pick<CallSessionDescription, 'type' | 'sdp'>
): string {
  if (description?.type !== 'answer') {
    throw new TypeError(
      `serializeAnswer: expected an answer, got ${JSON.stringify(description?.type)}`
    );
  }
  return serializeCallInfo(description);
}

/**
 * Deserialize `place_call_info` (from an `IncomingCall` event) into the object
 * we pass to `pc.setRemoteDescription`. Mirrors calls-webapp exactly:
 *   const offerObject = { type: "offer", sdp: payload }
 */
export function deserializeOffer(placeCallInfo: string): CallSessionDescription {
  assertNonEmptySdp(placeCallInfo);
  return { type: 'offer', sdp: placeCallInfo };
}

/**
 * Deserialize `accept_call_info` (from an `OutgoingCallAccepted` event).
 * Mirrors calls-webapp:
 *   const answerObject = { type: "answer", sdp: payload }
 */
export function deserializeAnswer(acceptCallInfo: string): CallSessionDescription {
  assertNonEmptySdp(acceptCallInfo);
  return { type: 'answer', sdp: acceptCallInfo };
}

// ── calls-webapp URL-hash codec (NOT the DeltaChat wire format) ───────────────
//
// Provided only for driving/interop-testing a real calls-webapp instance. Do
// NOT feed the output of these into place_call_info / accept_call_info.

/**
 * base64-encode an ASCII string (SDP is ASCII). Uses the `btoa`/`atob` globals,
 * which exist in browsers, Web Workers AND modern Node (>=16) — so the engine
 * stays free of any `node:`/`Buffer` dependency.
 */
function base64Encode(ascii: string): string {
  if (typeof globalThis.btoa !== 'function') {
    throw new Error('calls signaling: btoa() is unavailable in this environment');
  }
  return globalThis.btoa(ascii);
}

/** base64-decode to an ASCII string. */
function base64Decode(b64: string): string {
  if (typeof globalThis.atob !== 'function') {
    throw new Error('calls signaling: atob() is unavailable in this environment');
  }
  return globalThis.atob(b64);
}

/**
 * Build the `PAYLOAD` for a calls-webapp URL hash (e.g.
 * `#offerIncomingCall=PAYLOAD`): base64, then url-encode — including the `=`
 * padding as `%3D`, as the webapp README requires. `encodeURIComponent`
 * escapes `=`, `+` and `/`, giving a fragment-safe string the webapp reverses
 * with `decodeURIComponent(...)` then `atob(...)`.
 */
export function webappHashEncode(sdp: string): string {
  assertNonEmptySdp(sdp);
  return encodeURIComponent(base64Encode(sdp));
}

/** Reverse {@link webappHashEncode}. Also accepts a non-url-encoded base64
 * payload (as deltachat-desktop's preload actually emits — plain `btoa`). */
export function webappHashDecode(payload: string): string {
  return base64Decode(decodeURIComponent(payload));
}
