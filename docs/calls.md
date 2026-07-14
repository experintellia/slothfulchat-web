# Calls (native WebRTC 1:1 audio/video) — our own, better-integrated implementation

Status: **in progress** — M0 (interop spec + scaffold + un-gate patch), M1 (audio call happy path), M2 (mic/camera device selection + hot-switching, avatar speaking-rings), M3 (camera video + screen share), and M4 (detached popup window + overlay fallback) landed; M5 pending. M3: `AudioCallEngine`'s `hasVideo` adds a camera track/m-line alongside the mic (mirrored on the answer side per the caller's own `has_video`); `startScreenShare`/`stopScreenShare` take over that SAME outgoing video sender via `getDisplayMedia()` + `RTCRtpSender.replaceTrack` — no renegotiation, so a `calls-webapp` peer sees an ordinary track change, not a screen-share-specific protocol; the browser's native "Stop sharing" auto-restores the camera the same way. M4: the active call prefers a detached same-origin `window.open` popup (`packages/web-app/src/call-popup.ts` + `dist/call-popup.html`) that hosts the engine + UI and owns media + `RTCPeerConnection`, relaying SIGNALING ONLY to the opener over `postMessage` (`packages/calls/bridge/popup-*.ts`); the opener forwards to the core Worker. A synchronous popup-block (`window.open` → `null`) or a handshake timeout falls back seamlessly to the in-page overlay (same engine, same components); ringing always stays in the main window. **M5 is PARTIAL:** the WhoCanCallMe setting, direct-vs-relay indicator, privacy disclosure, content-free analytics, ringtone/vibration, missed/busy/timeout outcomes, mobile layout, and a Playwright e2e harness have landed — but the **CSP `connect-src` widening is BLOCKED** on a core finding (see next paragraph) and no core patch has been added. The real two-way-audio/video gate against a live Delta Chat client / `chatmail/calls-echobot`, and the live popup/overlay-fallback UX, are verified by CI/human, not in the headless build sandbox. · Branch: `claude/calls-impl-m0-9t3ote`

