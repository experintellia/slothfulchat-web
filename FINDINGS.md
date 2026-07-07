# Findings log

The real deliverable of this prototype: per-milestone feasibility notes, patch count, and effort estimate for a proper hand-written implementation. See PLAN.md for milestone definitions.

## M0 — scaffolding
- Pins: core `446cdabd2` (2.54.0-dev), desktop `1b90817a6` (v2.53.1). Toolchain: rust stable + wasm32-unknown-unknown, wasm-pack, pnpm 11.10, node 24.
- Patch workflow (worktree + `git am` / `format-patch`) verified with 0 patches.

## M1 — wasm port (scoping notes)
- **SQLite solved upstream since planning**: rusqlite 0.40 (2026-05) has first-class wasm32-unknown-unknown support — `ffi-sqlite-wasm-rs` feature (default!) swaps libsqlite3-sys for sqlite-wasm-rs 0.5 on wasm. Patch = bump core's rusqlite 0.37→0.40 + enable that feature. VFS options: memory (default), OPFS sahpool (needs dedicated worker, no COOP/COEP), IndexedDB. sqlite-wasm-rs even has `sqlite3mc` cipher feature → browser DB encryption may be possible later (DESCOPED.md entry stands, but cheaper than thought).
- **Time seam exists**: `src/tools.rs` re-exports `SystemTime as Time` + `deltachat_time::SystemTimeTools as SystemTime` — one place to swap in `web-time` on wasm. `tokio::time` used in 19 files, `tokio::fs` in 30 → handle via Cargo package-rename: on wasm alias `tokio` to a facade crate (re-export working parts, wasm impls for time via `tokio_with_wasm`/`wasmtimer`, our memfs as `fs`).
- Small surfaces: `async_native_tls` 2 files, `hyper` 1 file (net/http.rs), `fd_lock` 1 file (accounts.rs), `spawn_blocking` 6 sites.

