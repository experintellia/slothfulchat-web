/**
 * useIsMobileViewport.ts — M5 mobile-viewport layout (docs/calls.md).
 * `CallOverlay`/`IncomingCallRing` are a small floating "card" on desktop, but
 * that wastes most of a phone screen for what is otherwise a full-attention
 * moment (an incoming ring, or an in-call video view) — so below a phone-ish
 * breakpoint they go full-bleed instead (see `styles.ts`'s `*Mobile` tokens).
 *
 * A `matchMedia` hook rather than a one-time `window.innerWidth` check: a PWA
 * on a foldable/rotatable device, or a desktop window resized narrow, should
 * re-layout live, not just on first mount.
 */
import { useSyncExternalStore } from 'react'

/** Phone-ish viewport width. Matches common practice (not `docs/calls.md`-
 * mandated — no host-app design system to align to here, see `styles.ts`'s
 * own doc on why this package rolls its own tokens). */
const MOBILE_BREAKPOINT_QUERY = '(max-width: 640px)'

function getMediaQueryList(): MediaQueryList | null {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return null
  return window.matchMedia(MOBILE_BREAKPOINT_QUERY)
}

function subscribe(onChange: () => void): () => void {
  const mql = getMediaQueryList()
  if (mql == null) return () => {}
  // Safari < 14 only exposes the legacy addListener/removeListener pair.
  if (typeof mql.addEventListener === 'function') {
    mql.addEventListener('change', onChange)
    return () => mql.removeEventListener('change', onChange)
  }
  mql.addListener(onChange)
  return () => mql.removeListener(onChange)
}

function getSnapshot(): boolean {
  return getMediaQueryList()?.matches ?? false
}

/** No DOM at SSR time (this package has none, but `useSyncExternalStore`
 * requires the argument) — desktop layout is the safe default. */
function getServerSnapshot(): boolean {
  return false
}

/** Whether the viewport currently matches the mobile breakpoint. Re-renders
 * the calling component live on resize/rotation/orientation change. */
export function useIsMobileViewport(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)
}
