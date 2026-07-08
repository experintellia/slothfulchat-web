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
const sw = self as any

try {
  sw.importScripts('./sw-precache.js') // sets self.__PRECACHE + __PRECACHE_VERSION
} catch {
  // dev build without assemble: no precache, runtime caching still works
}
const MANIFEST: Record<string, string> = sw.__PRECACHE ?? {} // path -> content hash
const CACHE_PREFIX = 'slothful-shell-'
const CACHE = CACHE_PREFIX + (sw.__PRECACHE_VERSION ?? 'dev')
// the cache remembers which manifest filled it, so the next install can tell
// unchanged entries apart; synthetic URL, never collides with a real file
const MANIFEST_KEY = './__sw-manifest__'
const scopePath = new URL(sw.registration.scope).pathname

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
        if (!name.startsWith(CACHE_PREFIX) || name === CACHE) continue
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
      caches
        .keys()
        .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))),
    ])
  )
)

async function serveShell(event: any): Promise<Response> {
  const request = event.request
  // manifest keys are scope-relative paths (base-path agnostic, like the blob routes)
  const path = new URL(request.url).pathname
  const precached = Object.prototype.hasOwnProperty.call(
    MANIFEST,
    path.startsWith(scopePath) ? path.slice(scopePath.length) : ''
  )
  const cache = await caches.open(CACHE)
  // ignoreSearch: this is a pure static site, query params never change file
  // content — but requests carry them (main.html?proxy=..., core/worker.js?proxy=...)
  const cached = await cache.match(request, { ignoreSearch: true })
  if (cached && precached) {
    // content-versioned: never refetched at runtime, updates only arrive via a
    // new manifest (whole-deploy consistency, no per-file version skew)
    return cached
  }
  const network = fetch(request).then((res: Response) => {
    // runtime-cache only non-manifest URLs (e.g. bare "/"): manifest entries
    // must stay exactly the bytes their install hashed
    if (res.status === 200 && !precached) cache.put(request, res.clone())
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
  // match the tail so the app works under any base path (e.g. /repo/ on Pages)
  const blob = url.pathname.match(/\/blobs\/([^/]+)\/(.+)$/)
  const backup = url.pathname.match(/\/download-backup\/([^/]+)$/)
  // /blob-path/<uri-encoded absolute memfs path>: temp files outside the
  // blobdir, e.g. /tmp/<uuid>/<file> (see runtime.ts transformBlobURL)
  const bypath = url.pathname.match(/\/blob-path\/([^/]+)$/)
  // /webxdc-icon/:accountId/:msgId — icon from inside a .xdc archive; the
  // page resolves it via get_webxdc_info + get_webxdc_blob
  const xdcIcon = url.pathname.match(/\/webxdc-icon\/(\d+)\/(\d+)$/)
  if (!blob && !backup && !bypath && !xdcIcon) {
    // Range requests (media seeking) need 206 semantics the cache can't give
    if (!event.request.headers.has('range')) {
      event.respondWith(serveShell(event))
    }
    return
  }
  let filename = decodeURIComponent(blob ? blob[2] : backup ? backup[1] : '')
  const accountId = blob?.[1]
  // backup exports live in the memfs /exports dir (see runtime.ts EXPORTS_DIR)
  // and are always served as an attachment
  let path: string | undefined
  let downloadName = url.searchParams.get('download_with_filename')
  if (backup) {
    if (filename.includes('/') || filename.includes('..')) return
    path = `/exports/${filename}`
    downloadName = filename
  }
  if (bypath) {
    const decoded = decodeURIComponent(bypath[1])
    if (!decoded.startsWith('/') || decoded.includes('..')) return
    path = decoded
    filename = decoded.split('/').pop()! // page side derives MIME from this
  }
  const webxdcIcon = xdcIcon
    ? { accountId: Number(xdcIcon[1]), msgId: Number(xdcIcon[2]) }
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
      const headers: Record<string, string> = {
        'content-type': result.mime ?? 'application/octet-stream',
      }
      if (downloadName) {
        headers['content-disposition'] =
          `attachment; filename="${downloadName.replace(/["\\]/g, '')}"`
      }
      return new Response(result.data as unknown as BodyInit, { headers })
    })()
  )
})
