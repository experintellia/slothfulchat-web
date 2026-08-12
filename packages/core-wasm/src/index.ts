/**
 * chatmail core as WASM behind the standard `@deltachat/jsonrpc-client` API.
 *
 * Core runs in a Web Worker (SQLite calls are synchronous; OPFS needs a
 * worker anyway). This module provides the yerpc transport that bridges
 * postMessage, in the exact spot where deltachat-desktop's browser edition
 * uses a WebsocketTransport.
 */
import { BaseDeltaChat, yerpc } from '@deltachat/jsonrpc-client'

const { BaseTransport } = yerpc

export class WasmTransport extends BaseTransport {
  // plain field + assignment, not a `private worker` parameter property: this
  // file is in web-app's tsconfig program (via its "paths"), which enables
  // erasableSyntaxOnly.
  private worker: Worker
  /** Set once the worker can no longer answer; see {@link fail}. */
  private dead: Error | null = null

  constructor(worker: Worker) {
    super()
    this.worker = worker
    this.worker.onmessage = (event: MessageEvent<unknown>) => {
      // non-string messages are fs side-channel replies, handled elsewhere
      if (typeof event.data !== 'string') return
      this._onmessage(JSON.parse(event.data) as yerpc.Message)
    }
  }

  /** The worker is gone: no response is ever coming, for anything. Settle
   * every request still waiting so callers get an error instead of a promise
   * that never resolves, and refuse new ones for the same reason.
   *
   * yerpc keeps pending requests in a `private` map with no public way to
   * settle them, so reach in — a hung UI is the worse trade. Cleared before
   * rejecting so a handler that immediately retries isn't wiped again. */
  fail(cause: Error): void {
    if (this.dead) return
    this.dead = cause
    const requests = (this as unknown as { _requests?: Map<unknown, { reject(e: Error): void }> })
      ._requests
    // optional: if a yerpc bump renames the private map, degrade to leaving
    // already-pending calls hanging rather than throwing out of the fail path
    // (which would skip the terminate and the dialog after it)
    if (!requests) return
    const handlers = [...requests.values()]
    requests.clear()
    for (const handler of handlers) handler.reject(cause)
  }

  request(method: string, params?: yerpc.Params): Promise<unknown> {
    return this.dead ? Promise.reject(this.dead) : super.request(method, params)
  }

  _send(message: yerpc.Message): void {
    this.worker.postMessage(JSON.stringify(message))
  }
}

export class WasmDeltaChat extends BaseDeltaChat<WasmTransport> {
  close() {
    /* noop — core lives as long as the worker */
  }
  constructor(transport: WasmTransport) {
    super(transport, true)
  }
}

interface FsResponse {
  type: 'fs'
  id: number
  ok: boolean
  data?: Uint8Array
  exists?: boolean
  failed?: number
  error?: string
}

export interface Core {
  worker: Worker
  transport: WasmTransport
  dc: WasmDeltaChat
  /** Reads a file from core's in-memory filesystem. */
  fsRead(path: string): Promise<Uint8Array>
  /** Writes a file, creating parent directories. */
  fsWrite(path: string, data: Uint8Array): Promise<void>
  /** Removes a file or directory tree. */
  fsRemove(path: string): Promise<void>
  fsExists(path: string): Promise<boolean>
  /** Resolves once every queued OPFS write-through is durable (backup-import
   * persistence — see the worker `flush` op). Resolves to the number of writes
   * that did NOT reach OPFS (0 = fully durable) since the `since` baseline —
   * an {@link fsFailed} snapshot taken before the work being verified started
   * (omit to only count failures during the drain itself). No-op (0) without
   * persistence. */
  fsFlush(since?: number): Promise<number>
  /** Snapshot of the monotonic failed-write counter, to pass to
   * {@link fsFlush}. Capture it BEFORE starting the work whose durability the
   * flush will verify — the OPFS flusher runs concurrently, so a later
   * baseline silently absorbs mid-work failures. */
  fsFailed(): Promise<number>
}

/** Spawns the core worker and returns the typed client.
 * `persist` (default true) keeps accounts/messages/blobs in OPFS across
 * page reloads; pass false for a fresh, fully in-memory core. */
