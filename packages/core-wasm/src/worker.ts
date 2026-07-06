/**
 * Web Worker bootstrap: loads the wasm module, starts chatmail core, and
 * relays JSON-RPC strings between core and the page via postMessage.
 */
import initWasm, { init } from '../wasm-dist/deltachat_wasm.js'

const scope = self as unknown as {
  postMessage(message: string): void
  onmessage: ((event: MessageEvent<string>) => void) | null
}

const ready = (async () => {
  await initWasm()
  return await init((message: string) => scope.postMessage(message))
})()

scope.onmessage = async (event: MessageEvent<string>) => {
  const dc = await ready
  dc.receive(event.data)
}
