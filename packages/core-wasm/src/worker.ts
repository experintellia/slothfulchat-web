/**
 * Web Worker bootstrap: loads the wasm module, starts chatmail core, and
 * relays JSON-RPC strings between core and the page via postMessage.
 *
 * Besides JSON-RPC strings, object messages `{ type: 'fs', ... }` are a
 * side channel into core's in-memory filesystem (blob display, temp files,
 * backup import/export), and a one-shot `{ type: 'config', ... }` from
 * startCore delivers proxy/persist settings before init.
 */
import initWasm, { init, set_crypto_offload } from '../wasm-dist/deltachat_wasm.js'

interface FsRequest {
  type: 'fs'
  id: number
  op: 'read' | 'write' | 'remove' | 'exists' | 'flush' | 'failed'
  path: string
  data?: Uint8Array
  /** flush op: failed-counter baseline (a prior `failed` op result) taken
   * before the work being verified started. */
  since?: number
}

interface FsResponse {
  type: 'fs'
  id: number
  ok: boolean
  data?: Uint8Array
  exists?: boolean
  /** flush op: writes that did NOT reach OPFS (0 = fully durable). */
  failed?: number
  error?: string
}

interface ConfigMessage {
  type: 'config'
  /** WebSocket→TCP proxy URL; networking is disabled without one. */
  proxyUrl?: string
  /** OPFS persistence; false = fresh in-memory core (tests). */
  persist: boolean
}

const scope = self as unknown as {
  postMessage(message: string | FsResponse): void
  onmessage: ((event: MessageEvent<string | FsRequest | ConfigMessage>) => void) | null
}

// Config arrives as the first postMessage from startCore, NOT as worker-URL
// query params: the web-app's app-shell service worker serves the precached
// worker.js, and a cached response's URL (which becomes import.meta.url)
// carries no query string — URL params get silently dropped.
let resolveConfig: (config: ConfigMessage) => void
const config = new Promise<ConfigMessage>(resolve => {
  resolveConfig = resolve
})

/** One reply from crypto-worker.ts: the ready handshake or an op result. */
interface CryptoReply {
  type?: 'ready'
  id?: number
  ok?: boolean
  reply?: Uint8Array
  error?: string
  /** wasm trap — the worker's instance is poisoned, respawn it. */
  fatal?: boolean
}

/**
 * Prewarmed worker that runs offloaded PGP ops (issue #3) so core's thread
 * stays responsive. Registered with the wasm side via `set_crypto_offload`
 * only once its worker is ready. Never a correctness dependency: core
 * computes the op inline whenever this is unregistered, dead, or errors.
 * ponytail: pool of one; bump to N workers if parallel crypto ever matters.
 */
class CryptoPool {
  private worker: Worker | null = null
  private nextId = 1
  private inflight = new Map<
    number,
    { resolve: (reply: Uint8Array) => void; reject: (err: Error) => void; op: string }
  >()
  private resolveReady!: () => void
  /** Resolves once a worker has loaded the wasm artifact. Never resolves if
   * spawning fails for good — then registration never happens (inline). */
  readonly ready = new Promise<void>(resolve => {
    this.resolveReady = resolve
  })
  private spawnFailures = 0
  private offloaded = 0

  constructor() {
    this.spawn()
  }

  private spawn(): void {
    let worker: Worker
    try {
      // nested workers are unsupported in some engines → die permanently
      // (spawnFailures exhausts) and stay inline forever
      worker = new Worker(new URL('./crypto-worker.js', import.meta.url), { type: 'module' })
    } catch (err) {
      this.die(new Error(`crypto worker spawn failed: ${String(err)}`))
      return
    }
    this.worker = worker
    worker.onmessage = (event: MessageEvent<CryptoReply>) => {
      const msg = event.data
      if (msg.type === 'ready') {
        if (msg.error !== undefined) this.die(new Error(msg.error))
        else this.resolveReady()
        return
      }
      const entry = msg.id === undefined ? undefined : this.inflight.get(msg.id)
      if (entry) {
        this.inflight.delete(msg.id!)
        if (msg.ok && msg.reply) {
          // reset on useful work, not on the ready handshake: a payload that
          // reliably traps the instance would otherwise respawn forever
          this.spawnFailures = 0
          this.offloaded++
          // observable marker for tests; every other listener ignores it
          scope.postMessage({ type: 'crypto-offload', op: entry.op, count: this.offloaded } as unknown as string)
          entry.resolve(msg.reply)
        } else {
          entry.reject(new Error(msg.error ?? `crypto op ${entry.op} failed`))
        }
      }
      if (msg.fatal) this.die(new Error(msg.error ?? 'crypto worker trapped'))
    }
    worker.onerror = event => {
      this.die(new Error(`crypto worker error: ${event.message ?? 'unknown'}`))
    }
  }

  private die(cause: Error): void {
    for (const { reject } of this.inflight.values()) reject(cause)
    this.inflight.clear()
    this.worker?.terminate()
    this.worker = null
    // >3 failures without a single completed op = permanently dead; run()
    // then rejects every op and core computes it inline instead
    if (++this.spawnFailures > 3) return
    this.spawn()
  }

  /** Runs one op on the pool worker. The payload's buffer is transferred —
   * safe, and never retried here: core recomputes inline if this rejects. */
  run(op: string, payload: Uint8Array): Promise<Uint8Array> {
    const worker = this.worker
    if (!worker) return Promise.reject(new Error('crypto pool is dead'))
    return new Promise((resolve, reject) => {
      const id = this.nextId++
      worker.postMessage({ id, op, payload }, [payload.buffer])
      this.inflight.set(id, { resolve, reject, op })
    })
  }
}

