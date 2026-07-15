# Changelog

## Unreleased

- Added native 1:1 WebRTC calls — **audio, video, and screen share** —
  wire-compatible with upstream `deltachat/calls-webapp` (raw-SDP offer/answer
  over DeltaChat messages, non-trickle ICE). Also includes mic/camera selection
  with mid-call hot-switching, avatar speaking-ring indicators, mute, a
  direct-vs-relay indicator, ringtone/vibration, content-free call analytics,
  and a mobile layout. The active call runs in a detached popup window when
  allowed and falls back to an in-page overlay; ringing always stays in the
  main window. Package split: `engine/` (pure TS, no React/DOM), `ui/` (React),
  `bridge/` (glue). See [`docs/calls.md`](../../docs/calls.md).
