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
    this.worker.onmessage = (event: MessageEvent<string>) => {
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

export interface Core {
  worker: Worker
  transport: WasmTransport
  dc: WasmDeltaChat
}

/** Spawns the core worker and returns the typed client. */
export function startCore(
  workerUrl: URL = new URL('./worker.js', import.meta.url),
): Core {
  const worker = new Worker(workerUrl, { type: 'module' })
  const transport = new WasmTransport(worker)
  const dc = new WasmDeltaChat(transport)
  return { worker, transport, dc }
}

export * from '@deltachat/jsonrpc-client'
