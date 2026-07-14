# Changelog

## Unreleased

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
