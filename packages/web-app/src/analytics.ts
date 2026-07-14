/**
 * SlothfulChat anonymous usage statistics — opt-out, privacy-preserving.
 *
 * DESIGN CONSTRAINTS (why this file looks the way it does):
 *
 * 1. Off unless the *instance* opts in at build time. Analytics only exists
 *    when SLOTHFUL_PLAUSIBLE_DOMAIN + SLOTHFUL_PLAUSIBLE_API are baked into
 *    config.js by assemble.mjs. Every self-hosted build leaves them empty, so
 *    self-hosters get zero analytics, no consent UI, and no extra CSP origin — the
 *    imprint's "your data stays on your device" stays literally true for them.
 *    Only the official demo instance sets these in CI.
 *
 * 2. No third-party JavaScript. Instead of loading Plausible's script.js we
 *    POST events ourselves to its documented events API. That keeps script-src
 *    locked to 'self' (important for an end-to-end-encrypted messenger) and
 *    means every line that could send data lives in this reviewable file. Only
 *    connect-src gains the Plausible origin, and only on the demo build.
 *
 * 3. Closed event catalogue (src/events.mjs). We only ever send the event
 *    names and property *values* enumerated there — never message content,
 *    contact addresses, account data, or free text. The generated privacy.html
 *    renders that same catalogue and event() enforces it at runtime, so
 *    "what's collected" can never drift from what is actually sent.
 *
 * 4. Opt-out by design. Analytics is on by default on the demo instance; the
 *    welcome screen shows an opt-out checkbox (which opens the info dialog in
 *    consent.ts), and the same toggle exists in Settings → Advanced and the
 *    diagnostics panel. There is no unprompted banner — a returning visitor
 *    who never touches the controls stays opted in. Opting out is remembered
 *    in localStorage.
 */

import * as session from './session'
import { EVENTS, isCatalogEvent } from './events.mjs'
// Type-only: no runtime dependency on @slothfulchat/calls from this generic
// analytics module — just the single source of truth for the outcome
// vocabulary, so it can't drift from what packages/calls actually classifies.
import type { CallResult } from '@slothfulchat/calls/bridge'

type Config = {
  analytics?: boolean
  plausibleDomain?: string
  plausibleApi?: string
  instanceUrl?: string
  devmode?: boolean
}
const cfg = (): Config => (window as any).__slothfulConfig ?? {}

const CONSENT_KEY = 'slothfulchat.analyticsConsent' // 'granted' | 'denied'
export type Consent = 'granted' | 'denied' | 'unset'

/** True when this build was configured for analytics at all. Everything else
 * short-circuits to a no-op when this is false. */
export function isConfigured(): boolean {
  const c = cfg()
  return Boolean(c.analytics && c.plausibleDomain && c.plausibleApi)
}

// In-memory mirror so an explicit choice always takes effect this session, even
// when localStorage is blocked (private mode / iOS "block all cookies") and the
// write below throws — otherwise clicking "Opt out" would silently do nothing.
let memConsent: Consent = 'unset'

export function getConsent(): Consent {
  if (memConsent !== 'unset') return memConsent
  try {
    const v = localStorage.getItem(CONSENT_KEY)
    return v === 'granted' || v === 'denied' ? v : 'unset'
  } catch {
    return 'unset'
  }
}

/** Persist an explicit choice. 'unset' clears it (used by tests). */
export function setConsent(consent: Consent): void {
  memConsent = consent // always effective this session, storage or not
  try {
    if (consent === 'unset') localStorage.removeItem(CONSENT_KEY)
    else localStorage.setItem(CONSENT_KEY, consent)
  } catch {
    // storage blocked — the in-memory mirror above still enforces the choice
  }
}

/** Whether events may be sent right now. Opt-out: enabled unless the instance
 * isn't configured or the user explicitly denied. An unset choice counts as
 * enabled — deliberate opt-out semantics: the welcome checkbox / Settings /
 * diagnostics toggles are the (always-available, never-forced) ask. */
export function isEnabled(): boolean {
  return isConfigured() && getConsent() !== 'denied'
}

// --- the closed catalogue of what we may send --------------------------

// Lives in events.mjs (plain JS) so instance-config.mjs can render it into
// privacy.html at build time; re-exported here for the in-app consumers.
export { EVENTS }

// --- sending -----------------------------------------------------------

type Props = Record<string, string | number | boolean>

/** Send one event to Plausible's events API. Best-effort and silent: analytics
 * must never break the app or spam the console, so failures are swallowed. */
