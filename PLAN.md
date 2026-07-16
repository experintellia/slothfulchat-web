# DeltaChat PWA prototype — feasibility plan

## Context

Goal: a **minimal-changes prototype** of a DeltaChat client running fully in the browser (PWA, maybe browser extension later), to judge whether it's worth implementing properly by hand. **No upstream contribution** — private patch stack only. Upstream itself says this is the desired future direction (blog post 2025-05-22) but nobody is working on it publicly.

Deliverables:
1. **npm package** (`@slothfulchat/core-wasm`): WASM-compiled chatmail core exposing the existing TypeScript JSON-RPC API, with a browser example that prints `get_system_info` and exposes raw RPC on `window`.
2. **Web app**: standalone build of deltachat-desktop's browser-edition frontend using that package instead of the WebSocket server.

## Feasibility verdict (from research)

| Aspect | Status |
|---|---|
| rPGP crypto, message parsing, jsonrpc layer (yerpc — transport-agnostic) | works on wasm already |
| iroh (webxdc realtime, backup transfer) | **stubbed out on wasm** — browser iroh is relay-only (no LAN discovery), backup transfer is LAN-restricted so it wouldn't work anyway; stubbing shrinks/speeds the build. See Postponed. |
| SQLite (`rusqlite` + `bundled-sqlcipher-vendored-openssl`) | patch: swap to [sqlite-wasm-rs](https://github.com/Spxg/sqlite-wasm-rs)-backed libsqlite3-sys, **drop sqlcipher on wasm** |
| tokio (`rt-multi-thread`, `fs`, `time` panics on wasm) | patch: current-thread rt driven by wasm-bindgen-futures, `wasmtimer` shim, fs shim |
| Blob/file storage (core writes blobs as files) | patch: in-memory FS shim first, OPFS later |
| TLS (`aws-lc-rs` provider, vendored OpenSSL) | patch: rustls `ring` provider; drop `async-native-tls` on wasm |
| IMAP/SMTP (no raw TCP in browsers) | needs a tiny WebSocket→TCP proxy; `async-imap`/`async-smtp` are generic over any `AsyncRead+AsyncWrite` stream — clean injection point in core's `src/net` |
| DNS (`tokio::net::lookup_host`) | stub on wasm — proxy resolves names |
| shadowsocks/socks5, hyper HTTP | feature-gate out / stub on wasm |

Upstream desktop facts that shape the design:
- `@deltachat/jsonrpc-client` (chatmail/core `deltachat-jsonrpc/typescript`): generated `RawClient` + `BaseDeltaChat<Transport extends BaseTransport>` — **transport is pluggable**, so a WASM-backed transport slots in where `WebsocketTransport` sits today.
- `deltachat_jsonrpc::api::CommandApi` (Rust) is the same seam server-side: expose it via wasm-bindgen instead of stdio.
- Frontend (`packages/frontend`) is platform-agnostic behind the `Runtime` interface (`packages/runtime/runtime.ts`); `target-browser/runtime-browser/runtime.ts` is the fork base. Its Express server endpoints (`/blobs/...`, `/backend-api`, `/ws/backend`, themes/locales) must become in-browser shims.
- Build is tsc + esbuild + sass → static `html-dist`; no vite/webpack.

## Key decisions (defaults chosen; flag if you disagree)

1. **Core runs in a Web Worker**, not the main thread (SQLite calls are sync; OPFS sync access handles require a worker anyway). Transport = postMessage.
2. **Networking is phased**: `get_system_info` needs zero networking, so M1 stubs all net. Real IMAP/SMTP comes in M3 via a ~100-line local Node WS→TCP proxy; TLS (rustls/ring) still terminates at the mail server inside wasm, so the proxy only ever sees ciphertext.
3. **No DB encryption in browser build** (sqlcipher/OpenSSL won't build; OPFS is origin-sandboxed anyway).
4. **Storage memory-first, persistent later**: DB via sqlite-wasm-rs (its OPFS VFS if it drops in early, else memory), blobs in-memory FS shim. **Persistent storage (OPFS) is wanted and planned as M5** — just not required for the first build.
5. **In scope** (beyond basic chat): **multiaccount** (core is account-manager based — nearly free) and **file-based IMEX** (backup export/import + key import/export via `<input type=file>` upload and blob-URL download; needs the FS shim to hold the backup file). **Descoped**: webxdc, HTML email, sqlcipher, iroh backup *transfer* (QR/LAN). (Stickers are now supported — static and animated Lottie/`.tgs` rendering, plus the composer sticker picker; see FINDINGS. **Calls** — native 1:1 WebRTC audio/video — are no longer descoped; see [`docs/calls.md`](docs/calls.md) for the design and milestone plan.) Descope list is documented in `DESCOPED.md` in the repo, each entry with reason + what re-enabling would take.
6. **Iroh stubbed on wasm** (feature-gate/stub crate): browser iroh only speaks via WS relays — no LAN node connectivity — so DC's LAN-restricted backup transfer can't work; webxdc isn't in the browser edition anyway. Postponed, not rejected.
7. Licenses: core MPL-2.0, desktop GPL-3.0 — fine for a private prototype; web app is GPL-3 if ever distributed.

## Repo layout (this repo, `/home/dev/work/slothfulchat-web`)

```
vendor/core/                  # submodule, pinned upstream chatmail/core
vendor/deltachat-desktop/     # submodule, pinned upstream
patches/core/NNNN-*.patch     # stacked git patches (git format-patch style)
patches/desktop/NNNN-*.patch
scripts/apply-patches.sh      # git worktree from pinned commit + git am → build/core, build/desktop
scripts/update-patches.sh     # regenerate patches from the build worktree after editing
packages/core-wasm/           # deliverable 1: wasm artifact + TS wrapper + example/
packages/web-app/             # deliverable 2
```

Patched code lives in throwaway `build/` worktrees; `patches/` + submodule pins are the source of truth. New code (wasm-bindgen wrapper crate, TS transport, runtime shims) lives in *our* packages, not patches — patches only touch what must change inside upstream trees.

## Milestones (each is a stop/go checkpoint)

### M0 — scaffolding
Submodules, patch scripts (0 patches applied cleanly), pnpm workspace, `cargo build` of unpatched core natively as sanity check. Rust toolchain + `wasm-pack`/`wasm-bindgen` setup. **Commit this plan as `PLAN.md`** plus empty `DESCOPED.md` / `FINDINGS.md` into the repo.

### M1 — core compiles to wasm32, `get_system_info` answers (THE feasibility gate)
Patches to `vendor/core` (all `#[cfg(target_arch = "wasm32")]`-gated or Cargo feature `wasm`):
- Cargo.toml: drop `vendored`/sqlcipher on wasm, sqlite via sqlite-wasm-rs-compatible `libsqlite3-sys`; tokio features `rt,sync,macros,io-util`; rustls provider `ring`; gate out `shadowsocks`, `fast-socks5`, `async-native-tls`, `hyper`; `getrandom` `wasm_js`.
- Time: route `tokio::time` uses through `wasmtimer` (core has a tools/time module — check for an existing seam).
- FS: shim `tokio::fs` calls behind a small internal module → in-memory FS on wasm.
- Net: stub `src/net` connection establishment + DNS on wasm (return "unsupported" errors).
- Iroh: feature-gate/stub `iroh` + `iroh-gossip` on wasm (webxdc realtime + backup transfer return "unsupported") — cuts a large dependency tree from the build.
New crate `packages/core-wasm/rust/` (ours, not a patch): wasm-bindgen wrapper over `deltachat_jsonrpc::api::CommandApi` — `init() -> DcWasm`, `.request(json: string): Promise<string>`, `.onEvent(cb)`.
**Verify:** static page loads the wasm in a worker, browser console `await rpc.request(...get_system_info...)` returns real version info.
**Stop/go:** if the patch stack balloons (order of magnitude: >20 patches or invasive rewrites of core internals), the answer to "minimal changes" is no — write up findings and stop.

### M2 — npm package + example (deliverable 1)
`packages/core-wasm`: worker bootstrap, `WasmTransport implements BaseTransport` (yerpc) bridging postMessage, re-export `BaseDeltaChat`/`RawClient`/types from `@deltachat/jsonrpc-client` (reused, unpatched). Example page (`example/`): instructions text, `window.rpc` (raw request fn) + `window.dc` (typed client), logs `get_system_info` result.
**Verify:** `pnpm build && pnpm --filter core-wasm example` → console flow works as specified.
**Automated:** one playwright smoke test — load the example page headless, assert `get_system_info` resolves with a version string (wasm-bindgen `web` target needs a browser; playwright is simpler than a node-target second build).

### M3 — real networking
- `scripts/ws-tcp-proxy.mjs`: Node, `ws` + `net`, path-encoded target (`/tcp/{host}/{port}`), allowlist of ports 993/465/587. Local dev only.
- Core patch: wasm connection path builds a WebSocket-backed `AsyncRead+AsyncWrite` (`ws_stream_wasm`) → rustls(ring) on top → hand to existing async-imap/async-smtp session code. Proxy URL via config/env at init.
**Verify:** create account on a chatmail relay from the browser, exchange messages with a real Delta Chat client.

### M4 — web app (deliverable 2)
Patches to `vendor/deltachat-desktop` kept thin: build `packages/frontend` → `html-dist` as-is. New `packages/web-app` (ours): fork of `target-browser/runtime-browser/runtime.ts` where:
- `BrowserTransport` → `WasmTransport` from `@slothfulchat/core-wasm`.
- `transformBlobURL()` → blob:/OPFS URLs served from the in-browser FS (service worker or object URLs).
- `/backend-api` settings → localStorage; `/ws/backend` events → in-page emitter; themes/locales bundled statically.
- **Multiaccount**: works through the account-manager API as on desktop — verify the account switcher UI functions.
- **IMEX**: backup export → write into shim FS → download as blob URL; backup import / key import → `<input type=file>` → write into shim FS → pass path to core IMEX API.
- PWA manifest + minimal service worker (offline app shell only).
**Verify:** full login → chat list → send/receive flow in a plain browser tab; Lighthouse says installable.
**Automated:** playwright tests for the most common flows — app loads, create/login account (against local chatmail test relay), send + receive a message, switch accounts, backup export/import round-trip. Base them on upstream's `packages/e2e-tests` (already playwright against the browser target) — adapt, don't rewrite.

### M5 — persistent storage
DB on sqlite-wasm-rs OPFS VFS (worker requirement already met); blob FS shim backed by OPFS instead of memory; survive reload with accounts + messages intact.
**Verify:** playwright test — create account, send message, reload page, message still there.

## Postponed (documented in DESCOPED.md, not rejected)
- **iroh**: webxdc realtime + P2P backup transfer. Browser iroh (0.32+) works relay-only — no LAN node connectivity — so DC's LAN-restricted backup transfer can't function; revisit if upstream lifts the LAN restriction or webxdc lands in the browser edition. File-based IMEX covers backup needs meanwhile.
- webxdc, HTML email (also missing in upstream's browser edition). Stickers — including animated Lottie/`.tgs` — render and send, and the composer sticker picker works. Video calls were previously descoped here; they are now in progress under [`docs/calls.md`](docs/calls.md) (own `packages/calls` + a thin desktop patch), not this PLAN's milestone track.
- sqlcipher / DB encryption in browser.

## Verification (overall)
Each milestone has a runnable check above. End-to-end: M3/M4 verified against a real chatmail relay with a second client. Keep a `FINDINGS.md` log per milestone — the actual deliverable of this prototype is the feasibility answer, patch count, and effort estimate for the hand-written redo.

## Risks
- **M1 is the unknown**: tokio-time/fs usage is pervasive in core; "a lot of refactoring" per upstream. Mitigated by the stop/go gate.
- sqlite-wasm-rs ↔ rusqlite linkage may need a `[patch.crates-io]` on `libsqlite3-sys` (rusqlite wasm PRs #935/#1010 unmerged).
- Single-threaded wasm: any hidden `spawn_blocking`/thread usage in core panics — will surface at M1 runtime.
- Providers may dislike IMAP-via-proxy traffic; use chatmail relays for testing, not Gmail.
