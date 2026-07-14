/**
 * ui/ — the React call surface (docs/calls.md): incoming-ring dialog + the
 * in-page call overlay (hangup, mute). Consumes engine/'s observable call
 * state via `CallsUiStore`; mounted once by
 * `packages/web-app/src/runtime.ts` (`mountCallsUi`) — see docs/calls.md
 * §Windowing for why ringing always renders in the main window.
 *
 * M1 surface: audio-only happy path — incoming ring (accept/decline) and an
 * in-call overlay with hang up + mute. No video, no device pickers (M2/M3),
 * no detached popup window (M4) — those extend this same store/root without
 * changing the shape below.
 */
export { CallsUiStore, type CallUiSnapshot, type CallsUiCallbacks } from './calls-store.ts'
export { mountCallsUi } from './mount.tsx'
export { CallsRoot, type CallsRootProps } from './CallsRoot.tsx'
export { IncomingCallRing, type IncomingCallRingProps } from './IncomingCallRing.tsx'
export { CallOverlay, type CallOverlayProps } from './CallOverlay.tsx'
