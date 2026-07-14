# @slothfulchat/calls

Native 1:1 WebRTC calls: our own peer, wire-compatible with real Delta Chat
clients (which run [`deltachat/calls-webapp`](https://github.com/deltachat/calls-webapp)).
See [`docs/calls.md`](../../docs/calls.md) for the full design (why we
reimplement instead of embedding the upstream webapp, the interop constraints,
the windowing model, and the milestone plan) and
[`engine/INTEROP.md`](engine/INTEROP.md) for the exact wire-format spec.

**Status:** M1 (audio call, happy path), M2 (Web-Audio speaking rings +
mic/camera device enumeration with mid-call mic hot-switching —
`engine/level-meter.ts`/`ui/SpeakingRing.tsx`, `engine/devices.ts`/
`AudioCallEngine.switchMicrophone`/`ui/DevicePicker.tsx`), M3 (camera
video + screen share — `AudioCallEngine`'s `hasVideo`, `switchCamera`,
`startScreenShare`/`stopScreenShare` via `RTCRtpSender.replaceTrack`), and M4
(detached popup window + overlay fallback + popup⇄opener signaling relay —
`bridge/popup-signaling.ts`/`popup-host.ts`/`popup-client.ts`/`window-port.ts`,
with `packages/web-app/src/call-popup.ts` as the popup DOM entry) are landed.
M5 (CSP/permissions/privacy/settings/polish) pending.

## Layout — an enforced split, not just a folder convention

```
engine/   pure TS, ZERO React/DOM imports — the WebRTC state machine,
          non-trickle ICE gathering, calls-webapp-compatible offer/answer
          (de)serialization. Location-agnostic: runs the same in an overlay
          or a detached popup.
ui/       React — incoming-ring dialog (IncomingCallRing), in-page call
          overlay with hangup + mute (CallOverlay), switched by CallsRoot off
          the observable CallsUiStore. M2 adds per-participant speaking rings
          (SpeakingRing, driven by the bridge's Web-Audio meters) and a
          mic/camera DevicePicker (only shown when a kind has >1 device).
          M3 adds video tiles (remote + local self-preview) in place of the
          speaking rings for a video call, and a screen-share toggle button.
bridge/   thin glue — connects engine/ to the typed jsonrpc client
          (rpc.placeOutgoingCall/acceptIncomingCall/endCall/iceServers/
          callInfo) and the popup<->opener signaling relay (M4:
          popup-signaling.ts = protocol + RPC relay + SignalingPort seam
          [DOM-free, unit-tested]; window-port.ts = the postMessage transport;
          popup-host.ts = the opener side [handshake, fallback, event
          forwarding]; popup-client.ts = the popup side).
```

`engine/` may be imported by `ui/` and `bridge/`, never the other way around.
`engine/` importing `react`, `react-dom`, or anything under `../ui`/`../bridge`
is a broken invariant, not a style nit — see the enforcement below.

## Why the split is enforced, not just documented

1. **Type level** — `engine/tsconfig.json` has no `"jsx"` (JSX literally
   cannot appear in `engine/` source). It *does* include the `"DOM"` lib,
   because `RTCPeerConnection`/`MediaStream`/etc. are ambient WebRTC types
   with no import statement attached — that's not the same thing as a DOM
   *import*. `ui/tsconfig.json` and `bridge/tsconfig.json` are the React/DOM
   supersets.
2. **Import level** — `../../scripts/check-calls-engine-boundary.mjs` walks
   `engine/**/*.ts` and fails on any `react`/`react-dom` import, any `.tsx`
   file, or any relative import reaching into `../ui`/`../bridge`. Run it via
   `pnpm --filter @slothfulchat/calls lint:engine-boundary`.

## Build & test

```sh
pnpm --filter @slothfulchat/calls build                # tsc --noEmit, per subfolder
pnpm --filter @slothfulchat/calls lint:engine-boundary  # the import-boundary check
pnpm --filter @slothfulchat/calls test                  # node --test engine/*.test.ts
```

Tests run on Node's built-in type-stripping test runner directly against the
`.ts` sources — no build step, no bundler. That means engine/ code must stick
to *erasable* TS syntax (no constructor parameter properties, no enums, no
namespaces); `erasableSyntaxOnly` in `tsconfig.base.json` catches violations
at typecheck time instead of at `node --test` runtime.

## Consumption

Not published to npm (`"private": true`) — it's consumed only via the pnpm
workspace, from `packages/web-app`, whose `tsconfig.json` maps
`@slothfulchat/calls/{engine,ui,bridge}` straight to this package's source
(same pattern `@slothfulchat/core-wasm` uses: esbuild honors the same
`tsconfig.json` "paths", so the bundle also builds from source — no dist/
output for this package at all).