// module-level: prewarms the pool worker in parallel with core's own initWasm
const pool = new CryptoPool()

/** Reload race: the previous worker's OPFS sync access handles release only
 * once that worker is fully destroyed, and a fast reload (service-worker
 * cache, offline) starts us before that. A failed sahpool install cannot be
 * retried (it leaks its own partial handles and the next attempt hangs), so
 * wait for the lock BEFORE init: probe every sahpool pool file until all can
 * be exclusively acquired. The wasm side also holds permanent handles on
 * memfs/accounts/accounts.toml{,.bak} (synchronous config write-through), so
 * probe those too. Fresh origins have neither dir — no wait. */
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
  const notFoundOk = (err: unknown) => {
    if ((err as DOMException)?.name !== 'NotFoundError') throw err
  }
  const probeAll = async (root: any): Promise<void> => {
    // NotFound tolerance must cover the getDirectoryHandle too (fresh origin
    // has no pool dir) WITHOUT bailing out of the whole probe — the memfs
    // config locks below must still be checked. Lock errors propagate.
    await root
      .getDirectoryHandle('.opfs-sahpool')
      .then(probeDir)
      .catch(notFoundOk)
    // exactly the two files the wasm side holds permanent handles on; NOT
    // the whole memfs mirror (nothing else is ever locked, and account dirs
    // hold arbitrarily many blobs)
    const accounts = await root
      .getDirectoryHandle('memfs')
      .then((m: any) => m.getDirectoryHandle('accounts'))
      .catch(() => null)
    if (!accounts) return
    for (const name of ['accounts.toml', 'accounts.toml.bak']) {
      await accounts
        .getFileHandle(name)
        .then((f: any) => f.createSyncAccessHandle())
        .then((h: any) => h.close())
        .catch(notFoundOk)
    }
  }
  for (let attempt = 1; attempt <= 30; attempt++) {
    try {
      const root = await (self as any).navigator.storage.getDirectory()
      // race a timeout: createSyncAccessHandle can HANG (not reject) while
      // the previous worker is mid-teardown. The budget grows with each
      // attempt: the pool has max(32, 2N+8) files and never shrinks, and on
      // slow storage (low-end eMMC) probing them all can exceed a fixed 2s
      // every time — which would misreport "already running in another tab"
      // and brick boot with no other tab open. Later attempts allow more time.
      const budgetMs = Math.min(2000 + (attempt - 1) * 1000, 12000)
      await Promise.race([
        probeAll(root),
        new Promise((_, reject) => setTimeout(() => reject(new Error('probe timeout')), budgetMs)),
      ])
      return
    } catch (err) {
      if ((err as DOMException)?.name === 'NotFoundError') return
      if ((err as DOMException)?.name === 'SecurityError') {
        // storage blocked by browser settings (e.g. Safari "Block All
        // Cookies"), not a lock — retrying can't help and the "another tab"
        // dialog would mislead. Tell the page and fail immediately.
        fatalReported = true
        scope.postMessage({ type: 'fatal-storage-blocked' } as unknown as string)
        throw err
      }
      console.warn(`[core-wasm] OPFS locked (old worker still alive?), waiting ${attempt}/30`)
      await new Promise(r => setTimeout(r, 500))
    }
  }
  // still locked after all 30 attempts: almost certainly another live tab. Tell the page
  // (it shows the "already running in another tab" dialog) and fail loudly —
  // proceeding into init would hang forever in the sahpool install.
  fatalReported = true
  scope.postMessage({ type: 'fatal-opfs-locked' } as unknown as string)
  throw new Error('OPFS is locked — SlothfulChat seems to be running in another tab')
}

/** True once a specific fatal-* message went to the page, so the generic
 * catch below doesn't stack a second dialog on top of it. */
let fatalReported = false

const ready = (async () => {
  const { proxyUrl, persist } = await config
  await initWasm()
  // non-blocking: boot never waits on the pool — until it registers, core
  // computes crypto inline (the correct fallback)
  void pool.ready.then(() =>
    set_crypto_offload((op: string, payload: Uint8Array) => pool.run(op, payload))
  )
  if (persist) await waitForOpfsSyncHandles()
  return await init((message: string) => scope.postMessage(message), proxyUrl, persist)
})()
// any other init failure (e.g. corrupted persisted state the self-heal could
// not fix) must reach the page as a dialog, not die as an unhandled rejection
// leaving the loading screen up forever
ready.catch(err => {
  if (fatalReported) return
  scope.postMessage({ type: 'fatal-init-error', message: String(err) } as unknown as string)
})

scope.onmessage = async (event: MessageEvent<string | FsRequest | ConfigMessage>) => {
  const msg = event.data
  if (typeof msg !== 'string' && msg?.type === 'config') {
    resolveConfig(msg)
    return
  }
  const dc = await ready
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
      case 'flush':
        // awaits until every queued OPFS write-through is durable (backup
        // import persistence, see DeltaChat.fs_flush); reports how many writes
        // did NOT make it — since the caller's baseline (captured before the
        // import started, so mid-import failures count) or, without one, since
        // now — so the caller can avoid claiming a false success
        response.failed = await dc.fs_flush(msg.since ?? dc.fs_failed())
        break
      case 'failed':
        // snapshot of the monotonic failed-write counter, for a later flush
        response.failed = dc.fs_failed()
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
