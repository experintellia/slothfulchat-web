// Per-instance templating shared by assemble.mjs (bakes config at build time)
// and customize.mjs (re-applies it to a prebuilt release zip, no rebuild).
// Pure functions over strings/bytes — no filesystem access here.
import { createHash } from 'node:crypto'
import { EVENTS } from './src/events.mjs'

// Per-instance config from env vars (set in CI, never committed to source):
//   SLOTHFUL_INSTANCE_NAME   human name, e.g. "SlothfulChat"
//   SLOTHFUL_INSTANCE_URL    canonical origin, e.g. "https://web.slothful.chat"
//   SLOTHFUL_DEFAULT_PROXY   wss:// WS-TCP bridge the app uses by default
//   SLOTHFUL_PUBLIC_BRIDGES  public bridges offered in the bridge picker
//                            dialog, ";"-separated "URL description" entries
//                            (URL up to the first space, rest is a short
//                            description), e.g.
//                            "wss://a.example/bridge Community bridge, for
//                            testing; wss://b.example/bridge Backup bridge".
//                            Descriptions can't contain ";". Entries without
//                            a ws:// or wss:// URL are dropped.
//   SLOTHFUL_DEFAULT_CHATMAIL
//                            chatmail relay the "create new account" instant
//                            onboarding flow signs up on (host, URL or a
//                            dcaccount: QR); unset = upstream's default relay
//   SLOTHFUL_IMPRINT_NAME    responsible person/entity (legal imprint)
//   SLOTHFUL_IMPRINT_ADDRESS postal address (newlines allowed)
//   SLOTHFUL_IMPRINT_EMAIL   contact email
//   SLOTHFUL_PLAUSIBLE_DOMAIN  Plausible "site" id enabling anonymous usage
//                            stats. UNSET (self-host default) = no analytics at
//                            all (no events, no banner, no extra CSP origin), so
//                            the imprint privacy promise stays literally true.
//   SLOTHFUL_PLAUSIBLE_API   Plausible events endpoint. Defaults to the cloud
//                            (https://plausible.io/api/event) when a domain is
//                            set; point it at your own instance to self-host.
//   SLOTHFUL_HIDE_PUBLIC_SUGGESTIONS
//                            "1"/"true": hide the community suggestions
//                            ("Public Bots", "Public Channels") in the New
//                            Chat dialog for the whole instance, including
//                            the per-user settings toggle
// `build` carries the slothfulchat-web version + source commit shown in the
// About dialog/log (see gitBuildMeta() in assemble.mjs). customize.mjs
// re-applying config to a prebuilt zip has no working tree to read this from,
// so it passes through whatever was already baked into that zip's config.js
// instead.
// SLOTHFUL_PUBLIC_BRIDGES: ";"-separated "URL description" entries — URL runs
// to the first whitespace, the rest is the description (may be empty).
// Malformed entries (no ws:// / wss:// URL) are dropped rather than failing
// the build.
export function parsePublicBridges(raw) {
  return (raw || '')
    .trim()
    // Tolerate the whole value wrapped in shell-style quotes. A GitHub Actions
    // Variable (or a .env) takes the raw value with no quoting, but the
    // SELFHOSTING examples show quoted shell assignments (SLOTHFUL_..="..."),
    // so it's an easy slip to paste the quotes into the Variable field — which
    // would otherwise make the first URL start with a `"` and drop every entry.
    .replace(/^(['"])([\s\S]*)\1$/, '$2')
    .split(';')
    .map(e => e.trim())
    .filter(Boolean)
    .map(e => {
      const m = /^(\S+)(?:\s+([^]*))?$/.exec(e)
      // also strip stray quotes hugging an individual URL token
      return { url: m[1].replace(/^['"]+|['"]+$/g, ''), description: (m[2] || '').trim() }
    })
    .filter(({ url }) => /^wss?:\/\/.+/i.test(url))
}

export function buildConfig(env, build = {}) {
  const plausibleDomain = env.SLOTHFUL_PLAUSIBLE_DOMAIN || ''
  // default the endpoint to Plausible cloud once a domain is configured; empty
  // (self-host default) keeps analytics fully off
  const plausibleApi =
    env.SLOTHFUL_PLAUSIBLE_API || (plausibleDomain ? 'https://plausible.io/api/event' : '')
  return {
    instanceName: env.SLOTHFUL_INSTANCE_NAME || '',
    instanceUrl: env.SLOTHFUL_INSTANCE_URL || '',
    defaultProxyUrl: env.SLOTHFUL_DEFAULT_PROXY || '',
    // public bridges offered as options in the runtime's bridge picker dialog
    // (showBridgeDialog in src/runtime.ts); [] = only localhost + custom
    publicBridges: parsePublicBridges(env.SLOTHFUL_PUBLIC_BRIDGES),
    // chatmail relay the instant-onboarding "create new account" flow signs up
    // on when the user taps the button (no scanned QR). Empty = the frontend
    // keeps upstream's default instance. Read by the patched useInstantOnboarding
    // (see patches/desktop, slothfulInstanceConfig.instanceDefaultChatmailQr).
    defaultChatmailInstance: env.SLOTHFUL_DEFAULT_CHATMAIL || '',
    // relay-directory source for the onboarding relay picker (patches/desktop
    // relayDirectory.ts): '' = the frontend's built-in default mirror, an
    // http(s) URL = fetch there, 'off' = picker disabled. Garbage is treated
    // as unset. patchCsp pins main.html's connect-src to the same value.
    relayDirectoryUrl: normalizeRelayDirectory(env.SLOTHFUL_RELAY_DIRECTORY),
    // imprint.html is always emitted (placeholder when unconfigured), so the
    // About link can point at it unconditionally
    imprintUrl: 'imprint.html',
    // instance-wide opt-out of the New Chat community suggestions
    // (Public Bots / Public Channels); also hides the per-user toggle
    hidePublicSuggestions: ['1', 'true', 'yes'].includes(
      (env.SLOTHFUL_HIDE_PUBLIC_SUGGESTIONS || '').toLowerCase()
    ),
    // release builds (CI sets NODE_ENV=production) hide devmode features:
    // window.exp access, debug log level, dev_ prototype themes
    devmode: env.NODE_ENV !== 'production',
    // anonymous usage stats: only present when this instance opted in at build
    // time. runtime.ts treats analytics===false as "no analytics" everywhere.
    analytics: Boolean(plausibleDomain && plausibleApi),
    plausibleDomain,
    plausibleApi,
    version: build.version || '',
    commitHash: build.commitHash || '',
    commitMessage: build.commitMessage || '',
  }
}

/** The origin the analytics code POSTs to, or '' when analytics is off. Used to
 * open exactly one extra CSP connect-src on instances that enable stats. */
export function analyticsOrigin(config) {
  if (!config.analytics || !config.plausibleApi) return ''
  try {
    return new URL(config.plausibleApi).origin
  } catch {
    return ''
  }
}

// Default relay-directory source: a dumb automated daily mirror of
// https://chatmail.at/relays (single-snapshot `data` branch, CORS via GitHub
// raw). It's the project's OWN repo (same `experintellia` org as this app),
// not an arbitrary third party — whoever controls it controls the relay list
// the picker offers, so a first-party source is the point. Must match
// RELAY_DIRECTORY_URL in the patched frontend (relayDirectory.ts) — the
// frontend falls back to it when the config value is empty, and patchCsp pins
// the CSP to it by default. (A lint-job test guards the two against drift.)
export const DEFAULT_RELAY_DIRECTORY_URL =
  'https://raw.githubusercontent.com/experintellia/chatmail-relays-mirror/refs/heads/data/relays.json'

// SLOTHFUL_RELAY_DIRECTORY: '' (use default mirror) | 'off' | http(s) URL.
// Garbage (not a URL, not "off") counts as unset — a broken value must not
// end up as a CSP source or a fetch target. The URL must be a SINGLE clean
// token: it is appended verbatim into main.html's connect-src, so a value
// with a space would inject an extra CSP source and a ';' would truncate the
// directive (and break patchCsp idempotency). Reject anything with
// whitespace/quotes/';' and require URL() to accept it.
export function normalizeRelayDirectory(raw) {
  // trim, strip wrapping shell quotes, trim again (padding may sit inside the
  // quotes, e.g. `" off "`)
  const value = (raw || '')
    .trim()
    .replace(/^(['"])([\s\S]*)\1$/, '$2')
    .trim()
  if (/^off$/i.test(value)) return 'off'
  if (/^https?:\/\/\S+$/i.test(value) && !/["';]/.test(value)) {
    try {
      // eslint-disable-next-line no-new
      new URL(value)
      return value
    } catch {
      /* not a parseable URL — fall through to unset */
    }
  }
  return ''
}

/** The relay-directory URL to pin in the CSP connect-src (and the frontend
 * fetches): '' → the default mirror, an https URL → that, 'off' → no pin.
 * Takes an already-normalized value (buildConfig stores one). */
export function relayDirectoryPin(relayDirectory) {
  const normalized = normalizeRelayDirectory(relayDirectory)
  return normalized === 'off' ? '' : normalized || DEFAULT_RELAY_DIRECTORY_URL
}

/** Canonicalise the CSP connect-src in main.html/index.html: drop the two
 * build-managed sources — the analytics Plausible origin and the
 * relay-directory URL — then re-add each per config. Idempotent, so
 * assemble.mjs (from the pristine template) and customize.mjs (from a prebuilt
 * zip that may carry stale values) both converge. Non-managed tokens (ws:,
 * wss:, data:, the link-preview unfurl wildcard, …) are preserved. Anchored on
 * the `'self'` that always follows `connect-src` in the real directive, so it
 * never matches the word "connect-src" in the explanatory HTML comment above
 * the meta tag.
 *
 * `origin` is the analytics origin (analyticsOrigin(config), '' when off);
 * `relayDirectory` is the normalized config.relayDirectoryUrl ('' | 'off' |
 * url). */
export function patchCsp(html, origin, relayDirectory = '') {
  // strip a previously-injected *bare* origin (scheme://host[:port], no path)
  // — that's what analyticsOrigin() produces
  const isBareOrigin = t => /^https?:\/\/[^/]+\/?$/.test(t)
  // strip a previously-injected relay-directory URL: a path-scoped http(s) URL
  // that is NOT the link-preview unfurl wildcard. The default mirror, a custom
  // directory, and the historical markdown pin all match this — so a stale one
  // (markdown, or another instance's) is replaced rather than accumulated.
  const isManagedRelay = t =>
    /^https?:\/\/[^/]+\/.+/.test(t) && !t.includes('*:*/unfurl')
  const relayPin = relayDirectoryPin(relayDirectory)
  return html.replace(/connect-src 'self'([^;"]*)/, (_m, body) => {
    const kept = body
      .split(/\s+/)
      .filter(t => t && !isBareOrigin(t) && !isManagedRelay(t))
    if (relayPin) kept.push(relayPin)
    if (origin) kept.push(origin)
    return "connect-src 'self'" + (kept.length ? ' ' + kept.join(' ') : '')
  })
}

export const configJs = config =>
  `window.__slothfulConfig=${JSON.stringify(config)}\n`

export const DEFAULT_NAME = 'SlothfulChat'

// quotes included: esc output also lands inside double-quoted href attributes
const esc = s =>
  String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
const nl2br = s => esc(s).replace(/\r?\n/g, '<br />')

// always write name-or-default (not a no-op when unset): customize.mjs may
// get a zip that already carries another instance's name and must reset it.
// replacer functions throughout: a plain replacement string would expand
// $-sequences ($&, $`, …) from the name
/** Swaps the instance name into <title> (main.html/index.html). */
export const patchTitle = (html, name) =>
  html.replace(/<title>[^<]*<\/title>/, () => `<title>${esc(name || DEFAULT_NAME)}</title>`)

/** Sets the PWA name/short_name in manifest.webmanifest. */
export function patchManifest(json, name) {
  const manifest = JSON.parse(json)
  manifest.name = name || DEFAULT_NAME
  // launcher labels: the manifest spec recommends <= ~12 chars for short_name
  manifest.short_name = manifest.name.length > 12 ? manifest.name.slice(0, 12).trimEnd() : manifest.name
  return JSON.stringify(manifest, null, 2) + '\n'
}

/** Sets the display name in boot-error.js — its fatal screens run before
 * config.js is guaranteed loaded, so the name is baked into the file
 * (exact-match on the APP_NAME declaration; no-op if the file changes). */
export const patchBootError = (js, name) =>
  js.replace(/var APP_NAME = [^\n]*/, () => `var APP_NAME = ${JSON.stringify(name || DEFAULT_NAME)}`)

// imprint.html — standalone legal notice. The operator's name/address/email
// come from env (so they live in CI config, not the source tree); the scope +
// privacy + reporting text is the same for every instance and is baked into
// the template below.
export function imprintHtml(config, env) {
  const name = env.SLOTHFUL_IMPRINT_NAME || ''
  const address = env.SLOTHFUL_IMPRINT_ADDRESS || ''
  const email = env.SLOTHFUL_IMPRINT_EMAIL || ''
  const instanceLabel = config.instanceName || config.instanceUrl || 'this site'

  const operatorBlock =
    name || address || email
      ? `<h2>Operator of this site</h2>
<p>
${name ? `${nl2br(name)}<br />` : ''}${address ? `${nl2br(address)}<br />` : ''}${
          email ? `<a href="mailto:${esc(email)}">${esc(email)}</a>` : ''
        }
</p>`
      : `<p><em>No operator details have been configured for ${esc(instanceLabel)}.</em>
Operators: set <code>SLOTHFUL_IMPRINT_NAME</code>, <code>SLOTHFUL_IMPRINT_ADDRESS</code>
and <code>SLOTHFUL_IMPRINT_EMAIL</code> at build time.</p>`

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<link rel="icon" type="image/png" href="./images/icon-256.png" />
<title>Imprint — ${esc(config.instanceName || DEFAULT_NAME)}</title>
<style>
  body { font: 16px/1.6 system-ui, sans-serif; max-width: 42rem; margin: 3rem auto; padding: 0 1.25rem; color: #222; }
  a { color: #2c8a68; }
  h2 { font-size: 1.15rem; margin-top: 2rem; }
  .meta { color: #666; font-size: 0.9rem; margin-top: 2.5rem; }
</style>
</head>
<body>
<h1>Imprint</h1>
${operatorBlock}

<h2>What this imprint covers</h2>
<p>This imprint concerns ${esc(instanceLabel)} — the website and web app — only.
It does not concern the content of any messages or accounts.</p>

<h2>Your data stays on your device</h2>
<p>${esc(config.instanceName || 'This app')} runs entirely in your browser: your accounts,
messages and keys are stored on your device. Messages are end-to-end
encrypted between Delta Chat / chatmail-capable contacts; messages to
ordinary email addresses are sent as regular email — encrypted in transit,
but not end-to-end. The operator never receives, stores, sees or processes your messages
or account data. See the <a href="./privacy.html">full privacy policy</a> for
details${
    config.analytics
      ? ', including exactly what the optional anonymous statistics collect'
      : ''
  }.</p>

<h2>Problems with other users</h2>
<p>Because the operator has no access to your conversations, they cannot moderate
them and cannot act on reports about other users. If someone harasses you or
breaks the law: block them in the app, and report them directly to the relevant
authorities if a law was broken. You can also report them to their email /
chatmail provider — the operator of the relay behind their address. You can see
which relays a contact uses by opening the contact, then the three-dot menu,
then &ldquo;Encryption Info&rdquo;.</p>

<h2>Links</h2>
<p>This site and app contain links to external websites. The operator has no
influence over their content and accepts no responsibility for it; at the time
of linking, no malicious or illegal content was apparent. If a linked site no
longer complies, please report it to the email address above.</p>

<p class="meta">${esc(instanceLabel)}${
    config.instanceUrl
      ? ` — <a href="${esc(config.instanceUrl)}">${esc(config.instanceUrl)}</a>`
      : ''
  }<br />An unofficial experiment running Delta Chat's chatmail core in the browser. Not affiliated with Delta Chat.</p>
<p><a href="./">← Back to the app</a></p>
</body>
</html>
`
}

// privacy.html — standalone privacy policy. The "what is collected" list is
// rendered from src/events.mjs — the same closed catalogue the app actually
// sends from — so the published policy can never drift from the code.
export function privacyHtml(config, env) {
  const instanceLabel = config.instanceName || config.instanceUrl || 'this site'
  const appName = config.instanceName || 'This app'
  const selfhosting = 'https://github.com/experintellia/slothfulchat-web/blob/main/SELFHOSTING.md'

  const eventRows = EVENTS.map(
    e => `<li><code>${esc(e.name)}</code> — ${esc(e.what)}${
      e.props ? `<br /><span class="props">${esc(e.props)}</span>` : ''
    }</li>`
  ).join('\n')

  const analyticsSection = config.analytics
    ? `<h2>Anonymous usage statistics</h2>
<p>This is a public demo instance. To understand which features are used and
where the app is slow, it collects <strong>anonymized, aggregated usage
statistics</strong> — using
<a href="https://plausible.io/data-policy" target="_blank" rel="noopener">Plausible</a>,
a privacy-focused analytics tool: no cookies, no persistent identifiers, and
visitor hashes that are unlinkable after 24 hours. Like any web request, each
event Plausible's API receives carries your IP address and browser
user-agent; Plausible uses them only to derive daily visitor aggregates and
never stores them (see their data policy, linked above).
Statistics are on by default on this instance; you can turn them off
at any time with the &ldquo;Share anonymous usage statistics&rdquo; checkbox on
the welcome screen or in the app's settings (Settings → Advanced, and
Settings → open the log → Diagnostics).</p>
<p><strong>Exactly these events and nothing else</strong> may be sent. Each
event carries at most the fixed property vocabulary shown with it — never
message content, contact or email addresses, account data, or free text:</p>
<ul class="events">
${eventRows}
</ul>
<p>Want zero analytics? Just opt out — nothing will be sent. Prefer it never
even being asked? <a href="${selfhosting}" target="_blank" rel="noopener">Run
your own instance</a> — self-hosted builds ship without analytics entirely.</p>`
    : `<h2>No analytics</h2>
<p>This instance collects <strong>no usage data at all</strong>: no analytics,
no cookies, no tracking of any kind.</p>`

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<link rel="icon" type="image/png" href="./images/icon-256.png" />
<title>Privacy Policy — ${esc(config.instanceName || DEFAULT_NAME)}</title>
<style>
  body { font: 16px/1.6 system-ui, sans-serif; max-width: 42rem; margin: 3rem auto; padding: 0 1.25rem; color: #222; }
  a { color: #2c8a68; }
  h2 { font-size: 1.15rem; margin-top: 2rem; }
  .events li { margin: 6px 0; }
  .events .props { color: #666; font-size: 0.85rem; }
  .meta { color: #666; font-size: 0.9rem; margin-top: 2.5rem; }
</style>
</head>
<body>
<h1>Privacy Policy</h1>

<h2>Your data stays on your device</h2>
<p>${esc(appName)} runs entirely in your browser. Your accounts,
messages, encryption keys and files are stored on your device (in your
browser's storage). Messages are end-to-end encrypted between Delta Chat /
chatmail-capable contacts; messages to ordinary email addresses are sent as
regular email — encrypted in transit to the mail server, but not end-to-end.
And as with any mail client, your email / chatmail provider also holds your
messages: chatmail relays delete them after delivery, while a classic email
account keeps them on the mail server.</p>

<h2>The relay (bridge)</h2>
<p>Browsers cannot open direct mail-server connections, so the app connects
through a WebSocket relay (bridge). The relay cannot read your messages —
the encrypted connections to the mail servers pass through it — but it
necessarily learns your IP address, which mail servers you connect to, and
when, and it may log those connections. The bridge at any given URL is run
by its operator and may not be the reference implementation: treat it as
that operator's service and choose a relay you trust, or run your own.
The same applies to composer link previews, which are fetched through the
bridge (see below). webimap / madmail accounts connect directly over HTTPS
and do not use the relay.
${
  config.defaultProxyUrl
    ? `By default this instance uses the relay at <code>${esc(config.defaultProxyUrl)}</code>.`
    : `This instance has no default relay configured — you provide the address of your own relay.`
}</p>
<p>The operator of this site never receives, stores, sees or processes your
messages or account data.${
    config.defaultProxyUrl
      ? ' If you use the relay this instance provides by default, its operator can see the connection metadata described above — never message content.'
      : ''
  }${
    config.analytics
      ? ' Beyond the anonymous usage statistics described below, the operator has no way to know what you do in the app.'
      : ' The operator has no way to know what you do in the app.'
  }</p>
<p>Your messages do travel through the relays and email / chatmail providers
of your account and of your contacts' accounts. Those are separate services
run by their own operators, with their own privacy policies — the operator of
this site is not them. Check the policies of the providers you use.</p>

<h2>Calls (audio/video)</h2>
<p>A call connects <strong>directly, peer-to-peer</strong> between you and the
other participant whenever your networks allow it (standard WebRTC ICE,
direct-preferred). When a direct path isn't possible — NAT or firewalls on
either side — the call <strong>automatically falls back to a STUN/TURN relay
server</strong>, whose address is returned by your chatmail relay
(<code>ice_servers()</code>) — the same relay your messages already use, not
a separate third party. There is <strong>no setting to force relay-only
routing</strong>: direct is always attempted first, and forcing relay when a
direct path would work would only burn that relay's bandwidth for no privacy
benefit against Delta Chat's usual threat model (calling people you already
know, not strangers). Whichever path is used, call audio/video is end-to-end
DTLS-SRTP encrypted the same way any WebRTC call is, so a relay
<strong>never sees or can decrypt call content</strong> — only that a call
took place and the participants' IP addresses, i.e. the same kind of
connection metadata the relay already sees for messaging (see above). The
in-call screen shows a small, non-blocking "direct"/"relayed" indicator for
troubleshooting; it has no effect on the call itself. Who is allowed to call
you at all is controlled by the ordinary Delta Chat privacy setting (Settings
→ Notifications → "Calls").</p>

<h2>Links you open and link previews</h2>
<p>When you open a link from a message, your browser contacts that site
directly — like clicking any link on the web. Link previews in the composer
are an optional, experimental feature that requires a user action per link:
they exist only for links you type yourself, and the preview is fetched only
when you accept the ghost preview offered under the composer. That fetch goes
through the bridge you use, so the bridge operator learns that URL — use a
local bridge for maximum privacy. Nothing about your contacts or conversations
is sent along.</p>

${analyticsSection}

<p class="meta">${esc(instanceLabel)}${
    config.instanceUrl
      ? ` — <a href="${esc(config.instanceUrl)}">${esc(config.instanceUrl)}</a>`
      : ''
  }<br />An unofficial experiment running Delta Chat's chatmail core in the browser. Not affiliated with Delta Chat.<br />
Operator and legal notice: see the <a href="./imprint.html">imprint</a>.</p>
<p><a href="./">← Back to the app</a></p>
</body>
</html>
`
}

// --- sw-precache.js (offline app-shell manifest, see sw-manifest.mjs) ---

// the SW machinery itself is never precached: the browser manages blobs-sw.js
// updates, and sw-precache.js describes the cache rather than living in it
export const precacheSkip = f =>
  f.endsWith('.map') ||
  f.startsWith('demo/') ||
  f.startsWith('changelog/') ||
  ['.nojekyll', 'sw-precache.js', 'blobs-sw.js'].includes(f)

/** Content-hashes [path, bytes] entries into the sw-precache.js source.
 * Applies precacheSkip itself (callers may still pre-filter to skip I/O). */
export function buildPrecache(entries) {
  const manifest = {}
  const included = [...entries].filter(([file]) => !precacheSkip(file))
  for (const [file, bytes] of included.sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    manifest[file] = createHash('sha1').update(bytes).digest('hex').slice(0, 16)
  }
  const version = createHash('sha1').update(JSON.stringify(manifest)).digest('hex').slice(0, 12)
  const js = `self.__PRECACHE_VERSION=${JSON.stringify(version)}\nself.__PRECACHE=${JSON.stringify(manifest)}\n`
  return { js, version, count: Object.keys(manifest).length }
}
