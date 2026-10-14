/**
 * Service worker of a webxdc origin (WEBXDC.md). Serves the app the host page
 * (webxdc-host.ts) unpacked into the Cache API — and nothing else: a webxdc
 * origin has no server-side content besides its three bootstrap files.
 *
 * Every response is built HERE, with the CSP set at serve time. Never pass a
 * cached Response through: the app shares this origin, so it can write its own
 * entries into the cache, and a header-less one framed by the app would be a
 * document with no CSP at all (the Electron audit's XDC-01-002, same class).
 */
import { APP_CSP, HOST_FILES, XDC_CACHE, cacheKey, mimeOf, xdcPath } from './webxdc-origin.ts'
import { guardSource } from './webxdc-guard.ts'

// inline: an external script would leave the page without it for a fetch's
// length, and a frame's parent can poll a fresh window in that gap
const GUARD_TAG = new TextEncoder().encode(`<script>${guardSource()}</script>`)

/** The guard as the first thing a page runs: right after its doctype (a tag
 * before it would put the page in quirks mode) and any byte order mark. */
function withGuard(b: Uint8Array): Uint8Array<ArrayBuffer> {
  let at = b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf ? 3 : 0
  const m = /^\s*<!doctype[^>]*>/i.exec(String.fromCharCode(...b.subarray(at, at + 1024)))
  if (m) at += m[0].length
  const out = new Uint8Array(b.length + GUARD_TAG.length)
  out.set(b.subarray(0, at))
  out.set(GUARD_TAG, at)
  out.set(b.subarray(at), at + GUARD_TAG.length)
  return out
}

const sw = self as any

// a redeploy takes over at once; the next open re-registers, which re-checks
sw.addEventListener('install', () => sw.skipWaiting())

const respond = (body: BodyInit | null, status: number, type = 'text/plain', extra = {}) =>
  new Response(body, {
    status,
    headers: {
      ...extra,
      'content-type': type,
      'content-security-policy': APP_CSP,
      'x-content-type-options': 'nosniff',
      'x-dns-prefetch-control': 'off',
      'referrer-policy': 'no-referrer',
      'cache-control': 'no-store',
    },
  })

sw.addEventListener('fetch', (event: any) => {
  const req: Request = event.request
  const url = new URL(req.url)
  // other origins: the CSP already refuses them; bootstrap files: network
  if (url.origin !== location.origin || HOST_FILES.includes(url.pathname)) return
  event.respondWith(serve(req, url))
})

async function serve(req: Request, url: URL): Promise<Response> {
  // An app runs framed by the chat app, never as a top-level page: there it
  // would have no sandbox attribute, and an opener could drive it.
  if (req.mode === 'navigate' && req.destination === 'document') {
    return respond('webxdc apps only run inside the chat app', 403)
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') return respond(null, 405)
  const path = xdcPath(url.pathname, true)
  const hit = path && (await caches.match(cacheKey(location.origin, path), { cacheName: XDC_CACHE }))
  if (!hit || !path) return respond('not found', 404)
  const type = mimeOf(path)
  // A frame of the app gets HTML only: every document is a fresh window with
  // pristine globals, and in an HTML page the guard runs first. A text file
  // or an image shown as a page would be one without it (webxdc-guard.ts).
  // A download (octet-stream, nosniff) never becomes a document.
  if (req.mode === 'navigate' && type !== 'text/html' && type !== 'application/octet-stream') return Response.error()
  const page = type === 'text/html' ? withGuard(new Uint8Array(await hit.arrayBuffer())) : null
  // Safari's media stack asks for byte ranges and won't play from a plain 200
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.get('range') ?? '')
  if (!range || (!range[1] && !range[2])) return respond(page ?? hit.body, 200, type, { 'accept-ranges': 'bytes' })
  const buf = page ? page.buffer : await hit.arrayBuffer()
  const size = buf.byteLength
  // bytes=a-b, bytes=a- (to the end), bytes=-n (the last n)
  const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]))
  const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1
  if (start >= size || start > end) return respond(null, 416, type, { 'content-range': `bytes */${size}` })
  return respond(buf.slice(start, end + 1), 206, type, {
    'accept-ranges': 'bytes',
    'content-range': `bytes ${start}-${end}/${size}`,
  })
}
