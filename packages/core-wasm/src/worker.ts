/**
 * Web Worker bootstrap: loads the wasm module, starts chatmail core, and
 * relays JSON-RPC strings between core and the page via postMessage.
 */
import initWasm, { init } from '../wasm-dist/deltachat_wasm.js'

const scope = self as unknown as {
  postMessage(message: string): void
  onmessage: ((event: MessageEvent<string>) => void) | null
}

// ?proxy=ws://... on the worker URL configures the WebSocket→TCP proxy
const proxyUrl = new URL(import.meta.url).searchParams.get('proxy') ?? undefined

const ready = (async () => {
  await initWasm()
  return await init((message: string) => scope.postMessage(message), proxyUrl)
})()

scope.onmessage = async (event: MessageEvent<string>) => {
  const dc = await ready
  dc.receive(event.data)
}
