/**
 * SlothfulChat anonymous usage statistics — opt-out, privacy-preserving.
 *
 * DESIGN CONSTRAINTS (why this file looks the way it does):
 *
 * 1. Off unless the *instance* opts in at build time. Analytics only exists
 *    when SLOTHFUL_PLAUSIBLE_DOMAIN + SLOTHFUL_PLAUSIBLE_API are baked into
 *    config.js by assemble.mjs. Every self-hosted build leaves them empty, so
 *    self-hosters get zero analytics, no banner, and no extra CSP origin — the
 *    imprint's "your data stays on your device" stays literally true for them.
 *    Only the official demo instance sets these in CI.
 *
 * 2. No third-party JavaScript. Instead of loading Plausible's script.js we
 *    POST events ourselves to its documented events API. That keeps script-src
 *    locked to 'self' (important for an end-to-end-encrypted messenger) and
 *    means every line that could send data lives in this reviewable file. Only
 *    connect-src gains the Plausible origin, and only on the demo build.
 *
 * 3. Closed event catalogue (EVENTS below). We only ever send the event names
 *    and property *values* enumerated there — never message content, contact
 *    addresses, account data, or free text. The consent banner and diagnostics
 *    panel render this same catalogue, so "what's collected" can never drift
 *    from what is actually sent.
 *
 * 4. Opt-out, but asked. Analytics is on by default on the demo instance, the
 *    consent banner is shown once, and the user can opt out there or later in
 *    the diagnostics panel. Opting out is remembered in localStorage.
 */

import * as session from './session'

type Config = {
  analytics?: boolean
  plausibleDomain?: string
  plausibleApi?: string
  instanceUrl?: string
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
 * isn't configured, we're not online, or the user explicitly denied. An unset
 * choice counts as enabled (the banner is shown alongside, so it is "asked"). */
export function isEnabled(): boolean {
  return isConfigured() && getConsent() !== 'denied'
}

// --- the closed catalogue of what we may send --------------------------

/** Each entry documents an event we might send and, in plain language, what it
 * means. The `props` list enumerates the *only* property values ever attached —
 * a fixed vocabulary, never user text. Rendered verbatim in the consent UI. */
export const EVENTS: ReadonlyArray<{
  name: string
  what: string
  props?: string
}> = [
  {
    name: 'pageview',
    what: 'That the app was opened.',
    props: 'mode = new · returning · unknown; display = standalone · browser',
  },
  {
    name: 'onboarding',
    what: 'Progress through account setup and which method was chosen.',
    props: 'step = welcome · method · configuring · success · failed; method = chatmail · qr · manual · webimap; reason = network · auth · other',
  },
  {
    name: 'account_created',
    what: 'That an account was set up, and how it was set up.',
    props: 'transport = imap · webimap; method = chatmail (default relay) · manual (email login) · qr · webimap',
  },
  {
    name: 'send',
    what: 'That a message was sent, and of what kind (never its content).',
    props: 'type = text · image · voice · audio · file · sticker · video · other; transport = imap · webimap; chatmail = yes · no',
  },
  {
    name: 'qr_scan',
    what: 'That a QR / invite code was scanned or pasted.',
  },
  {
    name: 'community',
    what: 'That a community channel / public suggestion was used.',
  },
  {
    name: 'link_preview',
    what: 'That a composer link preview was accepted or dismissed.',
    props: 'action = accept · dismiss',
  },
  {
    name: 'bridge',
    what: 'Which kind of WS→TCP bridge the session uses.',
    props: 'kind = local · provided · custom',
  },
  {
    name: 'link',
    what: 'That an info link was opened (which one, not who).',
    props: 'target = imprint · github · changelog · donate',
  },
  {
    name: 'chats',
    what: 'A coarse milestone: having your first chat, or more than ten.',
    props: 'milestone = first · ten',
  },
  {
    name: 'backup',
    what: 'That a backup was exported or imported — never its contents.',
    props: 'action = export · import',
  },
  {
    name: 'keys',
    what: 'That encryption keys were exported or imported — never the keys.',
    props: 'action = export · import',
  },
  {
    name: 'startup',
    what: 'A coarse range for how long the app took to start.',
    props: 'bucket = <0.5s · 0.5-1s · 1-2s · 2-4s · >4s; mode = cold · warm',
  },
  {
    name: 'boot_error',
    what: 'That the app hit a fatal startup error, by category (helps us fix white-screens).',
    props: 'kind = opfs-locked · storage-blocked · init-error',
  },
] as const

// --- sending -----------------------------------------------------------

type Props = Record<string, string | number | boolean>

/** Send one event to Plausible's events API. Best-effort and silent: analytics
 * must never break the app or spam the console, so failures are swallowed. */
export function event(name: string, props?: Props): void {
  if (!isEnabled()) return
  const c = cfg()
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
  const h = String(href).toLowerCase()
  const target = h.includes('imprint.html')
    ? 'imprint'
    : h.includes('/changelog')
      ? 'changelog'
      : h.includes('/donate')
        ? 'donate'
        : // only our own repo, not other github.com links (e.g. the madmail link)
          h.includes('github.com/experintellia/slothfulchat-web')
          ? 'github'
          : ''
  if (target) event('link', { target })
}

/** The single pageview for this visit, tagged with coarse (non-identifying)
 * context: whether an account already existed (retention proxy) and whether
 * this is the installed PWA or a browser tab. */
export function pageview(): void {
  event('pageview', { mode: session.visitorMode(), display: session.displayMode() })
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

// build a stable, param-free url for Plausible; fall back to the real location
function originUrl(c: Config): string {
  try {
    if (c.instanceUrl) return new URL(location.pathname, c.instanceUrl).href
    return location.origin + location.pathname
  } catch {
    return location.href
  }
}
