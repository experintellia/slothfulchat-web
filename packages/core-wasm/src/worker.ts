/**
 * Web Worker bootstrap: loads the wasm module, starts chatmail core, and
 * relays JSON-RPC strings between core and the page via postMessage.
 *
 * Besides JSON-RPC strings, object messages `{ type: 'fs', ... }` are a
 * side channel into core's in-memory filesystem (blob display, temp files,
 * backup import/export), and a one-shot `{ type: 'config', ... }` from
 * startCore delivers proxy/persist settings before init.
 */
import initWasm, {
  init,
  set_account_template,
  set_crypto_offload,
} from '../wasm-dist/deltachat_wasm.js'
import { OPFS_PROBE_DEADLINE_MS, probeUntilDeadline } from './opfs-probe.mjs'

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

/** Asks the pool how many ops it has run — see {@link CryptoPool.stats}. */
interface CryptoStatsRequest {
  type: 'crypto-stats'
}

/** One queued or running op. */
interface CryptoJob {
  id: number
  op: string
  payload: Uint8Array
  resolve: (reply: Uint8Array) => void
  reject: (err: Error) => void
  timer?: ReturnType<typeof setTimeout>
}

/** Beyond this many waiting ops, `run()` rejects so core computes them
 * inline instead of piling up copies of large payloads in memory. */
const MAX_QUEUED = 8

/**
 * Per-op deadline. A worker that answered `ready` and then goes silent — the
 * OS reclaiming it under memory pressure, a wedged instance — would
 * otherwise leave core awaiting a promise that never settles, which no error
 * path can rescue. Calibrated from the issue #3 device runs: keygen is
 * milliseconds and the slowest measured payload op was a 5 MB encrypt at
 * 11.3 s on an iPhone, so 15 s + 4 s/MB keeps >2x headroom everywhere we
 * measured while still recovering a dead worker promptly.
 */
const opTimeoutMs = (payload: Uint8Array) => 15_000 + (payload.byteLength / 1e6) * 4_000

/**
 * Prewarmed worker that runs offloaded PGP ops (issue #3) so core's thread
 * stays responsive. Registered with the wasm side via `set_crypto_offload`
 * only once its worker is ready. Never a correctness dependency: core
 * computes the op inline whenever this is unregistered, dead, erroring, or
 * too slow to answer.
 * ponytail: pool of one, so one op runs at a time; bump to N workers (and N
 * concurrent jobs) if parallel crypto ever matters.
 */