> **⚠ Open blocker (needs a human decision — no core patch added yet).** `ice_servers()` (core `src/calls.rs`) resolves STUN/TURN DNS **host-side** and emits IP addresses; on the WASM build `tokio`'s `lookup_host` is stubbed (our `patches/core/0001`), so it returns `"[]"` — the browser gets **no STUN/TURN**, so calls only reach same-LAN/loopback peers, not real clients across NAT. Until this is resolved the `connect-src` widening has no hosts to add and the privacy page's "relay fallback" description reflects the *design*, not current runtime behaviour. Two paths: **(A)** a minimal wasm-gated core patch that emits unresolved `turn:`/`stun:` hostnames for the browser to resolve (per-account relay from METADATA; +1 core patch → 17); **(B)** inject the public fallback ICE list (`turn.delta.chat`, from core's own `create_fallback_ice_servers()`) in `packages/calls`, no core patch but a shared public relay. Decision pending.

## What & why

Delta Chat has a native 1:1 WebRTC calls feature: place/accept/end call with
ringing, where the SDP offer/answer travel as encrypted DeltaChat messages. Our
pinned core already ships the signaling API and events; the desktop frontend
already renders the entry-point UI but **gates it to `target === 'electron'`**,
and our `runtime.ts` stubs the hooks.

Rather than bundle the upstream [`deltachat/calls-webapp`](https://github.com/deltachat/calls-webapp)
in an iframe, **we reimplement the call surface ourselves** — a small WebRTC
engine plus our own React UI — because we want a call experience that is
tighter, nicer, and extensible beyond what the drop-in webapp offers:

- **Input-device selection**: when more than one mic/camera exists, let the user
  choose (and switch mid-call).
- **Speaking indicators**: a glowing ring around each participant avatar that
  reacts to their voice level (Discord/Jitsi style) — nice-looking *and* a
  troubleshooting aid ("are they even transmitting?").
- **Screen sharing**: `getDisplayMedia()` that **takes over the outgoing camera
  track** (via `RTCRtpSender.replaceTrack`), so the remote sees it as the normal
  video track and every existing peer implementation just works.

The old `DESCOPED.md` "open a video-chat URL in a tab" line is retired — that was
a different, dead feature.

Caveat: this is a **frontier feature** (upstream desktop calls,
[deltachat-desktop#5447](https://github.com/deltachat/deltachat-desktop/issues/5447),
were still experimental at our pin) — prototype-grade, like the rest of the repo.

## Interoperability (a hard constraint)

Because we reimplement our own peer, we **must stay wire-compatible** with real
Delta Chat clients (Android/desktop run `calls-webapp`), or we can't call actual
users — which would defeat the purpose. Concretely:

- Signaling is **non-trickle**: gather ICE candidates until a relay candidate
  arrives or a timeout fires, *then* place the offer / send the answer. (An extra
  data channel can promote more candidates after connect — optional, later.)
- The payload our engine puts in `place_call_info` / `accept_call_info` must match
  what `calls-webapp` expects. **M0 finding (verified against upstream source):** it
  is the **raw SDP string** — not base64, not JSON-wrapped, not url-encoded.
  `calls-webapp` passes `localDescription.sdp` straight to `startCall`/`acceptCall`
  and re-wraps received payloads as `{type, sdp}` itself; core stores/re-emits it
  verbatim. (The base64+url-encode from the webapp README is a *separate* boundary —
  the client↔webapp URL hash — which we do not use. See `packages/calls/engine/INTEROP.md`.)
- Test against a real DeltaChat client and [`chatmail/calls-echobot`](https://github.com/chatmail/calls-echobot).

## What already exists (verified against our pins)

Core `@deltachat/jsonrpc-client@2.53.0` / `chatmail/core` `v2.53.0`:

- Methods: `place_outgoing_call(accountId, chatId, place_call_info /*SDP offer*/, has_video) -> msgId`,
  `accept_incoming_call(accountId, msgId, accept_call_info /*SDP answer*/)`,
  `end_call(accountId, msgId)`, `call_info(accountId, msgId)`,
  `ice_servers(accountId) -> string` (JSON ICE list — already returns a **chatmail
  relay's TURN** plus a STUN default, so relay fallback needs no extra infra).
- Events: `IncomingCall{ msgId, chatId, place_call_info, has_video }`,
  `OutgoingCallAccepted{ msgId, chatId, accept_call_info }`,
  `IncomingCallAccepted{ msgId, chatId, from_this_device }`,
  `CallEnded{ msgId, chatId }`.
- Config `WhoCanCallMe` (privacy — who may ring you).

Frontend `vendor/deltachat-desktop` @ `1b90817`: `runtime.ts` declares the two
call hooks; `ChatView.tsx` shows the call button only for `target === 'electron'`;
`Message.tsx` renders call info-messages with accept/redial buttons wired to those
hooks. Our `packages/web-app/src/runtime.ts` stubs both (~L648–653). Electron's
`packages/target-electron/src/windows/video-call.ts` (+ `startHandlingIncomingVideoCalls`)
is a structural reference for the signaling bridge, though we don't reuse its UI.

## Architecture — where the code lives (answers "package or patches?")

**A new package holds everything reusable; a single thin desktop patch only
un-gates the entry points.** This works because the call hooks and the
incoming-call events are *already in our code* (`packages/web-app`), so the whole
call experience can be **our own React tree mounted by the runtime** — no frontend
patch for any call UI. Layers:

**One package, `packages/calls`**, with an enforced internal split (engine imports
no React/DOM — unit-testable; split into two packages later only if a second
consumer ever appears — YAGNI):

1. **`engine/`** (framework-agnostic TS, no DOM/React): the WebRTC state machine —
   `getUserMedia`/`getDisplayMedia`, `RTCPeerConnection`, non-trickle ICE gathering,
   offer/answer (de)serialization in the `calls-webapp`-compatible format,
   `replaceTrack` for camera↔screen, device enumeration, and per-track audio-level
   metering (Web Audio `AnalyserNode`) for the speaking rings. Location-agnostic so
   it runs in an overlay *or* a popup.
2. **`ui/`** (React): ring/incoming dialog, in-call window (video tiles, avatar
   speaking-rings, mute/camera/screen controls, device pickers, hangup,
   relay-connection indicator). Styled to fit the app; consumes the engine's
   observable call state.
3. **`bridge/`** (thin glue re-exported for the web-app runtime) — connects the
   engine to the typed jsonrpc client and the popup⇄opener signaling relay.
4. **`packages/web-app/src/runtime.ts`** (ours): implement `startOutgoingVideoCall`
   / `openIncomingVideoCallWindow`; subscribe to the call events on the existing
   in-page emitter; mount the ring overlay + call window; bridge the engine to the
   typed jsonrpc client (`rpc.placeOutgoingCall`/`acceptIncomingCall`/`endCall`/
   `iceServers`/`callInfo`).
5. **One `patches/desktop/00NN` patch** (thin): un-gate the `ChatView.tsx` call
   button for `target === 'browser'`; optionally the `Message.tsx` accept/redial
   buttons so call history renders in the chat log. Nothing else upstream.

## Windowing model (answers the ringing/popup question)

- **Ringing always renders in the main window** as an in-app popup/modal overlay
  (mounted by the runtime), so it can never be popup-blocked and is reliable on
  mobile PWAs.
- **The active call prefers a detached popup window** (`window.open`, same origin,
  hosting the engine + our call UI). If `window.open` returns `null`
  (popup-blocked) or the window can't be established, **fall back to an in-page
  overlay** in the main window — same engine, same components, different mount
  point.
- Popup ⇄ core: the core Worker is owned by the main tab and can't be shared
  (dedicated-worker/OPFS constraint), so a popup runs media + `RTCPeerConnection`
  locally and relays *signaling only* to the opener via `postMessage`/
  `BroadcastChannel`; the opener forwards to the core. This IPC seam is the reason
  the **overlay is the safe default** and the popup is a progressive enhancement.

## The call flow

1. **Outgoing**: call button → `startOutgoingVideoCall` → engine acquires mic
   (audio-first) → gathers ICE (relay-or-timeout) → SDP **offer** →
   `rpc.placeOutgoingCall(offer)`. On `OutgoingCallAccepted{accept_call_info}` →
   feed **answer** into the engine → connected.
2. **Incoming**: `IncomingCall{place_call_info, has_video}` → ring overlay in main
   window → accept → engine builds **answer** → `rpc.acceptIncomingCall(answer)`.
   `IncomingCallAccepted{from_this_device}` dismisses the ring elsewhere.
3. **End**: either side → `rpc.endCall` / `CallEnded` → engine tears down media +
   peer connection; UI closes.

## Milestones (audio-first, each a stop/go checkpoint)

**M0 — engine skeleton + interop research + un-gate.** Scaffold `calls-engine`;
confirm the exact `calls-webapp` payload format from its source and encode a
matching (de)serializer; thin patch to un-gate the call button for `browser`;
update `DESCOPED.md`/`PLAN.md`.

**M1 — audio call, happy path (outgoing + incoming).** Full audio-only 1:1: place,
ring, accept, connect, hang up, via the runtime bridge + in-page overlay UI. ICE
from `rpc.iceServers`. **Verify** against a real DeltaChat client and
`calls-echobot`: two-way audio connects and tears down cleanly.

**M2 — device selection + speaking rings.** Enumerate mics/cameras, picker UI,
hot-switch mid-call via `replaceTrack`; Web-Audio level meters driving avatar rings
(local + remote). **Verify**: switching input devices works mid-call; rings track
who's talking.

**M3 — video + screen share.** Add camera video (`has_video`) and
`getDisplayMedia()` that replaces the outgoing video track (camera↔screen toggle),
remote-compatible. **Verify** with a real client: video both ways; screen share
appears as normal video to the peer; toggling back to camera works.

**M4 — detached popup window** with overlay fallback + signaling IPC bridge; recover
gracefully from popup-block. **Verify**: call in popup; block popups → seamless
overlay fallback; no core-access breakage.

**M5 — CSP, permissions, privacy, settings, polish.**
- CSP: add `connect-src` for the STUN/TURN hosts from `ice_servers()` (browsers
  gate ICE via `connect-src`); `Permissions-Policy` / element `allow` for
  `camera; microphone; display-capture`. (No `frame-src` needed — no iframe.)
  Confirm `ice_servers()` returns hostnames the *browser* resolves (our WASM DNS
  is stubbed); host-side resolution is the only likely core-side snag.
- Settings: expose `WhoCanCallMe`.
- Relay UX (**decided**): **standard ICE** — direct-preferred with automatic relay
  fallback, no mid-call prompt and **no forced-relay setting in the initial build**.
  Rationale: DC's threat model is chatting with known contacts, not strangers
  harvesting your IP, so an always-relay toggle buys little in the common case; and
  forcing relay when direct would work burns relay egress bandwidth (a dominant cost
  at scale). Instead: disclose TURN/relay routing in the **privacy policy**, and add
  a **non-blocking direct-vs-relay indicator** (active candidate pair is `relay`) for
  troubleshooting. An optional always-relay ("hide my IP from contacts") mode is
  deferred for discussion in **#93**.
- Privacy docs (`README`, generated `privacy.html`): disclose STUN/TURN origins and
  relay routing.
- Content-free call analytics in `packages/web-app/src/analytics.ts` (matching the
  closed `EVENTS` policy). Ringtone/vibration, missed/busy/timeout via `call_info`,
  mobile layout. Playwright smoke: drive an outgoing call, assert
  `RTCPeerConnection` reaches `connected`. Log patch count + findings in `FINDINGS.md`.

## Files to touch

- **New** `packages/calls/` — one package, internal `engine/` (pure TS) + `ui/`
  (React) + `bridge/` glue (ours).
- `packages/web-app/src/runtime.ts` — implement the two hooks, subscribe to call
  events, mount ring/call UI, bridge to jsonrpc (replace stubs ~L648–653).
- `packages/web-app/` build/CSP/`Permissions-Policy`; `src/analytics.ts` events.
- **One** `patches/desktop/00NN-*.patch` — un-gate `ChatView.tsx` (+ optional
  `Message.tsx`) for `browser`.
- `DESCOPED.md`, `PLAN.md`, `README.md`, `FINDINGS.md`, privacy generator — docs.
- Core patch: **not expected** (contingency only if `ice_servers()`/call messaging
  hits the WASM DNS/net stubs — surfaces at M1/M5 verify).

## Reuse (don't reinvent)

- Typed client + `WasmTransport` in `packages/core-wasm` — call the call RPCs
  directly.
- Existing in-page event emitter in `runtime.ts` (the `/ws/backend` replacement) —
  subscribe `IncomingCall`/`OutgoingCallAccepted`/`IncomingCallAccepted`/`CallEnded`.
- Existing blob/avatar path (`transformBlobURL`, memfs+SW) for avatars in call UI.
- Existing camera-permission priming in `runtime.ts` (QR-reader `getUserMedia`,
  ~L1345) as the gesture/permission model.
- `chatmail/calls-echobot` as an automated far-end; `calls-webapp` **source** as
  the interop spec (payload format, ICE timing) — read it, don't ship it.
- Electron `windows/video-call.ts` as a signaling-bridge reference.

## Risks / open questions

- **Interop format** — must match `calls-webapp`'s on-wire payload exactly, or real
  DC clients can't be called. Nailed down in M0 from source.
- **Frontier churn** — upstream calls unreleased at our pin; keep the seam patch thin.
- **Relay privacy UX** — decided: standard ICE (direct-preferred, relay fallback),
  privacy-policy disclosure, direct-vs-relay indicator; no forced-relay setting for
  now. Optional always-relay mode deferred to #93. See M5.
- **Popup ⇄ core IPC** — reason overlay is default; popup is enhancement (M4).
- **`ice_servers()` on WASM** — verify it returns hostnames (browser resolves) not
  host-side DNS.
- **CSP widening** vs. the repo's single-origin privacy stance — documented decision (M5).
- **Signaling latency** — offer/answer ride DeltaChat messages; ring/connect delay is
  inherent to DC; set UX expectations (timeouts, "calling…").

## Building it (deterministic orchestration)

`.claude/workflows/calls-impl.mjs` runs this plan as a **milestone-gated
multi-agent workflow** — one milestone per invocation so the stop/go gate stays
human-owned. Per milestone it fans the build tasks out in parallel, runs an
adversarial review on the risky ones (engine state machine, interop serializer,
screenshare, popup IPC), then runs the milestone's verify and returns a structured
GO / NO-GO. It routes Opus to the high-stakes reasoning and Sonnet to the
mechanical bulk, and it never commits or pushes — you review the diff and commit.

```
Workflow({ name: 'calls-impl', args: 'M0' })   // then M1, M2, … after each review
```

## Verification (end to end)

Real second client (Android/desktop DeltaChat or `calls-echobot`): audio then video
connect both ways, device switching + speaking rings work, screen share shows as
video to the peer, hangup tears down both ends, popup-block falls back to overlay, no
CSP errors, PWA still installable, privacy page regenerates. Playwright smoke asserts
`RTCPeerConnection` reaches `connected`. Record patch count + findings in `FINDINGS.md`.
