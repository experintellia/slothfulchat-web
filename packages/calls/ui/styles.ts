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

export const title: CSSProperties = {
  fontSize: 16,
  fontWeight: 600,
}

export const subtitle: CSSProperties = {
  fontSize: 13,
  color: '#a8a8a8',
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

export const COLOR_ACCEPT = '#2ea043'
export const COLOR_DECLINE = '#d13d3d'
export const COLOR_NEUTRAL = '#333'
export const COLOR_NEUTRAL_ACTIVE = '#555'
