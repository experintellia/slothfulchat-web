/**
 * Crypto pool worker: loads the same wasm artifact as the core worker and
 * runs one offloaded PGP op per `{ id, op, payload }` message, replying
 * `{ id, ok, reply | error, fatal }` (see CryptoPool in worker.ts). A second
 * wasm instance — it shares nothing with core's; `crypto_op` is pure
 * compute over the payload.
 */
import initWasm, { crypto_op } from '../wasm-dist/deltachat_wasm.js'

interface CryptoRequest {
  id: number
  op: string
  payload: Uint8Array
}

const scope = self as unknown as {
  postMessage(message: unknown, transfer?: Transferable[]): void
  onmessage: ((event: MessageEvent<CryptoRequest>) => void) | null
}

const ready = initWasm()
ready.then(
  () => scope.postMessage({ type: 'ready' }),
  (err: unknown) => scope.postMessage({ type: 'ready', error: String(err) }),
)

scope.onmessage = async (event: MessageEvent<CryptoRequest>) => {
  const { id, op, payload } = event.data
  try {
    await ready
    const reply: Uint8Array = crypto_op(op, payload)
    scope.postMessage({ id, ok: true, reply }, [reply.buffer])
  } catch (err) {
    scope.postMessage({
      id,
      ok: false,
      error: String(err),
      // RuntimeError is a trap (or a Rust panic — wasm32 has no unwinding);
      // RangeError is the glue failing to allocate the reply out of wasm,
      // which doesn't corrupt this instance but means its heap is the full
      // one. Respawn on both: a needless restart is the cheaper mistake.
      fatal: err instanceof WebAssembly.RuntimeError || err instanceof RangeError,
    })
  }
}
