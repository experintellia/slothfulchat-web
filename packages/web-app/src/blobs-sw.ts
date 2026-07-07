/**
 * Service worker serving GET /blobs/:accountId/:filename from the wasm core's
 * in-memory filesystem. The SW itself has no core access — it asks the page:
 *   SW -> page: { type: 'blob-request', id, accountId, filename }
 *   page -> SW: { type: 'blob-response', id, data?: Uint8Array, mime? }
 * Correlated by id; missing data => 404.
 */
const sw = self as any

type BlobResponse = { type: 'blob-response'; id: string; data?: Uint8Array; mime?: string }
const pending = new Map<string, (r: BlobResponse) => void>()

sw.addEventListener('install', () => sw.skipWaiting())
sw.addEventListener('activate', (event: any) => event.waitUntil(sw.clients.claim()))

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
  if (!blob && !backup) {
    return // fall through to network
  }
  const filename = decodeURIComponent(blob ? blob[2] : backup![1])
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
        client.postMessage({ type: 'blob-request', id, accountId, filename, path })
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
