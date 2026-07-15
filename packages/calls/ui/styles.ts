/**
 * Shared inline-style tokens for the call UI. Plain objects (not CSS
 * modules/SASS) to match `packages/web-app/src/runtime.ts`'s existing vanilla
 * dialogs (`showFatalDialog` et al.) — this package has no CSS build step of
 * its own, and the runtime bundle intentionally stays free of a stylesheet
 * pipeline. Dark, fixed palette (not theme-aware) — same simplification the
 * runtime's own dialogs already make.
 */
import type { CSSProperties } from 'react'

export const card: CSSProperties = {
  position: 'fixed',
  top: 16,
  left: '50%',
  transform: 'translateX(-50%)',
  zIndex: 2147483647,
  width: 'min(340px, 92vw)',
  boxSizing: 'border-box',
  padding: '16px 18px',
  borderRadius: 12,
  border: '1px solid rgba(255,255,255,.08)',
  background: '#1e1e1e',
  color: '#eee',
  font: '14px/1.5 system-ui, sans-serif',
  boxShadow: '0 8px 40px rgba(0,0,0,.5)',
  display: 'flex',
  flexDirection: 'column',
  gap: 12,
  alignItems: 'center',
  textAlign: 'center',
}

/**
 * M5 mobile-viewport layout (docs/calls.md) — spread AFTER `card` (`{
 * ...card, ...cardMobile }`, see `useIsMobileViewport`) below the phone
 * breakpoint: full-bleed instead of a small floating panel, since an
 * incoming ring or an in-call video view is a full-attention moment on a
 * phone, not a corner toast. `env(safe-area-inset-*)` keeps controls clear of
 * a notch/home-indicator on an installed PWA.
 */
export const cardMobile: CSSProperties = {
  top: 0,
  right: 0,
  bottom: 0,
  left: 0,
  transform: 'none',
  width: '100%',
  height: '100%',
  maxWidth: 'none',
  borderRadius: 0,
  justifyContent: 'center',
  overflowY: 'auto',
  paddingTop: 'max(20px, env(safe-area-inset-top))',
  paddingBottom: 'max(20px, env(safe-area-inset-bottom))',
  paddingLeft: 'max(18px, env(safe-area-inset-left))',
  paddingRight: 'max(18px, env(safe-area-inset-right))',
}

/**
 * Desktop layout — spread AFTER `card` on a non-mobile viewport. The base
 * `card` is a small top-anchored panel (fine on a phone / as a ring toast);
 * on a desktop window that leaves the call as a tiny corner widget in a sea of
 * empty space. This centers it in the viewport, enlarges it, and paints a
 * full-viewport dim behind it (the `0 0 0 100vmax` box-shadow trick — no extra
 * DOM node) so an active call reads as a focused surface that uses the space,
 * not a notification. The dim is visual only (box-shadow doesn't capture
 * pointer events), so the app behind stays usable during a call.
 */
export const cardDesktop: CSSProperties = {
  top: '50%',
  transform: 'translate(-50%, -50%)',
  // ONE fixed width for audio and video alike — the card must not resize
  // when video starts/stops mid-call (stable-layout, F).
  width: 'min(720px, 92vw)',
  maxHeight: '92vh',
  overflowY: 'auto',
  padding: '24px 28px',
  gap: 16,
  boxShadow: '0 16px 56px rgba(0,0,0,.55), 0 0 0 100vmax rgba(0,0,0,.55)',
}

/** Desktop stage: fixed height so toggling video never resizes the card. */
export const videoStageDesktop: CSSProperties = {
  height: 'min(52vh, 520px)',
}

export const title: CSSProperties = {
  fontSize: 16,
  fontWeight: 600,
}

export const subtitle: CSSProperties = {
  fontSize: 13,
  color: '#a8a8a8',
  // Reserve one line so an empty status ('idle'/'ended') doesn't collapse
  // the row (stable-layout, F).
  minHeight: '1.5em',
}

/** The single persistent participant stage: remote video OR the remote
 * speaking ring, with the local self-view always in the corner PiP slot —
 * one fixed-size box regardless of who is sending video (stable-layout, F).
 * `background` is overridden inline: `#000` behind video, `#141414` behind
 * the ring. */
export const videoStage: CSSProperties = {
  position: 'relative',
  width: '100%',
  borderRadius: 10,
  overflow: 'hidden',
  background: '#141414',
}

/** M5 mobile: fill whatever vertical space `cardMobile` leaves above the
 * controls instead of a fixed height. */
export const videoStageMobile: CSSProperties = {
  flex: 1,
  minHeight: 0,
}

