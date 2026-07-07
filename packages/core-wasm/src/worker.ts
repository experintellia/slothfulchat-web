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
const proxyUrl = new URL(import.meta.url).searchParams.get('proxy') ?? undefined

const ready = (async () => {
  await initWasm()
  return await init((message: string) => scope.postMessage(message), proxyUrl)
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