## M1 — porting log
- **Cargo gotcha**: a dependency name must have ONE source across build targets — you cannot alias `tokio` to a shim crate for wasm only. Solution: `crates/tokio-wasm-shim` is the `tokio` dep for BOTH targets; on native it's a transparent `pub use tokio::*` (feature `full`), on wasm it re-exports tokio's `sync`/`io`/macros and implements `time` (wasmtimer), `task` (spawn_local + JoinHandle/JoinSet, spawn_blocking runs inline), `fs` (in-memory), `net` (stubs that error at runtime), `runtime::Handle`.
- **iroh 0.35 compiles for wasm32 as-is** (relay-only transport) — no stubbing needed, reversing the plan's assumption. It stays compiled-but-unused; webxdc/backup-transfer remain descoped (DESCOPED.md). The tokio-`net` culprits were async-imap/fast-socks5/shadowsocks, not iroh.
- **async-imap fork**: its `runtime-tokio` feature enables `tokio/net` but the code never uses it (one doc example) — vendored copy in `vendor-crates/async-imap` with the feature line dropped, wired via `[patch.crates-io]`.
- **sqlite-wasm-rs builds SQLite's C with clang** — build-machine requirement: `apt install clang` (no `precompiled` feature in 0.5.5).
- rusqlite 0.37→0.40 bump: nearly API-compatible; one regression (`usize: ToSql` gone on 32-bit) fixed with an `as i64` cast in receive_imf.rs.
- Native-only code gated per-site: net/http.rs + net/proxy.rs get parallel `_wasm.rs` stub files selected via `#[cfg]`+`#[path]` in net.rs; tls.rs non-strict branch falls back to rustls (ring provider on wasm); accounts.rs reuses the existing iOS no-lockfile cfg; tools.rs/blob.rs ReadDirStream sites cfg'd (shim ReadDir implements Stream itself).
- **Runtime caveat found**: blob.rs `create_and_deduplicate` does blocking `std::fs` I/O inside `block_in_place` — compiles on wasm but `std::fs` errors at runtime there. Blob writes (attachments, avatars) need routing through the memfs sync API — M2/M4 work, not an M1 blocker (get_system_info doesn't touch it).
- **Runtime fix #1**: `Accounts::new` failed "Config is read-only" — `Config::sync()` requires the fd-lock task except on iOS; extended the cfg to wasm.
- **Runtime fix #2**: sync `Path::exists()` always returns false on wasm (std::fs unsupported) — added `tools::path_exists()` backed by the shim's `fs::sync_exists`; patched the 11 non-test call sites (accounts.rs, context.rs, tools.rs, imex.rs).
- **Dev-profile wasm (57 MB with debuginfo) crashes the Chromium tab** during instantiation — use `--release` (opt-level=s + LTO) for anything loaded in a browser.

### M1 VERDICT: PASSED (2026-07-06)
`get_system_info` answers from chatmail core running fully inside a Chromium tab: core v2.54.0-dev, SQLite 3.53.0 (wasm), arch 32. Verified by `node scripts/smoke-core-wasm.mjs` (headless playwright against `packages/core-wasm/example/`).

**Cost of the port so far — the feasibility number this prototype exists to produce:**
- **4 patches, 853 diff lines** on upstream core (stop/go gate was ~20 patches; we're at a fifth of that)
- 1 new facade crate (`crates/tokio-wasm-shim`, ~700 lines, reusable as-is)
- 1 vendored dep fork (async-imap, one feature line)
- 1 wasm-bindgen wrapper crate (~70 lines)
- Release wasm: 17 MB unoptimized-for-size (wasm-opt / brotli would shrink it further; dev builds crash the tab, always use --release)
- Build requirements: clang, rust stable + wasm32 target, wasm-pack

Remaining risk moved to M3 (networking through WS proxy at runtime — async-imap uses real tokio timers on wasm which panic; needs the shim treatment or wasmtimer feature unification) and blob writes via std::fs (M2/M4).

## M2 — npm package (2026-07-06): DONE
- `@slothfulchat/core-wasm`: core in a Web Worker, `WasmTransport extends yerpc.BaseTransport` over postMessage, `WasmDeltaChat extends BaseDeltaChat` — the standard client API works unchanged on top.
- Typed TS client is built from the in-tree `deltachat-jsonrpc/typescript` at the pinned commit (bindings generated by `cargo test`), so API always matches core. Wired as a `file:` dep into build/core — fresh clones must build it before `pnpm install` (README).
- Example page exposes `window.rpc` (raw) + `window.dc` (typed); smoke test asserts both.
- Gotcha: pnpm's `.bin` shim breaks when esbuild's postinstall swaps its JS launcher for the raw ELF — keep `allowBuilds: esbuild: false`.

## M3 — real networking (2026-07-06)

### M3 VERDICT: PASSED
Full e2e in a headless browser (`node scripts/test-networking.mjs`): two fresh accounts on nine.testrun.org configured **inside wasm** over IMAP/SMTP through the local WS→TCP proxy (`scripts/ws-tcp-proxy.mjs`, ~100 lines), TLS terminating in wasm (proxy sees ciphertext only), then an encrypted alice→bob message sent via SMTP, picked up by IMAP IDLE and delivered: `OK: two accounts configured over the WS tunnel; alice→bob message delivered`.

**Cost update: 7 patches, ~2100 patch lines total** (M3 added 3 patches / 477 insertions). Still well under the ~20-patch stop/go gate.

### Porting log
- **WS→TCP tunnel** (`src/net/ws_tcp.rs`, patch 0005): `ws_stream_wasm` gives a `!Send` JS WebSocket; bridged to core's `Send`-bounded `SessionStream` via `tokio::io::duplex` + `spawn_local` pump + oneshot — zero relaxation of core's trait bounds, async-imap/async-smtp code paths untouched. DNS goes through the proxy's `/dns/{host}` endpoint so the `SocketAddr`-based connect flow stays intact.
- **The wasm time minefield** (patches 0005/0006 + vendored forks): `std::time::{SystemTime,Instant}::now()` abort on wasm32-unknown-unknown, and they lurk in dependencies, surfacing one panic at a time at runtime:
  - rustls cert validation (`UnixTime::now()` in the handshake) → custom `TimeProvider` on the JS clock via `ClientConfig::builder_with_details`
  - core's `tools::Time::now()` call sites → wasm-safe `tools::time_now()`
  - `deltachat-ratelimit` → `deltachat_time::SystemTimeTools::now()`
  - rPGP keypair generation/signing → its `wasm` feature (web-time); chrono → `wasmbind` feature
  - async-imap IDLE timeout used real tokio's timer → vendored fork now uses `wasmtimer::tokio::timeout` on wasm
  - mail-builder MIME boundary + Date header → **new vendored fork** `vendor-crates/mail-builder` (0.4.4) using `web-time` on wasm
- **Chatmail relays mandate E2EE**: a bare `createContact(addr)` can't send ("requires end-to-end encryption which is not setup yet") — the test does the real key exchange via `makeVcard(bob)` → `importVcardContents(alice)`.
- Test-harness lesson: browser-side panics kill the worker and leave RPC promises pending forever — every in-page await needs an external watchdog (test has a 6-min one that also kills the proxy, or the output pipe stays open).
- Known deferred: `MuteDuration::try_into_core_type` still calls `SystemTime::now()` (panics only if a chat is muted with an `Until` duration — not on the e2e path); in-wasm HTTP (`read_url` etc.) still stubbed.

## M4 — standalone web app (2026-07-07)

### M4 VERDICT: PASSED — with ZERO desktop patches
The upstream deltachat-desktop browser-edition frontend (`bundle.js` byte-identical) runs on the wasm core. Three green playwright suites:
- `scripts/smoke-web-app.mjs` — app boots, zero-account UI renders, core answers RPC
- `scripts/test-web-app-e2e.mjs` — two accounts logged in through the real UI (manual email login), marker message sent via the composer, account switched via the sidebar (multiaccount ✓), message asserted in the recipient's DOM
- `scripts/test-web-app-imex.mjs` — settings → Export Backup → real browser download (1MB tar); reload (fresh core); welcome → Restore from Backup → file upload → account + message restored (IMEX ✓)

**Patch count: 8 core / 0 desktop.** The desktop needs none because of a lucky seam: `main.html` loads `runtime.js` (which sets `window.r`, the Runtime singleton) as a separate module before `bundle.js` — we ship our own `runtime.js` and reuse everything else as-is.

### Porting log
- `packages/web-app` = assemble script (copies upstream dist + locales, overlays our `main.html` copy with CSP loosened for wasm/workers + PWA manifest) + our Runtime (~fork of upstream's runtime-browser): transport → `WasmDeltaChat`, settings → localStorage, locales/themes → static fetches, temp files & file dialogs → core memfs via the fs side-channel, `/ws/backend` → no-op.
- **Blob display**: `transformBlobURL` is sync and feeds `<img src>`, so `/blobs/…` must be fetchable — a service worker intercepts it and round-trips to the page, which `fsRead`s the core worker's memfs. Same SW serves `/download-backup/…`.
- **Backup export**: the frontend passes destination `'<BROWSER>'` (upstream's node server rewrote it). Our runtime wraps the transport's `_send` and rewrites it to a memfs dir — 10 lines, bundle untouched.
- **Core-side IMEX** (patch 0008): tar streaming works on wasm via a vendored astral-tokio-tar whose tokio is our facade (memfs-backed); `Sql::import` on wasm swaps DB bytes in the VFS instead of `sqlcipher_export()` (encrypted backups stay unsupported on wasm).
- **Instant onboarding: partially works.** `DCACCOUNT:` has two forms (qr.rs:827-856): the bare-domain form (`dcaccount:nine.testrun.org`) needs NO HTTP — core generates random credentials locally and chatmail auto-creates the mailbox on first IMAP login → works on wasm. The https-URL form (`DCACCOUNT:https://…/new`, what real QR invites and the UI's "Create new profile" button use) POSTs via the HTTP module, which is still stubbed on wasm → fails. Classic addr+password login works. Also upstream quirk: `useInstantOnboarding` never resets after the first account, so the second add-account lands on the instant-onboarding screen.
- Key import/export UI was removed upstream in v2.53 — nothing to wire.
- PWA: manifest + service worker present (installable shape); no offline app-shell precache yet, Lighthouse not run.
- jsonrpc API drift core 2.54.0-dev vs frontend's 2.53.0 expectations: one additive event, zero breakage.

## M5 — persistent storage (2026-07-07)

### M5 VERDICT: PASSED — all milestones complete
`scripts/test-persistence.mjs`: UI login → message to self-chat → `page.reload()` → account and message still there with **no re-login**. All six earlier suites stay green (persistence is an init option, default ON in the web app, OFF for the fresh-core test harnesses).

**Final patch count: 9 core / 0 desktop.**

### Porting log
- **SQLite → OPFS**: the sahpool VFS lives in the companion crate `sqlite-wasm-vfs` 0.2 (not sqlite-wasm-rs itself). Installed as the default VFS at core init (`OpfsSAHPoolCfgBuilder`, capacity 32); DB bytes land in opaque pool files under `.opfs-sahpool/` — synchronous-durable via sync access handles, dedicated-worker requirement already met, no COOP/COEP needed.
- **Blob memfs → OPFS mirror** (shim `opfs.rs`): hydrate the memfs from OPFS `memfs/` at boot, then a dirty-path FIFO flusher write-through. No double storage: DB files never touch the memfs (rusqlite goes straight through the sahpool VFS).
- **Gotcha (patch 0009)**: the M4 backup-import byte swap was hardwired to the memory VFS — with sahpool as default it silently targeted the wrong VFS; now dispatches to whichever VFS is default.
- Limitations (prototype-acceptable): async blob flush can lose last-moment writes on tab close (DB itself is sync-durable); single tab only (sahpool handles are exclusive); removed accounts orphan their pool slot; fixed pool capacity 32.

## Prototype complete — feasibility answer
**YES.** A full DeltaChat client — networking, UI, multiaccount, backup IMEX, persistence — runs in a plain browser tab with:
- **9 patches (~2500 lines) on core, 0 patches on desktop**
- 1 reusable facade crate (tokio-wasm-shim: memfs + OPFS mirror, wasmtimer, spawn_local task shims)
- 3 vendored dep forks (async-imap, mail-builder, astral-tokio-tar — each a few lines, all time/tokio-fs related)
- 1 wasm wrapper crate + 1 runtime.js package (no upstream frontend changes thanks to the `window.r` seam)
- Requires: a ~100-line WS→TCP proxy (the one irreducible server piece — browsers cannot open TCP), clang + wasm-pack at build time
- Known holes for a hand-written redo to address: in-wasm HTTP stubbed — breaks the https-URL `DCACCOUNT:` form (real QR invites, the UI's "Create new profile" button), provider autoconfig, OAuth2, push, HTTP-fallback transport; bare-domain `dcaccount:example.org` and classic login work without HTTP. Cheap fix: route HTTP via `fetch()` or the existing WS proxy. Also: no sqlcipher, single tab, webxdc/iroh descoped (see DESCOPED.md).

## Post-M5 polish (2026-07-07)

User-facing cleanup after the feasibility verdict; the "0 desktop patches" count
above was true at M5 and is now historical:

- **First desktop patch** (`patches/desktop/0001`): About dialog gets a "what
  this is" blurb (unofficial experiment, chatmail core in WASM, ported with an
  AI coding agent, not affiliated with Delta Chat) and the **unimplemented
  proxy UI is removed** (Settings → Advanced button, instant-onboarding 3-dot
  menu) — DeltaChat's SOCKS5/Shadowsocks proxy feature is not wired in wasm, so
  it was dead UI. `bundle.js` is no longer byte-identical upstream.
  Patch count now: **9 core / 1 desktop.**
- **Bridge-down notice** (`runtime.ts`, no patch): probes the WS bridge's
  `/dns/` endpoint on load + every 30s; when unreachable shows a warning toast →
  dialog with start instructions and an alternative-bridge input (saved by
  reloading with `?proxy=`). Before this, a missing bridge surfaced only as
  opaque IMAP connect errors.
- **Bridge is now a package**: `scripts/ws-tcp-proxy.mjs` →
  [`packages/ws-tcp-proxy`](packages/ws-tcp-proxy/README.md) (still one
  inspectable file, now with a `bin` for `npx @slothfulchat/ws-tcp-proxy`).
  New optional `CHATMAIL_WHITELIST` env for hosting a public bridge restricted
  to vetted chatmail servers: DNS always resolves, but only IPs resolved for a
  whitelisted domain enter a 10-min in-memory allow-list, and TCP tunnels to
  any other IP are refused (4003). Empty env = allow-all (local-dev default).
  Self-check: `scripts/test-ws-tcp-proxy-whitelist.mjs`. Known ceiling: trusts
  the whitelisted domain's DNS answer (SSRF if its resolver lies); upgrade path
  is pinning IPs.

All suites re-verified green after the changes (smoke-web-app, test-networking
e2e message roundtrip, whitelist self-check).

## Post-M5 polish 2 (2026-07-07): PWA install + bridge configurability

- **PWA installable**: manifest now declares real 256/512px icons (reused from
  upstream's tauri icon set, copied by `assemble.mjs`). Install requires a
  secure context — `http://localhost` or any `https://` host (GitHub Pages
  works); plain-http LAN IPs don't get the prompt.
- **Bridge URL is persistent**: the bridge dialog saves to the
  `slothfulchat.proxyUrl` localStorage key (an installed PWA launches without
  query params, so `?proxy=` alone wasn't enough); `?proxy=` still wins when
  present (test harnesses). Empty input resets to the default.
- **Desktop patch 0002**: Connectivity view (Settings → Connectivity) shows
  which bridge is in use + a "Change…" button opening the bridge dialog, via a
  `window.__slothfulchatBridge` hook set by runtime.js (browser-target-gated,
  renders nothing elsewhere). Patch count: **9 core / 2 desktop.**
- **Desktop patch 0003**: welcome screen replaces the Delta Chat logo with
  "SlothfulChat", a one-sentence experimental/may-be-buggy disclaimer, and a
  source-code link. Patch count: **9 core / 3 desktop.**
