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

Hosted demo: **<https://web.slothful.chat/demo/>** — the same page the
`example` script below serves locally. Pass `?proxy=ws://localhost:8641` to
enable networking (instructions on the page).

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

## Networking & persistence

- IMAP/SMTP/DNS tunnel through a WebSocket→TCP bridge: run
  [`@slothfulchat/ws-tcp-proxy`](https://www.npmjs.com/package/@slothfulchat/ws-tcp-proxy)
  and pass `startCore({ wsProxyUrl: 'ws://localhost:8641' })`. TLS terminates
  inside the wasm core — the bridge only ever relays ciphertext. Without a
  bridge, networking errors at runtime (everything else works).
- Storage (accounts, messages, blobs) persists in OPFS by default and survives
  reloads; pass `persist: false` for a fresh in-memory core.

## Current limits

- In-wasm HTTP is stubbed: https-URL `DCACCOUNT:` QR codes, provider
  autoconfig, OAuth2 and push don't work. Bare-domain `dcaccount:example.org`
  and classic email+password login work.
- One tab at a time: with persistence on, the core holds an exclusive lock on
  its OPFS storage, so a second tab of the same app fails to start its core
  until the first is closed.
- No sqlcipher; webxdc and iroh are descoped.
- Always use release wasm builds; dev-profile wasm crashes the tab.
