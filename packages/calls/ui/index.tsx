/**
 * ui/ — the React call surface: incoming-ring dialog + the in-page call
 * overlay. Consumes engine/'s call state via `CallsUiStore`; mounted once by
 * `packages/web-app/src/runtime.ts` (`mountCallsUi`) — see docs/calls.md
 * §Windowing for why ringing always renders in the main window.
 *
 * The components themselves are deliberately NOT re-exported here: they are
 * reached through `mountCallsUi`, and the ones that compose (CallsRoot ->
 * CallOverlay -> SpeakingRing/DevicePicker) import each other by path.
 */
export { CallsUiStore, type CallUiSnapshot, type CallsUiCallbacks } from './calls-store.ts'
export { mountCallsUi } from './mount.tsx'
