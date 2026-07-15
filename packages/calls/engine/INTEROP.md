# Calls signaling interop spec (M0)

The on-the-wire signaling format our peer MUST match to be callable by real
Delta Chat clients (which run `deltachat/calls-webapp`) and by
`chatmail/calls-echobot`. This is the M0 research deliverable from
`docs/calls.md`; it gates every later milestone. Implemented by
`signaling.ts` + `ice-gathering.ts` + `constants.ts` in this folder.

## Sources read (not shipped)

- `deltachat/calls-webapp` `src/lib/calls.ts`, `README.md` (main, read 2026-07).
- `vendor/deltachat-desktop/packages/target-electron/src/windows/video-call.ts`
  and `.../static/calls-webapp-preload.js` — the reference `window.calls` host.
- `vendor/core/src/calls.rs`, `vendor/core/deltachat-jsonrpc/src/api/types/calls.rs`
  — our pinned core (`v2.53.0`).

## 1. Payload format — RAW SDP, nothing else

`place_call_info` (the offer) and `accept_call_info` (the answer) — the strings
passed to `rpc.placeOutgoingCall` / `rpc.acceptIncomingCall` and delivered back
verbatim on `IncomingCall` / `OutgoingCallAccepted` — are the **raw SDP string**:

- **NOT** base64-encoded.
- **NOT** JSON-wrapped (no `{ "type": ..., "sdp": ... }` on the wire).
- **NOT** URL-encoded.

### Evidence (three layers agree)

1. **calls-webapp** hands `window.calls` the raw `.sdp` and rewraps received
   payloads back into a description object itself:
   ```js
   // startCall():
   const offer = this.peerConnection.localDescription!.sdp;
   window.calls.startCall(offer);
   // acceptCall():
   const answer = this.peerConnection.localDescription!.sdp;
   window.calls.acceptCall(answer);
   // on receiving a payload:
   const offerObject  = { type: "offer",  sdp: payload };   // -> setRemoteDescription
   const answerObject = { type: "answer", sdp: payload };
   ```
2. **deltachat-desktop host** passes the payload straight to the RPC, unencoded:
   ```ts
   // startCall(offerPayload)  ->
   rpc.placeOutgoingCall(accountId, chatId, offer, startWithCameraEnabled)
   // acceptCall(answerPayload) ->
   rpc.acceptIncomingCall(accountId, callMessageId, answer)
   ```
3. **core** stores and re-emits it verbatim, and its jsonrpc type documents the
   field as `sdp_offer` ("SDP offer"):
   ```rust
   call.param.set(Param::WebrtcRoom, &place_call_info);          // offer
   ....set(Param::WebrtcAccepted, accept_call_info.to_string()); // answer
   ```

### The base64 + url-encoding is a DIFFERENT boundary — do not apply it here

The webapp README's "PAYLOAD **must** be base64 encoded and then url-encoded
(including `=` → `%3D`)" describes the **URL hash** the client uses to hand a
payload to the webapp window (`#offerIncomingCall=…`, `#acceptCall=…`,
`#onAnswer=…`). deltachat-desktop's preload does exactly this with `btoa(...)`
when it sets `location.hash`, and calls-webapp reverses it with
`decodeURIComponent(...)` then `atob(...)`. **We reimplement our own peer and do
not use the webapp, so this base64/url step is not part of our path.** Applying
it to `place_call_info`/`accept_call_info` would make us wire-INCOMPATIBLE.

(A `webappHash{Encode,Decode}` codec for driving a real calls-webapp instance
once lived in `signaling.ts` — never part of the DeltaChat message payload;
see git history.)

## 2. Serializer contract (`signaling.ts`)

| function | in | out |
| --- | --- | --- |
| `serializeOffer({type:'offer', sdp})` | local offer (e.g. `pc.localDescription`) | `place_call_info` = `sdp` verbatim |
| `serializeAnswer({type:'answer', sdp})` | local answer | `accept_call_info` = `sdp` verbatim |
| `deserializeOffer(place_call_info)` | offer payload from `IncomingCall` | `{type:'offer', sdp}` for `setRemoteDescription` |
| `deserializeAnswer(accept_call_info)` | answer payload from `OutgoingCallAccepted` | `{type:'answer', sdp}` for `setRemoteDescription` |

