# Calls (native WebRTC 1:1 audio/video)

Status: **planned** (design only; no code yet) · Branch: `claude/plan-adding-calls-p1gxfp`

## What & why

Delta Chat gained a **native 1:1 WebRTC calls** feature (place/accept/end call,
ringing, SDP offer/answer relayed as encrypted DeltaChat messages). Our pinned
core already ships it and the desktop frontend already renders the UI — it is
simply **gated off** for the browser target. This doc plans turning it on for
slothfulchat-web.

Note: the old `DESCOPED.md` line ("Video calls — open call URL in new tab, low
effort") describes the *retired* video-chat-instance-URL feature and is stale.
The current feature is real peer-to-peer WebRTC, so the work and the shape are
different (and larger) than that line implies.

## Why this is tractable in the browser

The **media path is native browser WebRTC** — `getUserMedia` +
`RTCPeerConnection` run in [`deltachat/calls-webapp`](https://github.com/deltachat/calls-webapp)
(plain web JS), so **no WASM is involved** in the call itself. **Signaling** (the
SDP offer/answer) rides through the core as ordinary encrypted DeltaChat messages
over our existing IMAP/SMTP-over-WS transport, which already works. "Adding calls"
is therefore a **runtime-bridge + asset-bundling + frontend-ungate + CSP** job,
not a core-WASM porting job.

Caveat: this is a **frontier feature** — upstream desktop calls
([deltachat-desktop#5447](https://github.com/deltachat/deltachat-desktop/issues/5447))
were unreleased/experimental as of our pin, so expect API churn; treat it as
prototype-grade like the rest of the repo.

## What already exists (verified against our pins)

Core `@deltachat/jsonrpc-client@2.53.0` / `chatmail/core` `v2.53.0`:

- Methods: `place_outgoing_call(accountId, chatId, place_call_info /*SDP offer*/, has_video) -> msgId`,
  `accept_incoming_call(accountId, msgId, accept_call_info /*SDP answer*/)`,
  `end_call(accountId, msgId)`, `call_info(accountId, msgId)`,
  `ice_servers(accountId) -> string` (JSON ICE list, ships a working default:
  STUN `nine.testrun.org:3478` + TURN `turn.delta.chat:3478`, public creds).
- Events: `IncomingCall{ msgId, chatId, place_call_info, has_video }`,
  `OutgoingCallAccepted{ msgId, chatId, accept_call_info }`,
  `IncomingCallAccepted{ msgId, chatId, from_this_device }`,
  `CallEnded{ msgId, chatId }`.

Frontend `vendor/deltachat-desktop` @ `1b90817`:

- `runtime.ts` declares `startOutgoingVideoCall(accountId, chatId, { startWithCameraEnabled })`
  and `openIncomingVideoCallWindow({ accountId, chatId, callMessageId, callerWebrtcOffer, startWithCameraEnabled })`.
- `ChatView.tsx` shows the call button only when
  `runtime.getRuntimeInfo().target === 'electron'`.
- `Message.tsx` renders call info-messages with accept/redial buttons wired to
  those two runtime hooks.

Our `packages/web-app/src/runtime.ts` stubs both hooks
(`log.critical('Method not implemented.')`, ~L648–653).

Reference implementation to port: electron's
`packages/target-electron/src/windows/video-call.ts` (+ `startHandlingIncomingVideoCalls`
in `ipc.ts`) — bundles the `calls-webapp`, exposes a `window.calls` bridge
(`startCall`/`acceptCall`/`endCall`/`getIceServers`/`getAvatar`), passes the
incoming offer via URL hash, and bridges to `rpc.placeOutgoingCall` /
`acceptIncomingCall` / `endCall` / `iceServers`; subscribes to `IncomingCall`.

## Call flow to reproduce

1. **Outgoing**: call button → `startOutgoingVideoCall` → open webapp (camera/mic)
   → webapp emits SDP **offer** → `rpc.placeOutgoingCall(offer)` → core sends
   offer message. On `OutgoingCallAccepted{accept_call_info}` → feed **answer** to
   webapp → ICE via `rpc.iceServers()` → media connects.
2. **Incoming**: `IncomingCall{place_call_info=offer, has_video}` → ring UI / open
   webapp with offer → accept → webapp emits **answer** → `rpc.acceptIncomingCall(answer)`
   → core sends answer. `IncomingCallAccepted` dismisses the ring on other devices.
3. **End**: either side → `rpc.endCall` / `CallEnded` → tear down webapp + media.

## Recommended approach

Host the `calls-webapp` **same-origin in a sandboxed
`<iframe allow="camera; microphone">` overlay** inside the PWA (not a popup —
popups are blocked on mobile PWAs and break the single-window install model).
Bridge it to the core via the typed `jsonrpc-client` we already own
(`WasmTransport`) using `postMessage`/`MessageChannel`. Keep new logic in **our**
package plus one thin desktop patch; **no core patch expected**.

## Milestones (each a stop/go checkpoint)

**M0 — vendor the calls-webapp + doc correction.** Add `deltachat/calls-webapp`
as a build input (submodule under `vendor/`, or a pinned prebuilt-asset dep —
choose by build weight & license); confirm license composes with our GPL-3.0 whole
and add it to the README license table. Wire its built assets into
`packages/web-app` static output under e.g. `/calls-webapp/`. Update
`DESCOPED.md`/`PLAN.md` (retire the stale "open URL in tab" line).

**M1 — outgoing call, happy path.** Implement `startOutgoingVideoCall` in
`packages/web-app/src/runtime.ts`: mount the iframe overlay, establish the
`window.calls` bridge (`getIceServers`→`rpc.iceServers`; `getAvatar`→chat avatar
via existing blob/`transformBlobURL` path; `startCall(offer)`→`rpc.placeOutgoingCall`),
subscribe to `OutgoingCallAccepted` to return the answer, `endCall`→`rpc.endCall`
+ `CallEnded` teardown. Thin `patches/desktop` patch un-gating the `ChatView.tsx`
call button for `target === 'browser'`.
**Verify:** call the browser from a second real client (`chatmail/calls-echobot`
for automation, or Android/desktop for a human check); media connects.

**M2 — incoming call.** Browser equivalent of `startHandlingIncomingVideoCalls`:
subscribe to `IncomingCall` on the shared event stream, surface a ring (in-app
modal + `Notification` when backgrounded); on accept open the iframe with the offer
and wire `acceptCall(answer)`→`rpc.acceptIncomingCall`. Un-gate `Message.tsx`
accept/redial for `browser` in the same patch; handle `IncomingCallAccepted`
(dismiss ring) and `CallEnded`.
**Verify:** second client calls the browser; ring shows, accept connects;
decline/hangup tears down both ends.

**M3 — CSP, permissions, privacy, settings.**
- **CSP**: the strict single-origin CSP must gain what WebRTC needs —
  `connect-src` entries for the STUN/TURN hosts from `ice_servers()`
  (`*.testrun.org`, `turn.delta.chat`; browsers gate ICE via `connect-src`),
  `frame-src 'self'` for the iframe, and `Permissions-Policy` / iframe `allow`
  for `camera; microphone`. Verify `ice_servers()` returns **hostnames** the
  browser resolves (our WASM DNS is stubbed); if it resolves host-side, that is
  the one place a small shim/patch may be needed.
- **Settings**: expose core's `WhoCanCallMe` privacy config in the web-app UI.
- **Privacy docs**: update README "Privacy & data protection" + generated
  `privacy.html` — calls add STUN/TURN origins and relay media through
  `turn.delta.chat`; disclose it and make ICE config overridable where reasonable.
- **Analytics**: add content-free call events to `packages/web-app/src/analytics.ts`,
  matching the existing closed `EVENTS` policy.
**Verify:** call works with no CSP violations; PWA still installable; privacy page
regenerates cleanly.

**M4 — polish & automation.** Ringtone/vibration, in-call controls, busy/timeout/
missed states via `call_info`, mobile-viewport layout (reuse the full-screen-dialog
patch approach, `0020`/`0031`). Playwright smoke based on upstream
`packages/e2e-tests`: drive an outgoing call against a local echo/second core,
assert `placeOutgoingCall` fires and an `RTCPeerConnection` reaches `connected`.
Log patch count + findings in `FINDINGS.md`.

## Files to touch

- `packages/web-app/src/runtime.ts` — implement both hooks + incoming-call
  subscription + iframe/bridge host (replace the two stubs at ~L648–653).
- `packages/web-app/` build config + static assets — bundle/serve `calls-webapp`;
  CSP + `Permissions-Policy` additions.
- `packages/web-app/src/analytics.ts` — call events.
- New `patches/desktop/00NN-*.patch` — un-gate call UI (`ChatView.tsx`,
  `Message.tsx`) for `target === 'browser'`; optional `WhoCanCallMe` settings entry.
- `vendor/` + `.gitmodules` (or `package.json`) — vendor `calls-webapp`.
- `DESCOPED.md`, `PLAN.md`, `README.md`, `FINDINGS.md`, privacy-page generator — docs.
- Core patch: **not expected**; contingency only if `ice_servers()` or call
  messaging hits the WASM DNS/net stubs at runtime (surfaces at M1/M3 verify).

## Reuse (don't reinvent)

- Typed client + `WasmTransport` in `packages/core-wasm` — call
  `rpc.placeOutgoingCall/acceptIncomingCall/endCall/iceServers/callInfo` directly.
- Existing in-page event emitter in `runtime.ts` (the `/ws/backend` replacement) —
  subscribe the `IncomingCall`/`*Accepted`/`CallEnded` handlers there.
- Existing blob/avatar path (`transformBlobURL`, memfs+SW route) for `getAvatar()`.
- Existing camera-permission priming in `runtime.ts` (QR-reader `getUserMedia`,
  ~L1345) as the gesture/permission model.
- `chatmail/calls-echobot` as an automated far-end for tests.
- Electron `windows/video-call.ts` as the structural template.

## Risks / open questions

- **Frontier churn**: desktop calls unreleased at our pin → API/UX may shift; keep
  the patch thin and prototype-scoped.
- **TURN reliability**: default `turn.delta.chat` public creds have quotas;
  NAT-restricted networks *require* relay. Make ICE config overridable; document limits.
- **CSP widening** conflicts with the repo's "single extra origin" privacy stance —
  needs an explicit, documented decision (M3).
- **`ice_servers()` on WASM**: confirm it returns unresolved hostnames (browser
  resolves) vs. host-side DNS (stubbed) — the only likely core-side snag.
- **Signaling latency**: offer/answer travel as DeltaChat messages; ring/connect
  latency is inherent to DC — set UX expectations (timeouts, "calling…").

## Verification (end to end)

Real second client (Android/desktop DeltaChat or `calls-echobot`): outgoing
connects, incoming rings + accepts, hangup tears down both ends, no CSP errors,
PWA still installable, privacy page regenerates. Playwright smoke asserts
`RTCPeerConnection` reaches `connected`. Record patch count + findings in
`FINDINGS.md`.
