// Dedicated PGP crypto worker for the /bench/ page (issue #3). Plain module
// worker, no build step. Loads the same wasm module as the core worker, but
// only runs the BenchPgp export — this models the "NEW" offloaded approach.
// The ../wasm-dist/ relative path resolves in both the package layout
// (bench/ next to wasm-dist/) and the deployed layout (/bench/ + /wasm-dist/).
import initWasm, { BenchPgp } from '../wasm-dist/deltachat_wasm.js'

let pgp // current keypair, replaced by each keygen

self.onmessage = (e) => {
  const { id, op, data } = e.data
  try {
    if (op === 'ping') {
      self.postMessage({ id })
    } else if (op === 'keygen') {
      const t = performance.now()
      pgp = new BenchPgp() // full PGP keygen, synchronous by design
      self.postMessage({ id, computeMs: performance.now() - t })
    } else if (op === 'encrypt' || op === 'decrypt') {
      const input = new Uint8Array(data)
      const t = performance.now()
      const out = pgp[op](input)
      const computeMs = performance.now() - t
      self.postMessage({ id, computeMs, data: out.buffer }, [out.buffer])
    } else {
      self.postMessage({ id, error: 'unknown op: ' + op })
    }
  } catch (err) {
    self.postMessage({ id, error: String(err) })
  }
}

const t0 = performance.now()
await initWasm()
self.postMessage({ type: 'ready', initMs: performance.now() - t0 })
