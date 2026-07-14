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
  background: '#1e1e1e',
  color: '#eee',
  font: '14px/1.5 system-ui, sans-serif',
  boxShadow: '0 8px 40px rgba(0,0,0,.5)',
  display: 'flex',
  flexDirection: 'column',
  gap: 10,
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

export const title: CSSProperties = {
  fontSize: 16,
  fontWeight: 600,
}

export const subtitle: CSSProperties = {
  fontSize: 13,
  color: '#a8a8a8',
}

/** M2 speaking rings: the row holding the local + remote `SpeakingRing`
 * tiles. Only rendered for an audio-only call (`!hasVideo`, M3) — a video
 * call renders `videoStage` below instead, since the video frame itself is
 * the participant tile. */
export const participantsRow: CSSProperties = {
  display: 'flex',
  gap: 24,
  justifyContent: 'center',
  margin: '2px 0',
}

/** M3 video call: the remote video frame with a small local self-preview
 * picture-in-picture, replacing `participantsRow` when `hasVideo`. */
export const videoStage: CSSProperties = {
  position: 'relative',
  width: '100%',
  aspectRatio: '4 / 3',
  borderRadius: 10,
  overflow: 'hidden',
  background: '#000',
}

/** M5 mobile: a fixed 4/3 stage wastes most of a phone's (usually taller
 * portrait) screen — let the video fill whatever vertical space `cardMobile`
 * leaves above the controls instead of a fixed ratio. */
export const videoStageMobile: CSSProperties = {
  flex: 1,
  minHeight: 0,
  width: '100%',
  aspectRatio: 'auto',
}

export const remoteVideo: CSSProperties = {
  width: '100%',
  height: '100%',
  objectFit: 'cover',
  display: 'block',
  background: '#000',
}

export const localVideo: CSSProperties = {
  position: 'absolute',
  right: 8,
  bottom: 8,
  width: '28%',
  maxWidth: 110,
  aspectRatio: '4 / 3',
  objectFit: 'cover',
  borderRadius: 6,
  border: '1px solid rgba(255,255,255,.35)',
  background: '#111',
}

export const participantColumn: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  gap: 6,
  maxWidth: 110,
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
  gap: 10,
  justifyContent: 'center',
  marginTop: 4,
}

export const button: CSSProperties = {
  padding: '9px 18px',
  borderRadius: 8,
  border: 'none',
  cursor: 'pointer',
  fontSize: 14,
  color: '#fff',
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