export function event(name: string, props?: Props): void {
  if (!isEnabled()) return
  const c = cfg()
  // Runtime enforcement of the closed catalogue: anything outside events.mjs
  // (unknown event, unknown prop key, value outside the fixed vocabulary) is
  // dropped, so no caller — including window.__slothfulTrack — can ever send
  // more than the published policy. Never throw (analytics must never break
  // the app); warn only in devmode so drift is visible in dev, silent in prod.
  if (!isCatalogEvent(name, props)) {
    if (c.devmode) console.warn('[analytics] dropped non-catalogue event:', name, props)
    return
  }
  const body = {
    name,
    // Plausible needs a domain (its "site" id) and a url. We deliberately send
    // only the origin + path (its own default strips the query string anyway),
    // so no ?proxy=/invite-code params leak into analytics.
    domain: c.plausibleDomain,
    url: originUrl(c),
    ...(props ? { props } : {}),
  }
  try {
    void fetch(c.plausibleApi!, {
      method: 'POST',
      // text/plain (like Plausible's own script) keeps this a CORS "simple
      // request" — no preflight, which the events endpoint may not answer
      headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify(body),
      // no cookies/credentials — Plausible is cookieless by design
      credentials: 'omit',
      keepalive: true, // let the request outlive a page navigation
    }).catch(() => {})
  } catch {
    // fetch can throw synchronously if the URL is malformed; ignore
  }
}

/** Count a click on one of the tracked info links (imprint / github /
 * changelog). Other links are ignored. Called from runtime.openLink (all app
 * links funnel through it) and from our own overlay anchors (ui-shared). */
export function trackLink(href: string): void {
  // openLink() funnels EVERY external link through here — including links
  // clicked inside private messages. Match our exact info links only (exact
  // origin/path, not substrings), so an arbitrary message link (e.g. some
  // site's /donate page) can never fire an event. Anything unmatched sends
  // nothing, and the href itself is never transmitted either way.
  let target = ''
  try {
    const u = new URL(String(href), location.href)
    const ours = u.origin === location.origin
    if (ours && u.pathname.endsWith('/imprint.html')) target = 'imprint'
    else if (ours && /\/changelog\/?$/.test(u.pathname)) target = 'changelog'
    else if (u.origin === 'https://delta.chat' && u.pathname.replace(/\/$/, '') === '/donate')
      // the app's own donation device-message link
      target = 'donate'
    else if (
      u.origin === 'https://github.com' &&
      /^\/experintellia\/slothfulchat-web(\/|$)/.test(u.pathname)
    )
      target = 'github'
  } catch {
    return // unparseable href — never track
  }
  if (target) event('link', { target })
}

/** The single pageview for this visit, tagged with coarse (non-identifying)
 * context: whether an account already existed (retention proxy) and whether
 * this is the installed PWA or a browser tab. */
export function pageview(): void {
  event('pageview', { mode: session.visitorMode(), display: session.displayMode() })
}

/**
 * How a call ended (docs/calls.md M5: "content-free call analytics … missed/
 * busy/timeout via call_info"). Never anything about *who* was on the call or
 * how long it ran. See `packages/calls/bridge/call-outcome.ts` (the single
 * source of truth for this vocabulary, re-exported as the `CallResult` type
 * imported above) for the full per-value breakdown and the core `call_info`
 * mapping table:
 *
 *   connected — the peer connection reached `connected` at least once.
 *   missed    — an incoming call that rang out unanswered, or the caller hung
 *               up before we accepted.
 *   busy      — a second incoming call arrived while this device was already
 *               in one and was auto-declined (purely local — no core state).
 *   declined  — explicitly rejected before connecting (either side).
 *   timeout   — an outgoing call that rang out with no answer.
 *   cancelled — we hung up an outgoing call ourselves before it connected.
 *   error     — the call tore down from a local failure, never connecting.
 */
export type { CallResult }

/** Record a call outcome. Content-free: direction, whether it carried video,
 * and the fixed `CallResult` bucket above — never the chat/contact, never a
 * duration, never any signaling/media payload. Called by the runtime's call
 * manager (`packages/web-app/src/runtime.ts`) at the one point a call's
 * lifecycle is finished (see `reportCallOutcome`), so this fires at most once
 * per call regardless of how many ways a call can end. */
export function trackCall(params: {
  direction: 'outgoing' | 'incoming'
  hasVideo: boolean
  result: CallResult
}): void {
  event('call', {
    direction: params.direction,
    has_video: params.hasVideo ? 'yes' : 'no',
    result: params.result,
  })
}

let startupSent = false
/** Turn a startup duration (ms) into one of the fixed buckets and send it,
 * tagged cold (onboarding) vs warm (had an account). Fires at most once, and
 * waits until the cold/warm mode is known (callers invoke it both when the UI
 * becomes ready and when account state resolves — whichever satisfies both
 * conditions sends it). Bucketing keeps it non-identifying. */
export function trackStartup(ms: number | null): void {
  if (startupSent || ms == null) return
  const mode = session.startupMode()
  if (mode === 'unknown') return // account state not known yet — try again later
  startupSent = true
  const bucket =
    ms < 500 ? '<0.5s' : ms < 1000 ? '0.5-1s' : ms < 2000 ? '1-2s' : ms < 4000 ? '2-4s' : '>4s'
  event('startup', { bucket, mode })
}

// build a stable, param-free url for Plausible: origin + path only — never
// the query string or fragment, on any path (?proxy=/invite params must not
// leak into analytics). Falls back to the real location's origin + path.
function originUrl(c: Config): string {
  try {
    if (c.instanceUrl) {
      const u = new URL(location.pathname, c.instanceUrl)
      return u.origin + u.pathname
    }
  } catch {
    // malformed instanceUrl — fall through to the real location
  }
  return location.origin + location.pathname
}