export const remoteVideo: CSSProperties = {
  width: '100%',
  height: '100%',
  objectFit: 'cover',
  display: 'block',
  background: '#000',
}

/** The always-present local self-view slot in the stage corner — holds the
 * local `<video>` while local video flows, else the small local speaking
 * ring, so the local participant never mounts/unmounts (stable-layout, F). */
export const localPip: CSSProperties = {
  position: 'absolute',
  right: 8,
  bottom: 8,
}

export const localVideo: CSSProperties = {
  display: 'block',
  width: 110,
  aspectRatio: '4 / 3',
  objectFit: 'cover',
  borderRadius: 6,
  border: '1px solid rgba(255,255,255,.35)',
  background: '#111',
}

/** The remote participant as a centered speaking ring (with avatar) whenever
 * the remote isn't sending video — same stage, no subtree swap. Its audio
 * rides the always-mounted hidden `<audio>` sink. */
export const remoteRingInStage: CSSProperties = {
  position: 'absolute',
  inset: 0,
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 8,
}

export const participantLabel: CSSProperties = {
  fontSize: 12,
  color: '#c8c8c8',
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  maxWidth: '100%',
}

export const errorText: CSSProperties = {
  ...subtitle,
  color: '#ff8080',
}

export const buttonRow: CSSProperties = {
  display: 'flex',
  gap: 8,
  justifyContent: 'center',
  marginTop: 4,
}

export const button: CSSProperties = {
  padding: '8px 14px',
  borderRadius: 6,
  border: 'none',
  cursor: 'pointer',
  fontSize: 13,
  color: '#fff',
  // Wide enough for the longer of each toggle's labels (Mute↔Unmute,
  // Share↔Stop) so a state flip never resizes the row (stable-layout, F).
  minWidth: 110,
}

/** M5 mobile: bigger touch targets (44px is the usual iOS/Android minimum
 * tap-target guidance) — a mouse-sized button is an easy mis-tap on a phone
 * for controls as consequential as hang-up/accept/decline. */
export const buttonMobile: CSSProperties = {
  padding: '14px 22px',
  fontSize: 16,
  minHeight: 48,
}

export const COLOR_ACCEPT = '#2ea043'
export const COLOR_DECLINE = '#d13d3d'
export const COLOR_NEUTRAL = '#333'
export const COLOR_NEUTRAL_ACTIVE = '#555'

/** Small muted-mic badge overlaid on a participant tile/ring (remote when
 * the peer reports muted, local PiP when locally muted). Absolutely
 * positioned by the caller — zero layout impact (stable-layout, F). */
export const muteBadge: CSSProperties = {
  position: 'absolute',
  width: 18,
  height: 18,
  borderRadius: '50%',
  background: COLOR_DECLINE,
  color: '#fff',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  boxShadow: '0 1px 4px rgba(0,0,0,.4)',
  pointerEvents: 'none',
}

/** One always-rendered fixed-height slot below the status line: the M5
 * route indicator once connected, an inline screen-share error when set,
 * else empty — so neither appearing/vanishing shifts the layout. */
export const infoSlot: CSSProperties = {
  minHeight: 18,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
}

/** M2 device picker (docs/calls.md: "when more than one mic/camera exists,
 * let the user choose"). One row per kind, each only rendered when
 * `shouldShowDevicePicker` says so — see `DevicePicker.tsx`. */
export const deviceRow: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  width: '100%',
  fontSize: 13,
}

export const deviceLabel: CSSProperties = {
  color: '#a8a8a8',
  flexShrink: 0,
}

export const deviceSelect: CSSProperties = {
  flex: 1,
  minWidth: 0,
  padding: '5px 8px',
  borderRadius: 6,
  border: '1px solid #444',
  background: '#2a2a2a',
  color: '#eee',
  fontSize: 13,
}

export const deviceSwitchError: CSSProperties = {
  ...errorText,
  fontSize: 12,
}

/** M5 direct-vs-relay indicator (docs/calls.md: "a non-blocking
 * direct-vs-relay connection indicator") — small, muted text, never a
 * dialog/alert; a colored dot does the "at a glance" job, the label + native
 * `title` tooltip carry the detail. */
export const connectionRoute: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  fontSize: 11,
  color: '#8a8a8a',
}

export const connectionRouteDot: CSSProperties = {
  display: 'inline-block',
  width: 7,
  height: 7,
  borderRadius: '50%',
  flexShrink: 0,
}

/** Direct = the normal/expected path (calm green); relay = still perfectly
 * fine, just worth knowing (neutral amber, not an alarm color — this is
 * troubleshooting info, not an error). */
export const COLOR_ROUTE_DIRECT = '#2ea043'
export const COLOR_ROUTE_RELAY = '#d4a72c'
