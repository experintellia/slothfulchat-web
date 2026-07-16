/**
 * ui/ — the React call surface: incoming-ring dialog + the in-page call
 * overlay. Consumes engine/'s call state via `CallsUiStore`; mounted once by
 * `packages/web-app/src/runtime.ts` (`mountCallsUi`) — see docs/calls.md
 * §Windowing for why ringing always renders in the main window.
 */
export { CallsUiStore, type CallUiSnapshot, type CallsUiCallbacks } from './calls-store.ts'
export { mountCallsUi } from './mount.tsx'
export { CallsRoot, type CallsRootProps } from './CallsRoot.tsx'
export { IncomingCallRing, type IncomingCallRingProps } from './IncomingCallRing.tsx'
export { CallOverlay, type CallOverlayProps } from './CallOverlay.tsx'
export { SpeakingRing, type SpeakingRingProps } from './SpeakingRing.tsx'
export { DevicePicker, type DevicePickerProps } from './DevicePicker.tsx'
