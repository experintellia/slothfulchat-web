# @slothfulchat/core-wasm

chatmail core compiled to WebAssembly, exposed through the standard
`@deltachat/jsonrpc-client` TypeScript API. Core runs in a Web Worker; the
page talks to it over a yerpc transport bridging postMessage — the exact seam
where deltachat-desktop's browser edition uses a WebSocket.

```ts
import { startCore } from '@slothfulchat/core-wasm'

const core = startCore()
const { dc, transport } = core
await dc.rpc.getSystemInfo()          // typed, generated from core
await transport.request('get_system_info') // raw JSON-RPC
dc.on('event', ({ contextId, event }) => ...) // core events
```

`startCore()` also returns an fs side channel into core's in-memory
filesystem (blob display, temp files, backup import/export):

```ts
await core.fsWrite('/tmp/a/b.bin', new Uint8Array([1, 2, 3])) // creates parent dirs
await core.fsExists('/tmp/a/b.bin') // -> true
await core.fsRead('/tmp/a/b.bin')   // -> Uint8Array, rejects if missing
await core.fsRemove('/tmp/a/b.bin') // file or directory tree
```

## Build (from repo root)

```sh
pnpm apply-patches                                # patched core in build/core
cd build/core/deltachat-jsonrpc/typescript
pnpm install --ignore-workspace && cargo test -p deltachat-jsonrpc \
  && node scripts/generate-constants.js && ./node_modules/.bin/tsc \
  && ./node_modules/.bin/esbuild --format=esm --bundle dist/deltachat.js --outfile=dist/deltachat.bundle.js
cd -                                              # generated TS client at the pinned commit
pnpm install
pnpm --filter @slothfulchat/core-wasm build:wasm  # needs clang + wasm32 target, ~10 min release
pnpm --filter @slothfulchat/core-wasm build
pnpm smoke                                        # headless verification
pnpm --filter @slothfulchat/core-wasm example     # http://localhost:8642/example/index.html
```

## Current limits (prototype)

- No networking yet (IMAP/SMTP/HTTP error at runtime) — M3 adds a WebSocket→TCP proxy.
- Storage is in-memory: everything is lost on reload (OPFS is M5).
- Backup import/export and blob-file writes are stubbed (M4).
- Always use release wasm builds; dev-profile wasm crashes the tab.
