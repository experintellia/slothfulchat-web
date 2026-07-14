# Changelog

## Unreleased

- M5 (content-free call analytics; ringtone/vibration; mobile layout): new
  `packages/web-app/src/events.mjs`/`analytics.ts` `call` event (`direction`,
  `has_video`, `result` — never who was on the call, its duration, or any
  signaling/media payload); `packages/web-app/src/runtime.ts`'s `CallManager`
  reports it exactly once per call via a new `reportCallOutcome`, at the one
  choke point (`teardown`) every ending path already funnels through.
  `connected` is tracked locally (`onState`, or the popup's own report — see
  below); a hangup we initiate before connecting is an unambiguous local
  `declined`/`cancelled`; a second incoming call while already on one is
  auto-declined as `busy` (a purely local, this-device notion — core has no
  such state) instead of being silently ignored as before. Everything else
  (far end hung up first, a ring timed out, a pre-`placeOutgoingCall` setup
  failure) is genuinely ambiguous, so it's resolved via the new
  `rpc.callInfo(accountId, msgId)` (`CallsRpcClient`) and
  `bridge/call-outcome.ts`'s `classifyCallOutcome` — the per-direction mapping
  of core's `CallInfo.state` (`Missed`/`Declined`/`Canceled`, whose meaning
  flips depending on which side placed the call — documented in that file)
  onto `missed`/`declined`/`timeout`. Because M4's popup runs its OWN engine
  (the opener's `onState` never fires in `mode: 'popup'`), the popup⇄opener
  protocol (`popup-signaling.ts`) gained one optional field —
  `PopupToOpenerMessage`'s `ended.reachedConnected` — so `call-popup.ts` can
  tell the opener whether ITS engine ever connected; a missing/abrupt-close
  value defaults to `false` (undercounts rather than fabricates). New
  `bridge/ringtone.ts` (`RingtonePlayer`): a looping incoming-call ringtone
  synthesized with a Web Audio oscillator (gated by a `GainNode`, no bundled
  audio asset) plus a `navigator.vibrate` pattern, started the moment the
  ring dialog shows and stopped on accept/decline/any teardown — best-effort
  throughout (a browser with no Web Audio/vibrate just rings silently). New
  `ui/useIsMobileViewport.ts` (a `matchMedia` `useSyncExternalStore` hook) and
  `styles.ts`'s `*Mobile` tokens: below the phone breakpoint, `CallOverlay`/
  `IncomingCallRing` go full-bleed (`env(safe-area-inset-*)`-aware) instead of
  a small floating card, the video stage fills available height instead of a
  fixed 4/3 ratio, and buttons get bigger touch targets — a ring or an in-call
  video view is a full-attention moment on a phone, not a corner toast.
- M5 (direct-vs-relay indicator; settings; privacy docs): new
  `engine/connection-route.ts` — `getActiveConnectionRoute(pc)` inspects
  `RTCPeerConnection.getStats()` for the currently-active candidate pair
  (`nominated && succeeded`, or any `succeeded` pair as a fallback) and reports
  `'direct'`/`'relay'`/`'unknown'` (relay if either side's `candidateType` is
  `relay`); `ConnectionRouteMonitor` polls it (3s default, injectable timers)
  and calls back only on an actual change, mirroring `level-meter.ts`'s
  `TrackLevelMeter`. `AudioCallEngine.getConnectionRoute()` exposes it
  (`getStats` added to `PeerConnectionLike`); `CallBridge` starts the monitor
  on `connected`/stops it on `ended` and forwards changes via a new
  `onConnectionRouteChanged` callback, wired into `CallsUiStore` by both the
  overlay path (`runtime.ts`) and the popup path (`call-popup.ts`, M4) — one
  seam covers both windowing modes. `CallOverlay` shows it as a small,
  non-blocking dot + label + tooltip under the status line once `connected`;
  purely informational, and NOT a forced-relay setting (none exists — see
  issue #93). Un-gated the upstream `WhoCanCallMe` toggle in
  `Notifications.tsx` for the browser target (folded into the existing
  `patches/desktop/0047` un-gate patch alongside `ChatView.tsx`'s call button
  — same one-line gate, same reason — so patch count stays unchanged). README
  "Privacy & data protection" and the generated `privacy.html` now disclose
  the STUN/TURN relay origin (the same chatmail relay `ice_servers()` already
  uses), the no-forced-relay stance, and that media is DTLS-SRTP encrypted
  end-to-end regardless of path.
- M4 (detached popup window + overlay fallback): the active call now prefers a
  same-origin `window.open` popup that hosts the engine + UI and owns media +
  `RTCPeerConnection`, relaying SIGNALING ONLY to the opener; the opener
  forwards to the core Worker (which stays owned by the main tab). New
  `bridge/popup-signaling.ts` is the pure wire protocol — a `SignalingPort`
  transport seam (DOM-free, so the whole relay is unit-tested against an
  in-memory pair), a validated message union (`parsePopupMessage` rejects
  foreign/malformed `postMessage`s), and the RPC relay: `PopupRpcClient` (a
  `CallsRpcClient` whose calls travel to the opener) + `servePopupRpc` (opener
  side, drives the real jsonrpc client, captures the placed msg id for event
  routing). `window-port.ts` is the production `postMessage` transport
  (same-origin + exact-peer-window guards). `popup-host.ts` is the opener
  lifecycle: `window.open` → handshake with a readiness timeout → `init`
  handoff → forward `OutgoingCallAccepted`/`CallEnded`/`IncomingCallAccepted`;
  a synchronous popup-block (`window.open` → `null`) returns `null` so the
  caller falls back to the overlay in-gesture, a handshake timeout closes the
  blank window and calls `onFallback`, and an abrupt window close sends a
  safety-net `endCall`. `popup-client.ts` is the popup side (`connectCallPopup`:
  posts `ready`, awaits `init`, surfaces relayed core events). The popup DOM
  entry lives in the web app (`packages/web-app/src/call-popup.ts` +
  `static/call-popup.html`, bundled by esbuild alongside runtime.js) — it
  re-homes the runtime's `CallManager` wiring into the popup (same `CallBridge`,
  `CallsUiStore`, `mountCallsUi`, device pickers, speaking rings) with the
  relayed `PopupRpcClient` as its `rpc`. `packages/web-app/src/runtime.ts`'s
  `CallManager` gained a `mode: 'overlay' | 'popup'` per call: outgoing tries
  the popup in the click gesture, incoming rings in the main window (always)
  and hands the accepted call off to a popup on accept; both fall back to the
  M1 overlay path unchanged. 10 new bridge unit tests cover message
  validation, the RPC relay roundtrip + error/dispose paths, the handshake +
  event forwarding, the handshake-timeout fallback, and the abrupt-close
  `endCall` safety net (incl. that a remote `CallEnded` suppresses it).
- New package: `engine/` (pure TS, no React/DOM imports) + `ui/` (React) +
  `bridge/` (runtime glue) skeleton, wired into the pnpm workspace and the
  `@slothfulchat/web-app` build (workspace dependency + `tsconfig.json`
  "paths"). The engine/ui/bridge split is enforced at both the type level
  (`engine/tsconfig.json` has no `"jsx"`) and the import level
  (`scripts/check-calls-engine-boundary.mjs`, wired as `lint:engine-boundary`).
  No feature logic yet — see `docs/calls.md` for the milestone plan.
- M1 (audio call, happy path): `engine/audio-call.ts` (`AudioCallEngine`) +
  `engine/call-state.ts` (`CallStateMachine`) implement the outgoing/incoming
  offer/answer orchestration over non-trickle ICE with epoch-guarded teardown;
  `bridge/index.ts` (`CallBridge`) drives it against the typed jsonrpc client.
  Added local mute (`AudioCallEngine.setMuted`/`toggleMuted`, mirrored on
  `CallBridge`) — a `track.enabled` toggle on the local audio track, no
  signaling round-trip.
- `ui/`: the incoming-ring dialog (`IncomingCallRing`) and the in-page call
  overlay with hangup + mute (`CallOverlay`), switched by `CallsRoot` off a
  small observable `CallsUiStore` snapshot (docs/calls.md: ui/ "consumes the
  engine's observable call state"). `mountCallsUi` mounts the tree once into
  a dedicated `document.body` container — "always mounted in the main window"
  per docs/calls.md §Windowing — no video/device pickers yet (M2/M3), no
  detached popup (M4). `packages/web-app/src/runtime.ts`'s `CallManager` now
  subscribes to `IncomingCall`/`OutgoingCallAccepted`/`IncomingCallAccepted`/
  `CallEnded` on the core's in-page emitter, drives `CallBridge`, and pushes
  state into the shared `CallsUiStore` instead of hand-rolled DOM.
- Teardown hardening: `gatherUntilEnoughIce` takes an optional `AbortSignal`,
  and `AudioCallEngine` aborts it on `end()`. Without this, hanging up while
  parked at `await gathered` never resolved — a closed `pc` emits no further
  ICE events, so the gather promise (and the `await placeCall()`/`accept()`
  above it) would wait forever, retaining the closed connection. Covered by a
  regression test that drives the *real* gather (not an injected stub).
- M2 (speaking rings): `engine/level-meter.ts` (`TrackLevelMeter`,
  `computeRmsLevel`) adds per-track Web-Audio level metering — an
  `AnalyserLike` seam (no DOM/`AudioContext` import in `engine/`) polled on an
  interval with an exponential moving average so a CSS-driven ring doesn't
  jitter. `bridge/index.ts` adds `createTrackAnalyser` (the one place that
  constructs a real `AudioContext`/`AnalyserNode`, mirroring
  `defaultMediaFactories`), wires one meter each to the local mic and the
  remote peer's track as soon as they exist, and surfaces both via new
  `CallBridgeCallbacks.onLocalLevel`/`onRemoteLevel`. `ui/SpeakingRing.tsx` is
  the glowing per-participant ring (Discord/Jitsi style, docs/calls.md);
  `CallOverlay` now renders one for "You" and one for the remote party, driven
  by two new `CallsUiStore` fields (`localLevel`/`remoteLevel`) that
  `packages/web-app/src/runtime.ts`'s `CallManager` feeds from the bridge.
  Device pickers/mid-call mic switching are a separate M2 build task.
- M2 (device selection): `engine/devices.ts` enumerates mics/cameras behind an
  injected `DeviceEnumerator` seam (mirrors `AudioCallMediaFactories` —
  `navigator.mediaDevices.enumerateDevices` is only ever called from
  `bridge/index.ts`'s `defaultDeviceEnumerator`), with `shouldShowDevicePicker`
  encoding the "only show a picker when >1 device of a kind exists" rule and a
  numbered-label fallback for the pre-permission empty-label case.
  `AudioCallEngine.switchMicrophone` hot-switches the outgoing mic mid-call via
  `RTCRtpSender.replaceTrack` — no renegotiation (the audio m-line/codec set is
  unchanged, so no new offer/answer round-trip over DeltaChat messaging); a
  failure reports the new `onDeviceSwitchError` callback and leaves the
  previous track flowing rather than ending the call. A new
  `onLocalTrackChanged` callback fires on both the initial mic acquisition and
  every successful switch — the precise "local track (re)ready" seam the
  speaking-ring level meter needed to re-tap on a switch (`bridge/index.ts`'s
  `retapLocalLevelMeter`, replacing an earlier "retry every state change"
  approximation). `ui/DevicePicker.tsx` renders a `<select>` per kind (mic,
  camera), each independently gated by `shouldShowDevicePicker`; wired into
  `CallOverlay` alongside mute. The camera picker only records a preference
  for now — M2 is still audio-only end-to-end, so there is no live video
  track to hot-switch until M3. `packages/web-app/src/runtime.ts`'s
  `CallManager` enumerates once the local stream exists, seeds the initial
  selection from the real in-use device (`localStream`'s
  `getSettings().deviceId`, not just "first enumerated"), and re-enumerates on
  `devicechange` for the lifetime of the call.
- M3 (video + screen share): `AudioCallEngine` gains a `hasVideo` constructor
  option — `placeCall`/`accept` now also acquire a camera track and `addTrack`
  it alongside the mic (an ordinary second m-line; a `calls-webapp` peer that
  itself sent `has_video: true` expects, and symmetrically sends, one back).
  The resulting video `RTCRtpSender` is what `startScreenShare`/
  `stopScreenShare` `replaceTrack` on: `startScreenShare` takes it over via
  `getDisplayMedia()` — no renegotiation, no new m-line, so the remote peer
  sees an ordinary "the video track changed" moment, not a screen-share
  protocol; `stopScreenShare` re-acquires the camera and `replaceTrack`s it
  back, restoring the camera exactly. The browser's own "Stop sharing"
  affordance ending the capture track is handled identically to an explicit
  toggle. Failures (no video on this call, capture unavailable, the share
  picker cancelled, camera didn't come back) report the new
  `onScreenShareError` and never end the call — same contract as
  `onDeviceSwitchError`. `switchCamera` mirrors `switchMicrophone` for the
  video sender (hot-switch via `replaceTrack` when the camera is live;
  records a preference instead when currently screen-sharing, closing the M2
  "camera picker only records a preference" gap). `bridge/index.ts` wires
  `hasVideo` both ways — `OutgoingCallParams.hasVideo`/
  `IncomingCallParams.hasVideo` (the latter mirroring the caller's own
  `has_video` from the `IncomingCall` event, since `accept_incoming_call` has
  no separate RPC parameter for it) — and adds
  `startScreenShare`/`stopScreenShare`/`toggleScreenShare`/`switchCamera` plus
  `defaultMediaFactories().getDisplayMedia` (feature-detected). `ui/CallOverlay`
  renders `<video>` tiles (remote + local self-preview) instead of the
  audio-only `SpeakingRing` row when `hasVideo`, plus a screen-share toggle
  button; `CallsUiStore` gains `hasVideo`/`localStream`/`screenSharing`/
  `screenShareError`. `packages/web-app/src/runtime.ts` no longer ignores
  `startWithCameraEnabled` — upstream `ChatView`'s existing "start_audio_call"
  vs. "start_video_call" context-menu entries (both already call
  `startOutgoingVideoCall` with that flag; no frontend/patch change needed)
  now actually start a video call, and incoming calls mirror the caller's
  `has_video`. 18 new engine unit tests cover camera-track addition, screen
  share start/stop/toggle, the native "Stop sharing" auto-restore path,
  `switchCamera` (including the "while sharing" no-op-on-the-wire case), and
  the teardown/race-freedom discipline already established for
  `switchMicrophone`.
