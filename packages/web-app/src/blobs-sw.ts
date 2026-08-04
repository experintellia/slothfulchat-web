/**
 * Service worker serving GET /blobs/:accountId/:filename from the wasm core's
 * in-memory filesystem. The SW itself has no core access — it asks the page:
 *   SW -> page: { type: 'blob-request', id, accountId, filename }
 *   page -> SW: { type: 'blob-response', id, data?: Uint8Array, mime? }
 * Correlated by id; missing data => 404.
 *
 * Also the offline app shell: install precaches the content-hashed manifest
 * sw-manifest.mjs emits into sw-precache.js, so the app boots offline after
 * one online visit. Precached files are served cache-only; updates arrive as
 * a whole new manifest (new SW version) whose install re-downloads ONLY files
 * whose hash changed and copies the rest over from the previous cache —
 * GitHub Pages regenerates every ETag per deploy, so HTTP caching alone would
 * re-download the world (including the 10MB emoji font) after each deploy.
 */
import { blobResponseInit } from './blob-response.mjs'
import { isBlobRoute, resolveBlobRoute } from './blob-route.mjs'
import { cacheName, isOwnCache, shellRole } from './sw-cache.mjs'

const sw = self as any

try {
  sw.importScripts('./sw-precache.js') // sets self.__PRECACHE + __PRECACHE_VERSION
} catch {
  // dev build without assemble: no precache, runtime caching still works
}
const MANIFEST: Record<string, string> = sw.__PRECACHE ?? {} // path -> content hash
const scopePath = new URL(sw.registration.scope).pathname
// scope-qualified name: caches are per origin, so a sibling deploy of this app
// under another base path must not be mistaken for a stale copy of ours
const CACHE = cacheName(scopePath, sw.__PRECACHE_VERSION ?? 'dev')
// the cache remembers which manifest filled it, so the next install can tell
// unchanged entries apart; synthetic URL, never collides with a real file
const MANIFEST_KEY = './__sw-manifest__'

type BlobResponse = { type: 'blob-response'; id: string; data?: Uint8Array; mime?: string }
const pending = new Map<string, (r: BlobResponse) => void>()

sw.addEventListener('install', (event: any) =>
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE)
      // find the previous deploy's cache to copy unchanged entries from
      let oldCache: Cache | undefined
      let oldManifest: Record<string, string> = {}
      for (const name of await caches.keys()) {
        // pre-rename caches count too: their entries are keyed by absolute URL,
        // so a sibling scope's cache simply never matches and only ours is reused
        if (!isOwnCache(name, scopePath) || name === CACHE) continue
        const stored = await (await caches.open(name)).match(MANIFEST_KEY)
        if (stored) {
          oldCache = await caches.open(name)
          oldManifest = await stored.json()
          break // any manifest-bearing cache works: equal hash => equal bytes
        }
      }
      // allSettled: a single missing file must not brick install/blob serving;
      // the entry stays absent and self-heals on the next update
      const results = await Promise.allSettled(
        Object.entries(MANIFEST).map(async ([file, hash]) => {
          if (oldCache && oldManifest[file] === hash) {
            const reuse = await oldCache.match(file)
            if (reuse) return cache.put(file, reuse)
          }
          // no-cache: revalidate instead of trusting HTTP-cache freshness — a
          // deploy inside Pages' max-age=600 window would otherwise poison the
          // new cache with a stale-but-"fresh" copy (304 when truly unchanged)
          const res = await fetch(file, { cache: 'no-cache' })
          if (res.status !== 200) throw new Error(`precache ${file}: ${res.status}`)
          await cache.put(file, res)
        })
      )
      // failures are tolerated but must not be invisible (a silently absent
      // file = undiagnosable "broken offline" later): keep them inspectable
      // via caches.match('./__sw-install-errors__')
      const errors = results
        .filter(r => r.status === 'rejected')
        .map(r => String((r as PromiseRejectedResult).reason))
      if (errors.length) console.warn('sw precache failures:', errors)
      await cache.put('./__sw-install-errors__', new Response(JSON.stringify(errors)))
      await cache.put(MANIFEST_KEY, new Response(JSON.stringify(MANIFEST)))
      sw.skipWaiting()
    })()
  )
)
sw.addEventListener('activate', (event: any) =>
  event.waitUntil(
    Promise.all([
      sw.clients.claim(),
      // only caches this app owns: everything else on the origin is somebody
      // else's (another app, or this app deployed under another base path)
      caches
        .keys()
        .then(keys =>
          Promise.all(
            keys.filter(k => k !== CACHE && isOwnCache(k, scopePath)).map(k => caches.delete(k))
          )
        ),
    ])
  )
)

