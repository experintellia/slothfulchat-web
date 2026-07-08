/**
 * Web Worker bootstrap: loads the wasm module, starts chatmail core, and
 * relays JSON-RPC strings between core and the page via postMessage.
 *
 * Besides JSON-RPC strings, object messages `{ type: 'fs', ... }` are a
 * side channel into core's in-memory filesystem (blob display, temp files,
 * backup import/export).
 */
import initWasm, { init } from '../wasm-dist/deltachat_wasm.js'

interface FsRequest {
  type: 'fs'
  id: number
  op: 'read' | 'write' | 'remove' | 'exists' | 'mkdirp'
  path: string
  data?: Uint8Array
}

interface FsResponse {
  type: 'fs'
  id: number
  ok: boolean
  data?: Uint8Array
  exists?: boolean
  error?: string
}

const scope = self as unknown as {
  postMessage(message: string | FsResponse): void
  onmessage: ((event: MessageEvent<string | FsRequest>) => void) | null
}

// ?proxy=ws://... on the worker URL configures the WebSocket→TCP proxy
const workerParams = new URL(import.meta.url).searchParams
const proxyUrl = workerParams.get('proxy') ?? undefined
// OPFS persistence is on by default; ?persist=0 opts out (fresh-core tests)
const persist = workerParams.get('persist') !== '0'

/** Reload race: the previous worker's OPFS sync access handles release only
 * once that worker is fully destroyed, and a fast reload (service-worker
 * cache, offline) starts us before that. A failed sahpool install cannot be
 * retried (it leaks its own partial handles and the next attempt hangs), so
 * wait for the lock BEFORE init: probe every sahpool pool file until all can
 * be exclusively acquired. Fresh origins have no pool dir — no wait. */
async function waitForOpfsSyncHandles(): Promise<void> {
  const probeDir = async (dir: any): Promise<void> => {
    for await (const entry of dir.values()) {
      if (entry.kind === 'directory') {
        await probeDir(entry)
      } else {
        const handle = await entry.createSyncAccessHandle()
        handle.close()
      }
    }
  }
  for (let attempt = 1; attempt <= 30; attempt++) {
    try {
      const root = await (self as any).navigator.storage.getDirectory()
      // race a timeout: createSyncAccessHandle can HANG (not reject) while
      // the previous worker is mid-teardown
      await Promise.race([
        probeDir(await root.getDirectoryHandle('.opfs-sahpool')),
        new Promise((_, reject) => setTimeout(() => reject(new Error('probe timeout')), 2000)),
      ])
      return
    } catch (err) {
      if ((err as DOMException)?.name === 'NotFoundError') return
      console.warn(`[core-wasm] OPFS locked (old worker still alive?), waiting ${attempt}/30`)
      await new Promise(r => setTimeout(r, 500))
    }
  }
  // still locked after 15s: almost certainly another live tab. Tell the page
  // (it shows the "already running in another tab" dialog) and fail loudly —
  // proceeding into init would hang forever in the sahpool install.
  scope.postMessage({ type: 'fatal-opfs-locked' } as unknown as string)
  throw new Error('OPFS is locked — SlothfulChat seems to be running in another tab')
}

const ready = (async () => {
  await initWasm()
  if (persist) await waitForOpfsSyncHandles()
  return await init((message: string) => scope.postMessage(message), proxyUrl, persist)
})()

scope.onmessage = async (event: MessageEvent<string | FsRequest>) => {
  const dc = await ready
  const msg = event.data
  if (typeof msg === 'string') {
    dc.receive(msg)
    return
  }
  if (msg?.type !== 'fs') return
  const response: FsResponse = { type: 'fs', id: msg.id, ok: true }
  try {
    switch (msg.op) {
      case 'read':
        response.data = dc.fs_read(msg.path)
        break
      case 'write':
        dc.fs_write(msg.path, msg.data ?? new Uint8Array())
        break
      case 'remove':
        dc.fs_remove(msg.path)
        break
      case 'exists':
        response.exists = dc.fs_exists(msg.path)
        break
      case 'mkdirp':
        dc.fs_mkdirp(msg.path)
        break
      default:
        throw new Error(`unknown fs op: ${(msg as FsRequest).op}`)
    }
  } catch (err) {
    response.ok = false
    response.error = String(err)
  }
  scope.postMessage(response)
}