class CryptoPool {
  private worker: Worker | null = null
  private nextId = 1
  private active: CryptoJob | null = null
  private queue: CryptoJob[] = []
  private resolveReady!: () => void
  /** Resolves once a worker has loaded the wasm artifact. Never resolves if
   * spawning fails for good — then registration never happens (inline). */
  readonly ready = new Promise<void>(resolve => {
    this.resolveReady = resolve
  })
  private spawnFailures = 0
  /** Ops completed on the pool, by op name. Pulled by tests via the
   * `crypto-stats` message rather than pushed per op — offloading is on the
   * hot path of every message, so it must stay silent when nobody asks. */
  private readonly offloaded = new Map<string, number>()

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
      // ignore replies that don't match the running op: a late answer from a
      // worker we already gave up on must not settle its successor's job
      const job = this.active
      if (job && msg.id === job.id) {
        clearTimeout(job.timer)
        this.active = null
        if (msg.ok && msg.reply) {
          // reset on useful work, not on the ready handshake: a payload that
          // reliably traps the instance would otherwise respawn forever
          this.spawnFailures = 0
          this.offloaded.set(job.op, (this.offloaded.get(job.op) ?? 0) + 1)
          job.resolve(msg.reply)
        } else {
          job.reject(new Error(msg.error ?? `crypto op ${job.op} failed`))
        }
        // only the running job's reply can attest that its own worker
        // trapped; checked outside, a late one killed the replacement
        if (msg.fatal) return this.die(new Error(msg.error ?? 'crypto worker trapped'))
      }
      this.pump()
    }
    worker.onerror = event => {
      this.die(new Error(`crypto worker error: ${event.message ?? 'unknown'}`))
    }
    // a reply that can't be deserialized never reaches onmessage, so without
    // this the running op would wait out its whole deadline
    worker.onmessageerror = () => this.die(new Error('crypto worker reply was undeserializable'))
  }

  private die(cause: Error): void {
    // reject the running op AND everything queued: each one falls back to
    // core's inline path immediately instead of waiting on the respawn
    if (this.active) clearTimeout(this.active.timer)
    for (const job of [this.active, ...this.queue]) job?.reject(cause)
    this.active = null
    this.queue = []
    this.worker?.terminate()
    this.worker = null
    // >3 failures without a single completed op = permanently dead; run()
    // then rejects every op and core computes it inline instead
    if (++this.spawnFailures > 3) return
    this.spawn()
  }

  /** Starts the next queued op if the worker is free. */
  private pump(): void {
    const worker = this.worker
    if (this.active || !worker) return
    const job = this.queue.shift()
    if (!job) return
    this.active = job
    // set before posting: transferring detaches the buffer, zeroing its length
    job.timer = setTimeout(
      () => this.die(new Error(`crypto op ${job.op} timed out`)),
      opTimeoutMs(job.payload),
    )
    try {
      worker.postMessage({ id: job.id, op: job.op, payload: job.payload }, [job.payload.buffer])
    } catch (err) {
      // no reply is coming for a message that never left: settle it here
      // instead of stranding the slot until the deadline kills the worker
      clearTimeout(job.timer)
      this.active = null
      job.reject(new Error(`crypto op ${job.op} could not be posted: ${String(err)}`))
      this.pump()
    }
  }

  /** How many ops of each kind the pool has completed, e.g. `{ keygen: 2 }`.
   * Empty means core computed everything inline. */
  stats(): Record<string, number> {
    return Object.fromEntries(this.offloaded)
  }

  /** Queues one op for the pool worker. The payload's buffer is transferred —
   * safe, and never retried here: core recomputes inline if this rejects. */
  run(op: string, payload: Uint8Array): Promise<Uint8Array> {
    if (!this.worker) return Promise.reject(new Error('crypto pool is dead'))
    if (this.queue.length >= MAX_QUEUED) {
      return Promise.reject(new Error('crypto pool queue is full'))
    }
    return new Promise((resolve, reject) => {
      this.queue.push({ id: this.nextId++, op, payload, resolve, reject })
      this.pump()
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
  // Set once the deadline has passed with a probe still outstanding: a hung
  // createSyncAccessHandle cannot be cancelled, but the walk around it can, so
  // the abandoned probe stops opening further handles the moment it un-hangs
  // (the one it was waiting on is closed immediately, as always).
  let abandoned = false
  const probeDir = async (dir: any): Promise<void> => {
    for await (const entry of dir.values()) {
      if (abandoned) return
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
    if (abandoned) return
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
  // One pass. True = free to proceed, false = locked and worth retrying; a
  // throw ends the wait for good. createSyncAccessHandle can HANG rather than
  // reject while the previous worker is mid-teardown, so the timing policy —
  // one wall-clock deadline covering every pass, and never a second probe
  // while one is still outstanding — lives in opfs-probe.mjs, where the
  // reasoning behind the number and its unit test are.
  let attempts = 0
  const probeOnce = async (): Promise<boolean> => {
    attempts++
    try {
      const root = await (self as any).navigator.storage.getDirectory()
      await probeAll(root)
      return true
    } catch (err) {
      if ((err as DOMException)?.name === 'NotFoundError') return true
      if ((err as DOMException)?.name === 'SecurityError') {
        // storage blocked by browser settings (e.g. Safari "Block All
        // Cookies"), not a lock — retrying can't help and the "another tab"
        // dialog would mislead. Tell the page and fail immediately.
        fatalReported = true
        scope.postMessage({ type: 'fatal-storage-blocked' } as unknown as string)
        throw err
      }
      console.warn(`[core-wasm] OPFS locked (old worker still alive?), retry ${attempts}`)
      return false
    }
  }
  const outcome = await probeUntilDeadline(probeOnce)
  if (outcome === 'ready') return
  abandoned = true
  // Out of time: almost certainly another live tab, or ('hung') a handle
  // acquisition the browser never settled. Tell the page — it shows the
  // "already running in another tab" dialog, so the user gets an explanation
  // within the deadline instead of an endless loading screen — and fail
  // loudly: proceeding into init would hang forever in the sahpool install.
  console.warn(`[core-wasm] OPFS probe ${outcome} after ${OPFS_PROBE_DEADLINE_MS}ms, giving up`)
  fatalReported = true
  scope.postMessage({ type: 'fatal-opfs-locked' } as unknown as string)
  throw new Error('OPFS is locked — SlothfulChat seems to be running in another tab')
}

/** True once a specific fatal-* message went to the page, so the generic
 * catch below doesn't stack a second dialog on top of it. */
let fatalReported = false

/** How long boot will wait for the account template before giving up on it.
 * Only ever reached on a first visit — after that it is served from the
 * service worker's precache. */
const TEMPLATE_FETCH_DEADLINE_MS = 10_000

/** The pre-migrated account database new accounts are stamped out of, fetched
 * in parallel with the wasm module (it is a few KB, gzipped by the generator
 * because no static host reliably compresses `.db`). Purely an optimization:
 * if it is missing, stale or corrupt, account creation replays migrations as
 * it always did, so every failure here is a warning and never fatal.
 *
 * Cleared once handed to the wasm side, which keeps its own copy — holding the
 * promise would pin a second ~900KB for the worker's lifetime. */
let accountTemplate: Promise<Uint8Array | undefined> | undefined = (async () => {
  const res = await fetch(new URL('../wasm-dist/fresh_account.db.gz', import.meta.url), {
    // boot awaits this, so a request that STALLS rather than fails would hang
    // the loading screen on the one path that has no precached copy yet (first
    // visit). Time it out into the fallback instead — being slow to create an
    // account beats never starting.
    signal: AbortSignal.timeout(TEMPLATE_FETCH_DEADLINE_MS),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const raw = new Uint8Array(await res.arrayBuffer())
  // a host that serves .gz with `content-encoding: gzip` already unwrapped it
  if (new TextDecoder().decode(raw.subarray(0, 6)) === 'SQLite') return raw
  const plain = new Response(raw).body!.pipeThrough(new DecompressionStream('gzip'))
  return new Uint8Array(await new Response(plain).arrayBuffer())
})().catch(err => {
  console.warn(`[core-wasm] no account template (${err}); new accounts will migrate`)
  return undefined
})

const ready = (async () => {
  const { proxyUrl, persist } = await config
  await initWasm()
  const template = await accountTemplate
  if (template) set_account_template(template)
  accountTemplate = undefined
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

scope.onmessage = async (
  event: MessageEvent<string | FsRequest | ConfigMessage | CryptoStatsRequest>,
) => {
  const msg = event.data
  if (typeof msg !== 'string' && msg?.type === 'config') {
    resolveConfig(msg)
    return
  }
  // answered before `await ready` so it works even while core is still
  // booting, and so it never perturbs the crypto path it reports on
  if (typeof msg !== 'string' && msg?.type === 'crypto-stats') {
    scope.postMessage({ type: 'crypto-stats', offloaded: pool.stats() } as unknown as string)
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