async function serveShell(event: any, role: string): Promise<Response> {
  const request = event.request
  const cache = await caches.open(CACHE)
  // ignoreSearch, but only for manifest files. The old blanket version defended
  // itself with "this is a pure static site, query params never change file
  // content" — true of OUR files (content-hashed assets, requested with a query
  // like main.html?proxy=...), false of the origin at large: a self-hoster can
  // put a dynamic endpoint next to dist/ (SELFHOSTING.md's bridge behind the
  // same TLS front, a webimap endpoint, /help/), and there a query is the whole
  // request. Those are role null now — never matched, never cached — and what
  // we do runtime-cache keys on the full URL.
  // NB: a cached response's URL has no query string, and for scripts/workers it
  // REPLACES the request URL (import.meta.url) — never pass config via
  // script-URL params here; the core worker gets its config via postMessage.
  const cached =
    role === 'precache'
      ? await cache.match(request, { ignoreSearch: true })
      : role === 'runtime'
        ? await cache.match(request)
        : undefined
  if (cached && role === 'precache') {
    // content-versioned: never refetched at runtime, updates only arrive via a
    // new manifest (whole-deploy consistency, no per-file version skew)
    return cached
  }
  const network = fetch(request).then((res: Response) => {
    // only the enumerated runtime routes are cached on the fly: manifest
    // entries must stay exactly the bytes their install hashed, and everything
    // else on the origin is not ours to store
    if (res.status === 200 && role === 'runtime') cache.put(request, res.clone())
    return res
  })
  if (cached) {
    event.waitUntil(network.catch(() => {})) // offline: background refresh just fails
    return cached
  }
  try {
    return await network
  } catch {
    if (request.mode === 'navigate') {
      // e.g. bare "/" was never fetched as such but the shell is precached
      const shell = await cache.match('main.html')
      if (shell) return shell
    }
    // uncached + offline: act like the file is missing, not like a network
    // error — the app already handles 404s (e.g. locales/en-US.json -> en.json)
    return new Response('offline', { status: 404 })
  }
}

sw.addEventListener('message', (event: any) => {
  const msg = event.data as BlobResponse
  if (msg?.type !== 'blob-response') return
  pending.get(msg.id)?.(msg)
  pending.delete(msg.id)
})

sw.addEventListener('fetch', (event: any) => {
  const url = new URL(event.request.url)
  if (event.request.method !== 'GET' || url.origin !== location.origin) {
    return // fall through to network
  }
  // one resolver for every /blobs/ route, so no route can be added without a
  // traversal check (blob-route.mjs; it is where the guards live and is tested
  // there). A refused route returns null and is dropped, not passed to the page.
  const route = resolveBlobRoute(url.pathname)
  if (!route) {
    // Not one of ours: serve the app shell. A route we recognised but refused
    // must NOT land here — it would answer a probe for a forbidden path with
    // the shell instead of nothing — so tell the two apart first.
    if (isBlobRoute(url.pathname)) return
    // and only take over what is ours to serve — a same-origin URL outside the
    // app's own files goes to the network untouched (sw-cache.mjs)
    const role = shellRole(url.pathname, scopePath, MANIFEST, event.request.mode === 'navigate')
    // Range requests (media seeking) need 206 semantics the cache can't give
    if (role && !event.request.headers.has('range')) {
      event.respondWith(serveShell(event, role))
    }
    return
  }
  const filename = route.kind === 'xdc-icon' ? '' : route.filename
  const accountId = route.kind === 'blob' ? route.accountId : undefined
  const path = 'path' in route ? route.path : undefined
  let downloadName = url.searchParams.get('download_with_filename')
  // backup exports are always served as an attachment
  if (route.kind === 'backup') downloadName = route.filename ?? null
  const webxdcIcon =
    route.kind === 'xdc-icon'
      ? { accountId: route.accountId, msgId: route.msgId }
      : undefined
  event.respondWith(
    (async () => {
      const clients = await sw.clients.matchAll({ type: 'window' })
      if (clients.length === 0) {
        return new Response('no window client to serve blob', { status: 503 })
      }
      const id = crypto.randomUUID()
      const response = new Promise<BlobResponse>(resolve => {
        pending.set(id, resolve)
        // ponytail: 15s timeout so a dead page can't leak entries forever
        setTimeout(() => {
          if (pending.delete(id)) resolve({ type: 'blob-response', id })
        }, 15_000)
      })
      for (const client of clients) {
        client.postMessage({ type: 'blob-request', id, accountId, filename, path, webxdcIcon })
      }
      const result = await response
      if (!result.data) {
        return new Response('blob not found', { status: 404 })
      }
      // status, headers (incl. the sandbox CSP every blob response needs) and
      // the byte slice to send — see blob-response.mjs
      const { status, headers, start, end } = blobResponseInit(
        result.data.byteLength,
        result.mime,
        downloadName,
        event.request.headers.get('range')
      )
      const body = result.data.subarray(start, end)
      return new Response(body as unknown as BodyInit, { status, headers })
    })()
  )
})
