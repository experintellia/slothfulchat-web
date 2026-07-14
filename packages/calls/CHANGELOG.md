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
