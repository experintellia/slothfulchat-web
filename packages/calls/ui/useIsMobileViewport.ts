/**
 * Mobile-viewport hook driving the `*Mobile` tokens in `styles.ts`.
 * A `matchMedia` hook rather than a one-time `window.innerWidth` check: a
 * rotated/foldable device or a window resized narrow should re-layout live,
 * not just on first mount.
 */
import { useSyncExternalStore } from 'react'

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

/** `useSyncExternalStore` requires this; desktop is the safe default. */
function getServerSnapshot(): boolean {
  return false
}

/** Whether the viewport currently matches the mobile breakpoint. Re-renders
 * the calling component live on resize/rotation/orientation change. */
export function useIsMobileViewport(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)
}
