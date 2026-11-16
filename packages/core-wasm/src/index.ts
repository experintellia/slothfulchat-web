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
  digest?: string
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
  /** Stages an attachment under /tmp and returns the file and display name for sendMsg. */
  stageFile(name: string, data: Uint8Array): Promise<{ file: string; filename: string }>
  /** Removes a file or directory tree. */
  fsRemove(path: string): Promise<void>
  fsExists(path: string): Promise<boolean>
  /** Imports a backup into an unused account without mirroring the input archive. */
  restoreBackup(accountId: number, data: Blob | Uint8Array, passphrase?: string): Promise<void>
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

type StorageTransferOp = 'storage-list' | 'storage-read' | 'storage-stage'
  | 'storage-finish' | 'storage-verify' | 'storage-remove'

/** Spawns the core worker and returns the typed client.
 * `persist` (default true) keeps accounts/messages/blobs in OPFS across
 * page reloads; pass false for a fresh, fully in-memory core.
 * `storageKey` is an optional caller-managed 32-byte key for persistent storage.
 */
export function startCore(
  options: { wsProxyUrl?: string; persist?: boolean; storageKey?: Uint8Array } = {},
  workerUrl: URL = new URL('./worker.js', import.meta.url),
): Core {
  return startCoreWorker(options, workerUrl)
}

function startCoreWorker(
  options: { wsProxyUrl?: string; persist?: boolean; storageKey?: Uint8Array; upgradeSource?: boolean },
  workerUrl: URL,
) {
  const storageKey = options.storageKey
  const persist = options.persist !== false
  const encrypted = storageKey !== undefined
  if (encrypted && (storageKey.byteLength !== 32 || !persist)) {
    throw new TypeError('storageKey requires persistence and exactly 32 bytes')
  }
  const worker = new Worker(workerUrl, { type: 'module' })
  // Config goes via postMessage, not worker-URL query params: a service
  // worker serving the script from cache strips the query string from the
  // response URL (= the worker's import.meta.url), silently dropping params.
  // Safe to send immediately — messages queue until the worker module runs.
  worker.postMessage({
    type: 'config',
    proxyUrl: options.wsProxyUrl,
    persist,
    storageKey,
    upgradeSource: options.upgradeSource ?? false,
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
      new MessageEvent('message', {
        // `stack` alongside the message, as the init-error path does: worker-died
        // is the other kind that is a real bug, and the frames are what make one
        // diagnosable from a user's report (web-app's fatal-report.ts).
        data: { type: 'fatal-worker-died', message: cause.message, stack: cause.stack },
      }),
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
    const msg = event.data as { type?: string; message?: string; stack?: string }
    if (typeof event.data !== 'string' && msg?.type === 'fatal-worker-died') {
      const cause = new Error(msg.message ?? 'core worker died')
      // carry the WORKER's stack across: fail() re-dispatches this Error, and
      // an Error constructed here has our own frames — which would reach the
      // user's report pointing at this dispatcher instead of at the panic
      if (msg.stack) cause.stack = msg.stack
      fail(cause)
    }
  })

  const fsRequest = (
    op: 'read' | 'write' | 'remove' | 'exists' | 'flush' | 'failed' | 'restore-backup' | StorageTransferOp,
    path: string,
    data?: Uint8Array,
    since?: number,
    accountId?: number,
    archive?: Blob,
  ): Promise<FsResponse> =>
    new Promise((resolve, reject) => {
      if (dead) return reject(dead)
      const id = nextId++
      pending.set(id, (response) =>
        response.ok
          ? resolve(response)
          : reject(new Error(response.error ?? `fs ${op} ${path} failed`)),
      )
      const transfer = data && op === 'storage-stage' ? [data.buffer as ArrayBuffer] : []
      worker.postMessage({ type: 'fs', id, op, path, data, since, accountId, archive }, transfer)
    })

  return {
    worker,
    transport,
    dc,
    storageTransfer: (op: StorageTransferOp, accountId: number, filename = '', bytes?: Uint8Array) =>
      fsRequest(op, filename, bytes, undefined, accountId),
    fsRead: async (path) => (await fsRequest('read', path)).data ?? new Uint8Array(),
    fsWrite: async (path, data) => {
      await fsRequest('write', path, data)
    },
    stageFile: async (name, data) => {
      const basename = name.split(/[/\\]/).pop()
      const filename = !basename || basename === '.' || basename === '..' ? 'file' : basename
      const temporary = `/tmp/${crypto.randomUUID()}`
      const file = encrypted ? temporary : `${temporary}/${filename}`
      await fsRequest('write', file, data)
      return { file, filename }
    },
    fsRemove: async (path) => {
      await fsRequest('remove', path)
    },
    fsExists: async (path) => (await fsRequest('exists', path)).exists === true,
    restoreBackup: async (accountId, data, passphrase) => {
      const archive = data instanceof Blob ? data : new Blob([new Uint8Array(data).buffer])
      if (archive.size === 0) throw new Error('Backup is empty')
      const before = (await fsRequest('failed', '')).failed ?? 0
      await fsRequest('restore-backup', passphrase ?? '', undefined, undefined, accountId, archive)
      if ((await fsRequest('flush', '', undefined, before)).failed) {
        throw new Error('Restored files could not be persisted')
      }
    },
    fsFlush: async (since?: number) => (await fsRequest('flush', '', undefined, since)).failed ?? 0,
    fsFailed: async () => (await fsRequest('failed', '')).failed ?? 0,
  } satisfies Core & {
    storageTransfer(op: StorageTransferOp, accountId: number, filename?: string, bytes?: Uint8Array): Promise<FsResponse>
  }
}

