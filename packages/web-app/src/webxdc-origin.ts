/**
 * The pure half of webxdc (WEBXDC.md), shared by both sides of the origin
 * wall: the app (webxdc.ts) and the files served ON a webxdc origin
 * (webxdc-host.ts, webxdc-sw.ts). No DOM, no core — unit-tested in
 * webxdc-origin.test.ts.
 */

/** The three static files a webxdc origin serves from the network. Everything
 * else there comes out of its service worker's cache. Mirrored by
 * caddy/routes.caddy, Caddyfile.dev and serve.mjs. */
export const HOST_FILES = ['/webxdc-host.html', '/webxdc-host.js', '/webxdc-sw.js']

/** Cache API bucket on a webxdc origin holding the unzipped app. */
export const XDC_CACHE = 'webxdc-app'

/**
 * Policy on every app response — Electron's webxdc CSP (target-electron
 * webxdc.ts) plus form-action. 'self' is this one app's own origin, which only
 * its service worker answers, so no request can leave the browser through
 * Fetch. NOT covered (no CSP knob reaches them): WebRTC, until browsers ship
 * `webrtc 'block'` (sent anyway — Chromium only warns), and DNS prefetch hints,
 * hence the X-DNS-Prefetch-Control header next to it.
 */
export const APP_CSP = [
  "default-src 'self'",
  "style-src 'self' 'unsafe-inline' blob:",
  "font-src 'self' data: blob:",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval' blob:",
  "connect-src 'self' data: blob:",
  "img-src 'self' data: blob:",
  "media-src 'self' data: blob:",
  "form-action 'none'",
  "webrtc 'block'",
].join('; ')

/** `<slug>.webxdc.<app-host>`: one origin per app instance (WEBXDC.md, "The
 * naming rule"). Slugs are [a-z0-9] and fit one DNS label. */
export function xdcOrigin(app: { protocol: string; host: string }, slug: string): string {
  if (!/^[a-z0-9]{1,63}$/.test(slug)) throw new Error(`bad webxdc slug: ${slug}`)
  return `${app.protocol}//${slug}.webxdc.${app.host}`
}

/** Inverse of xdcOrigin: the app origin allowed to drive this webxdc origin,
 * or null when `loc` is not a webxdc origin at all. */
export function appOriginOf(loc: { protocol: string; host: string }): string | null {
  const m = /^[a-z0-9]{1,63}\.webxdc\.(.+)$/.exec(loc.host)
  return m ? `${loc.protocol}//${m[1]}` : null
}

/** Slug for one app instance. `salt` is random per account (kept in that
 * account's config), so ids that restart — a fresh account reusing id 1 after
 * the old profile was wiped, a throwaway session — never land on an origin
 * holding some other app's storage. */
export const xdcSlug = (salt: string, msgId: number) => `${salt}m${msgId}`

/**
 * Normalise a path into the one form both sides agree on, or null if it can
 * never name a file. Zip entry names (`img/a b.png`) and request pathnames
 * (`/img/a%20b.png`) both come out as `img/a b.png`; a directory request
 * (`/`, `/sub/`) means its index.html.
 */
export function xdcPath(path: string, encoded: boolean): string | null {
  let p = path
  if (encoded) {
    try {
      p = decodeURIComponent(p)
    } catch {
      return null
    }
  }
  p = p.replace(/^(\.?\/)+/, '')
  if (p === '' || p.endsWith('/')) p += 'index.html'
  return p
}

/** Cache key for a normalised path. One opaque path segment, so `#`, `?` and
 * every other character in a zip name survive the trip through a URL. */
export const cacheKey = (origin: string, path: string) =>
  `${origin}/__xdc/${encodeURIComponent(path)}`

/** Where to navigate an app: href comes from the SENDER (WebxdcInfoMessage),
 * so only its path, query and fragment are kept — never another origin. */
export function appEntry(href: string | null | undefined): string {
  if (!href) return '/index.html'
  let u: URL
  try {
    u = new URL(href, 'http://x')
  } catch {
    return '/index.html' // `//[` and friends: no place to show, show the app
  }
  // a non-special scheme (javascript:, data:) has a pathname with no leading /
  return (u.pathname.startsWith('/') ? '' : '/') + u.pathname + u.search + u.hash
}

const MIME: Record<string, string> = {
  html: 'text/html',
  htm: 'text/html',
  js: 'text/javascript',
  mjs: 'text/javascript',
  css: 'text/css',
  json: 'application/json',
  map: 'application/json',
  wasm: 'application/wasm',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  ico: 'image/x-icon',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  otf: 'font/otf',
  mp3: 'audio/mpeg',
  ogg: 'audio/ogg',
  wav: 'audio/wav',
  mp4: 'video/mp4',
  webm: 'video/webm',
  txt: 'text/plain',
  xml: 'application/xml',
  toml: 'text/plain',
}
/** Served with nosniff, so an unknown type must stay inert bytes. */
export const mimeOf = (path: string) =>
  MIME[path.split('.').pop()?.toLowerCase() ?? ''] ?? 'application/octet-stream'
