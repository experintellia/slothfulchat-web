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
  constructor(private worker: Worker) {
    super()
    this.worker.onmessage = (event: MessageEvent<unknown>) => {
      // non-string messages are fs side-channel replies, handled elsewhere
      if (typeof event.data !== 'string') return
      this._onmessage(JSON.parse(event.data) as yerpc.Message)
    }
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
   * persistence — see the worker `flush` op). No-op without persistence. */
  fsFlush(): Promise<void>
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
  const fsRequest = (
    op: 'read' | 'write' | 'remove' | 'exists' | 'flush',
    path: string,
    data?: Uint8Array,
  ): Promise<FsResponse> =>
    new Promise((resolve, reject) => {
      const id = nextId++
      pending.set(id, (response) =>
        response.ok
          ? resolve(response)
          : reject(new Error(response.error ?? `fs ${op} ${path} failed`)),
      )
      worker.postMessage({ type: 'fs', id, op, path, data })
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
    fsFlush: async () => {
      await fsRequest('flush', '')
    },
  }
}

export * from '@deltachat/jsonrpc-client'
