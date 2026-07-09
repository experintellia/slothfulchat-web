// Per-instance templating shared by assemble.mjs (bakes config at build time)
// and customize.mjs (re-applies it to a prebuilt release zip, no rebuild).
// Pure functions over strings/bytes — no filesystem access here.
import { createHash } from 'node:crypto'

// Per-instance config from env vars (set in CI, never committed to source):
//   SLOTHFUL_INSTANCE_NAME   human name, e.g. "SlothfulChat"
//   SLOTHFUL_INSTANCE_URL    canonical origin, e.g. "https://web.slothful.chat"
//   SLOTHFUL_DEFAULT_PROXY   wss:// WS-TCP bridge the app uses by default
//   SLOTHFUL_IMPRINT_NAME    responsible person/entity (legal imprint)
//   SLOTHFUL_IMPRINT_ADDRESS postal address (newlines allowed)
//   SLOTHFUL_IMPRINT_EMAIL   contact email
// `build` carries the source commit shown in the About dialog (see
// gitBuildMeta() in assemble.mjs). customize.mjs re-applying config to a
// prebuilt zip has no working tree to read commit info from, so it passes
// through whatever was already baked into that zip's config.js instead.
export function buildConfig(env, build = {}) {
  return {
    instanceName: env.SLOTHFUL_INSTANCE_NAME || '',
    instanceUrl: env.SLOTHFUL_INSTANCE_URL || '',
    defaultProxyUrl: env.SLOTHFUL_DEFAULT_PROXY || '',
    // imprint.html is always emitted (placeholder when unconfigured), so the
    // About link can point at it unconditionally
    imprintUrl: 'imprint.html',
    // release builds (CI sets NODE_ENV=production) hide devmode features:
    // window.exp access, debug log level, dev_ prototype themes
    devmode: env.NODE_ENV !== 'production',
    commitHash: build.commitHash || '',
    commitMessage: build.commitMessage || '',
  }
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
<p>${esc(config.instanceName || 'This app')} runs entirely in your browser. Your accounts,
messages, encryption keys and files are stored only on your device (in your
browser's storage) and are exchanged end-to-end encrypted, directly with the
mail servers, through a relay that only sees encrypted traffic.
${
  config.defaultProxyUrl
    ? `By default this instance uses the relay at <code>${esc(config.defaultProxyUrl)}</code>.`
    : `This instance has no default relay configured — you provide the address of your own relay.`
}
The operator of
this site never receives, stores, sees or processes your messages or account
data, and has no way to know what you do in the app.</p>

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

// --- sw-precache.js (offline app-shell manifest, see sw-manifest.mjs) ---

// the SW machinery itself is never precached: the browser manages blobs-sw.js
// updates, and sw-precache.js describes the cache rather than living in it
export const precacheSkip = f =>
  f.endsWith('.map') ||
  f.startsWith('demo/') ||
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
