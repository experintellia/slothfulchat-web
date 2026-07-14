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
