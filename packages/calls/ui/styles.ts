/**
 * Shared inline-style tokens for the call UI. Plain objects rather than CSS
 * modules — this package has no CSS build step, matching the runtime's
 * vanilla dialogs. Dark, fixed palette (not theme-aware), same
 * simplification the runtime's own dialogs make.
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
 * Mobile layout — spread AFTER `card` below the phone breakpoint: full-bleed
 * instead of a floating panel (a call is a full-attention moment on a phone).
 * `env(safe-area-inset-*)` keeps controls clear of a notch/home-indicator.
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
 * Desktop layout — spread AFTER `card`: centers + enlarges the panel and
 * paints a full-viewport dim behind it via the `0 0 0 100vmax` box-shadow
 * trick (no extra DOM node). The dim is visual only — box-shadow doesn't
 * capture pointer events, so the app behind stays usable during a call.
 */
export const cardDesktop: CSSProperties = {
  top: '50%',
  transform: 'translate(-50%, -50%)',
  // ONE fixed width for audio and video alike — the card must not resize
  // when video starts/stops mid-call (stable layout).
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
  // Reserve one line so an empty status doesn't collapse the row.
  minHeight: '1.5em',
}

/** The single persistent participant stage — one fixed-size box regardless
 * of who is sending video (stable layout). `background` is overridden
 * inline: `#000` behind video, `#141414` behind the ring. */
export const videoStage: CSSProperties = {
  position: 'relative',
  width: '100%',
  borderRadius: 10,
  overflow: 'hidden',
  background: '#141414',
}

/** Mobile: fill whatever vertical space `cardMobile` leaves above the
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

/** The always-present local self-view slot in the stage corner — local
 * `<video>` while local video flows, else the small speaking ring. */
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

/** The remote participant as a centered speaking ring whenever the remote
 * isn't sending video — same stage, no subtree swap. */
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
  // Wide enough for the longer of each toggle's labels (Mute↔Unmute) so a
  // state flip never resizes the row.
  minWidth: 110,
}

/** Mobile: bigger touch targets (44px iOS/Android minimum tap-target
 * guidance) for controls as consequential as hang-up/accept/decline. */
export const buttonMobile: CSSProperties = {
  padding: '14px 22px',
  fontSize: 16,
  minHeight: 48,
}

export const COLOR_ACCEPT = '#2ea043'
export const COLOR_DECLINE = '#d13d3d'
export const COLOR_NEUTRAL = '#333'
export const COLOR_NEUTRAL_ACTIVE = '#555'

/** Small muted-mic badge overlaid on a participant tile/ring. Absolutely
 * positioned by the caller — zero layout impact. */
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

/** One always-rendered fixed-height slot below the status line (route
 * indicator / inline screen-share error / empty) — so neither
 * appearing/vanishing shifts the layout. */
export const infoSlot: CSSProperties = {
  minHeight: 18,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
}

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

/** Direct-vs-relay indicator — small, muted text, never a dialog/alert. */
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

/** Direct = calm green; relay = neutral amber, not an alarm color — this is
 * troubleshooting info, not an error. */
export const COLOR_ROUTE_DIRECT = '#2ea043'
export const COLOR_ROUTE_RELAY = '#d4a72c'