Serialization is byte-preserving: CRLF line endings and the trailing CRLF that
Chromium emits are kept intact (proven by the round-trip unit test against a real
gathered offer/answer in `fixtures/`).

## 3. Non-trickle ICE gathering (`ice-gathering.ts`)

Because the SDP travels inside a (slow, store-and-forward) DeltaChat message,
candidates must be embedded in the SDP before sending — there is no live channel
to trickle over first. `gatherUntilEnoughIce(pc)` ports calls-webapp's
`gatheredEnoughIce()` faithfully. Attach it **before** `setLocalDescription`.
It resolves on the first of (`Promise.race`):

1. **first `relay` (TURN) candidate**, then a 0 ms tick — the happy path. Only
   one relay candidate is expected because of `bundlePolicy: "max-bundle"`, and a
   relay candidate essentially guarantees connectivity. Delta Chat's
   `ice_servers()` always returns a chatmail TURN relay, so this normally wins.
2. **first `srflx` (STUN) candidate**, then 150 ms — **only** entered into the
   race when NO TURN server is configured ("fail fast / succeed fast").
3. **`iceGatheringState === "complete"`** — the "or timeout" backstop. Upstream
   has **no wall-clock timer**; the natural end of gathering is the fallback.
   `gatherUntilEnoughIce` mirrors this by default and offers an OPT-IN
   `overallTimeoutMs` safety net (off by default, so behavior matches upstream).

Our port also treats `turns:` URLs as TURN (upstream only checks `turn:`).

## 4. `RTCPeerConnection` shape the peer expects (`constants.ts`)

- `CALLS_WEBAPP_RTC_CONFIGURATION`: `{ bundlePolicy: "max-bundle",
  iceCandidatePoolSize: 1, iceTransportPolicy: "all", iceServers: [] }`
  (`iceServers` filled from `rpc.iceServers`). `iceTransportPolicy: "all"` =
  standard ICE (direct-preferred, relay fallback); no forced-relay (deferred to
  issue #93 per `docs/calls.md`).
- Offer construction (caller): `addTransceiver("video", {direction:"sendrecv"})`
  **and** `addTransceiver("audio", {direction:"sendrecv"})` are added before
  `addTrack`, so the offer always carries both an audio and a video m-line even
  in an audio-only (audio-first) call. This lets the whole call complete in a
  single negotiation (calls-webapp does exactly one). Answerer just `addTrack` +
  `createAnswer`.
- Negotiated data channels (fixed ids are part of the contract; both peers must
  declare identical `{negotiated:true, id}`):
  - `iceTrickling` **id 1** — post-connect ICE promotion (optional/later);
    payload `JSON.stringify(candidate.toJSON())`, or literal `null` for
    end-of-candidates.
  - `mutedState` **id 3** — payload `JSON.stringify({audioEnabled, videoEnabled})`.

  For M1 (audio happy path) these need only EXIST in the SDP m=application
  section for negotiation; wiring their behavior is M2+.

## 5. What this means for our engine (later milestones)

Caller: acquire mic → add audio+video transceivers → `gatherUntilEnoughIce(pc)`
→ `createOffer`/`setLocalDescription` → `serializeOffer(pc.localDescription)` →
`rpc.placeOutgoingCall`. On `OutgoingCallAccepted{accept_call_info}` →
`pc.setRemoteDescription(deserializeAnswer(accept_call_info))`.

Callee: on `IncomingCall{place_call_info}` →
`pc.setRemoteDescription(deserializeOffer(place_call_info))` → acquire mic →
`gatherUntilEnoughIce(pc)` → `createAnswer`/`setLocalDescription` →
`serializeAnswer(pc.localDescription)` → `rpc.acceptIncomingCall`.
