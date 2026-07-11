/**
 * Non-identifying, session-scoped context tags shared by profiling and
 * analytics. Nothing here is a user identifier — these are coarse categories
 * ("did this browser already have an account", "is it the installed PWA") used
 * only to segment aggregate stats and startup timings.
 */

// Whether an account already existed when the app started. Set once by
// runtime.ts right after the core answers. null until known.
let hadAccount: boolean | null = null
export function setHadAccount(v: boolean): void {
  hadAccount = v
}

/** 'returning' if an account existed at startup, 'new' if not, 'unknown' before
 * the core has reported. Used as the pageview `mode` prop (a cookieless
 * retention proxy). */
export function visitorMode(): 'new' | 'returning' | 'unknown' {
  return hadAccount == null ? 'unknown' : hadAccount ? 'returning' : 'new'
}

/** 'warm' start (had an account) vs 'cold' (onboarding). Mirrors visitorMode
 * for the startup-timing bucket. */
export function startupMode(): 'cold' | 'warm' | 'unknown' {
  return hadAccount == null ? 'unknown' : hadAccount ? 'warm' : 'cold'
}

/** Is this the installed PWA (standalone display) or a normal browser tab? */
export function displayMode(): 'standalone' | 'browser' {
  try {
    if (window.matchMedia?.('(display-mode: standalone)').matches) return 'standalone'
    // iOS Safari uses navigator.standalone instead of the media query
    if ((navigator as any).standalone) return 'standalone'
  } catch {
    /* ignore */
  }
  return 'browser'
}