/**
 * Upgrades one account in the ordinary store and returns its new ID.
 * Close both persistent workers before calling. Attachments are transferred
 * individually and staged encrypted. The original account is removed only after the encrypted account
 * has reopened successfully and its attachment contents have been verified.
 */
export async function upgradeAccountStorage(
  accountId: number,
  storageKey: Uint8Array,
  workerUrl: URL = new URL('./worker.js', import.meta.url),
): Promise<number> {
  const key = storageKey.slice()
  if (key.byteLength !== 32) throw new TypeError('storageKey must contain exactly 32 bytes')

  const source = startCoreWorker({ upgradeSource: true }, workerUrl)
  let destination: ReturnType<typeof startCoreWorker> | undefined
  let upgradedId: number | undefined
  let verified = false
  try {
    destination = startCoreWorker({ storageKey: key }, workerUrl)
    await destination.dc.rpc.getAllAccountIds()
    await source.dc.rpc.stopIo(accountId)
    upgradedId = await destination.dc.rpc.addAccount()
    const database = (await source.storageTransfer('storage-read', accountId)).data
    if (!database) throw new Error('Source database is missing')
    await destination.storageTransfer('storage-stage', upgradedId, '', database)
    const list = (await source.storageTransfer('storage-list', accountId)).digest
    if (list === undefined) throw new Error('Source attachment list is missing')
    const filenames: string[] = JSON.parse(list)
    for (const filename of filenames) {
      const bytes = (await source.storageTransfer('storage-read', accountId, filename)).data
      if (!bytes) throw new Error('Source attachment could not be read')
      await destination.storageTransfer('storage-stage', upgradedId, filename, bytes)
    }
    await destination.storageTransfer('storage-finish', upgradedId)
    const expected = (await destination.storageTransfer('storage-verify', upgradedId)).digest
    destination.worker.terminate()
    destination = undefined

    destination = startCoreWorker({ storageKey: key }, workerUrl)
    const actual = (await destination.storageTransfer('storage-verify', upgradedId)).digest
    if (expected === undefined || actual !== expected) {
      throw new Error('Encrypted account changed after reopening')
    }
    verified = true
    await source.storageTransfer('storage-remove', accountId)
    return upgradedId
  } catch (error) {
    if (!verified && upgradedId !== undefined && destination) {
      // A failed import can leave a new account behind. Never remove any
      // pre-existing encrypted account or the original on this path.
      try {
        const beforeCleanup = await destination.fsFailed()
        await destination.dc.rpc.removeAccount(upgradedId)
        if (await destination.fsFlush(beforeCleanup) !== 0) {
          throw new Error('The browser reported a failure removing the incomplete account')
        }
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], 'Storage upgrade and destination cleanup failed')
      }
    }
    if (verified) {
      throw new Error(`Encrypted account ${upgradedId} is ready, but its original could not be removed`, { cause: error })
    }
    throw error
  } finally {
    key.fill(0)
    destination?.worker.terminate()
    source.worker.terminate()
  }
}

export * from '@deltachat/jsonrpc-client'
