/**
 * The closed catalogue of analytics events — the single source of truth for
 * what may ever be sent (see analytics.ts for the design constraints). Plain
 * .mjs (not .ts) so instance-config.mjs can render it into the standalone
 * privacy.html at build time with no TypeScript toolchain; the app imports it
 * back via analytics.ts, so the disclosure can never drift from the code.
 *
 * Each entry documents an event we might send and, in plain language, what it
 * means. The `props` list enumerates the *only* property values ever attached —
 * a fixed vocabulary, never user text. Rendered verbatim in the consent UI,
 * the diagnostics panel, and privacy.html.
 *
 * SINGLE SOURCE OF TRUTH: the privacy policy list (privacyHtml in
 * instance-config.mjs) is generated from this catalogue at build time, AND
 * analytics.ts event() enforces it at runtime via isCatalogEvent() below —
 * anything not enumerated here is silently dropped. Editing an event here
 * therefore updates both the disclosure and what can actually be sent.
 *
 * @type {ReadonlyArray<{ name: string, what: string, props?: string }>}
 */
export const EVENTS = [
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
  {
    name: 'chat_export',
    what: 'That a chat was exported, and whether a custom date range was selected.',
    props: 'custom_range = yes · no',
  },
]

/**
 * Parse a `props` spec — 'key = v1 · v2; key2 = …' — into key → allowed
 * values. A trailing parenthetical on a value ('chatmail (default relay)')
 * is a display-only gloss for the policy page and stripped for matching.
 * @param {string} spec
 * @returns {Map<string, Set<string>>}
 */
function parseSpec(spec) {
  const map = new Map()
  for (const part of spec.split(';')) {
    const i = part.indexOf('=')
    if (i < 0) continue
    const values = part
      .slice(i + 1)
      .split('·')
      .map(v => v.trim().replace(/\s*\([^)]*\)$/, ''))
    map.set(part.slice(0, i).trim(), new Set(values))
  }
  return map
}

/**
 * Does (name, props) conform to the catalogue? The name must match an entry,
 * every prop key must appear in that entry's props spec, and every prop value
 * must be one of the listed alternatives (compared as strings). Events with
 * no props spec accept no props. analytics.ts event() drops anything that
 * fails this, so no caller can ever send more than the published policy.
 * @param {string} name
 * @param {Record<string, string | number | boolean>} [props]
 * @returns {boolean}
 */
export function isCatalogEvent(name, props) {
  const entry = EVENTS.find(e => e.name === name)
  if (!entry) return false
  const keys = props ? Object.keys(props) : []
  if (!entry.props) return keys.length === 0
  const allowed = parseSpec(entry.props)
  return keys.every(k => allowed.get(k)?.has(String(props[k])))
}