export function startCore(
  options: { wsProxyUrl?: string; persist?: boolean } = {},
  workerUrl: URL = new URL('./worker.js', import.meta.url),
): Core {
  const worker = new Worker(workerUrl, { type: 'module' })
  // Config goes via postMessage, not worker-URL query params: a service
  // worker serving the script from cache strips the query string from the
  // response URL (= the worker's import.meta.url), silently dropping params.
  // Safe to send immediately — messages queue until the worker module runs.
  worker.postMessage({
    type: 'config',
    proxyUrl: options.wsProxyUrl,
    persist: options.persist !== false,
  })
  const transport = new WasmTransport(worker)
  const dc = new WasmDeltaChat(transport)

  // fs side channel: structured-clone objects on the same worker, correlated
  // by id. JSON-RPC strings keep flowing through WasmTransport untouched.
  let nextId = 1
  const pending = new Map<number, (response: FsResponse) => void>()
  worker.addEventListener('message', (event: MessageEvent<unknown>) => {
    const msg = event.data as FsResponse
    if (typeof event.data === 'string' || msg?.type !== 'fs') return
    pending.get(msg.id)?.(msg)
    pending.delete(msg.id)
  })

  // One failure path for every way the worker can stop answering after boot: a
  // Rust panic or OOM (`error`), a reply that can't be structured-cloned
  // (`messageerror`), or anything else that drops a response. Unlike the crypto
  // pool in worker.ts — same shape, and the reason this mirrors it — core has
  // no inline fallback, so the only honest move is to settle everything in
  // flight with an error and put the failure in front of the user.
  let dead: Error | null = null
  const fail = (cause: Error): void => {
    if (dead) return
    dead = cause
    transport.fail(cause)
    for (const [id, settle] of pending) settle({ type: 'fs', id, ok: false, error: cause.message })
    pending.clear()
    worker.terminate()
    // reuse the worker's own fatal-* message channel rather than adding a
    // second notification mechanism: the page already listens for those, and
    // a terminated worker obviously can't post this one itself
    worker.dispatchEvent(
      new MessageEvent('message', { data: { type: 'fatal-worker-died', message: cause.message } }),
    )
  }
  worker.onerror = (event) =>
    fail(new Error(`core worker error: ${(event as ErrorEvent).message || 'unknown'}`))
  worker.onmessageerror = () => fail(new Error('core worker reply was undeserializable'))
  // …and the death `error` cannot see: a core panic inside the worker's async
  // onmessage is an unhandled REJECTION there, which browsers never propagate
  // to worker.onerror. The worker reports those itself (see the
  // unhandledrejection reporter in worker.ts); settle everything on arrival.
  // fail() re-dispatches the same type synthetically — its `dead` guard stops
  // the recursion, and the page-side dialog dedupes the double delivery.
  worker.addEventListener('message', (event: MessageEvent<unknown>) => {
    const msg = event.data as { type?: string; message?: string }
    if (typeof event.data !== 'string' && msg?.type === 'fatal-worker-died') {
      fail(new Error(msg.message ?? 'core worker died'))
    }
  })

  const fsRequest = (
    op: 'read' | 'write' | 'remove' | 'exists' | 'flush' | 'failed',
    path: string,
    data?: Uint8Array,
    since?: number,
  ): Promise<FsResponse> =>
    new Promise((resolve, reject) => {
      if (dead) return reject(dead)
      const id = nextId++
      pending.set(id, (response) =>
        response.ok
          ? resolve(response)
          : reject(new Error(response.error ?? `fs ${op} ${path} failed`)),
      )
      worker.postMessage({ type: 'fs', id, op, path, data, since })
    })

  return {
    worker,
    transport,
    dc,
    fsRead: async (path) => (await fsRequest('read', path)).data ?? new Uint8Array(),
    fsWrite: async (path, data) => {
      await fsRequest('write', path, data)
    },
    fsRemove: async (path) => {
      await fsRequest('remove', path)
    },
    fsExists: async (path) => (await fsRequest('exists', path)).exists === true,
    fsFlush: async (since) => (await fsRequest('flush', '', undefined, since)).failed ?? 0,
    fsFailed: async () => (await fsRequest('failed', '')).failed ?? 0,
  }
}

export * from '@deltachat/jsonrpc-client'
