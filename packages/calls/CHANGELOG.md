# Changelog

Headings here track the release train (`vX.Y.Z`) — the version this package
actually shipped in. Its own `package.json` stays at `0.0.0`: it is private,
not published to npm, and ships inside web-app, so `scripts/set-release-version.mjs`
deliberately leaves it out of the synced bump.

## 0.9.0 — 2026-08-15

- An incoming call now offers **Accept** (audio only) and **Accept with
  video**, so the caller's offer no longer decides whether the callee's
  camera starts. The camera can still be turned on once the call is
  connected.

## 0.6.0 — 2026-07-15

- Added native 1:1 WebRTC calls — **audio, video, and screen share** —
  wire-compatible with upstream `deltachat/calls-webapp` (raw-SDP offer/answer
  over DeltaChat messages, non-trickle ICE). Also includes mic/camera selection
  with mid-call hot-switching, avatar speaking-ring indicators, mute, a
  direct-vs-relay indicator, ringtone/vibration, content-free call analytics,
  and a mobile layout. The active call runs in a detached popup window when
  allowed and falls back to an in-page overlay; ringing always stays in the
  main window. Package split: `engine/` (pure TS, no React/DOM), `ui/` (React),
  `bridge/` (glue). See [`docs/calls.md`](../../docs/calls.md).
