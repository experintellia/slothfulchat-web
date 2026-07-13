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
- PWA: manifest + service worker present (installable shape); offline app-shell added 2026-07-08 (see "Offline app shell" section below).
- jsonrpc API drift core 2.54.0-dev vs frontend's 2.53.0 expectations: one additive event, zero breakage.

## M5 — persistent storage (2026-07-07)

### M5 VERDICT: PASSED — all milestones complete
`scripts/test-persistence.mjs`: UI login → message to self-chat → `page.reload()` → account and message still there with **no re-login**. All six earlier suites stay green (persistence is an init option, default ON in the web app, OFF for the fresh-core test harnesses).

**Final patch count: 9 core / 0 desktop.**

### Porting log
- **SQLite → OPFS**: the sahpool VFS lives in the companion crate `sqlite-wasm-vfs` 0.2 (not sqlite-wasm-rs itself). Installed as the default VFS at core init (`OpfsSAHPoolCfgBuilder`, capacity 32); DB bytes land in opaque pool files under `.opfs-sahpool/` — synchronous-durable via sync access handles, dedicated-worker requirement already met, no COOP/COEP needed.
- **Blob memfs → OPFS mirror** (shim `opfs.rs`): hydrate the memfs from OPFS `memfs/` at boot, then a dirty-path FIFO flusher write-through. No double storage: DB files never touch the memfs (rusqlite goes straight through the sahpool VFS).
- **Gotcha (patch 0009)**: the M4 backup-import byte swap was hardwired to the memory VFS — with sahpool as default it silently targeted the wrong VFS; now dispatches to whichever VFS is default.
- Limitations (prototype-acceptable): async blob flush can lose last-moment writes on tab close (DB itself is sync-durable); single tab only (sahpool handles are exclusive); ~~removed accounts orphan their pool slot; fixed pool capacity 32~~ (FIXED, see below).

### Pool-slot leak fixed (2026-07-12): post-#75 boot CANTOPEN

The M5 "removed accounts orphan their pool slot" + "fixed pool capacity 32"
limitations combined into a production brick: `remove_account` removed only the
memfs keys, never the account's sqlite files (they live solely in the sahpool
VFS), so every removed account permanently burned a pool slot. Enough churn
filled the fixed 32-slot pool; the next `Accounts::new` failed
`unable to open database file` (SQLITE_CANTOPEN, err 14) at boot — and the
self-heal made it worse, quarantining a VALID accounts.toml and rebuilding it
identically (a boot loop). Three-part fix (opfs.rs/fs.rs/lib.rs): (1) the memfs
removal paths now `delete_db` the pool files under the removed subtree
(`purge_pool_files_under`); (2) `enable_persistence` sweeps orphaned pool files
at boot (any pool file whose parent dir is absent from the hydrated memfs) and
reserves capacity `max(32, 2N+8)` for N account dirs — the sweep un-bricks
already-exhausted deployments; (3) the self-heal is gated on the config actually
being implausible (`config_is_plausible`), so a storage failure no longer
triggers a quarantine loop.

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

## Live-site bug pass (2026-07-07): CSP, blobs, camera, connectivity

- **CSP `manifest-src`**: `default-src 'none'` blocked `manifest.webmanifest`
  (no explicit `manifest-src` → fallback). Added `manifest-src 'self'` to the
  meta CSP in `packages/web-app/static/main.html` (GitHub Pages can't set
  headers, so the meta tag is the single source of truth).
- **Temp-file blobs render**: `transformBlobURL` only matched
  `…/dc.db-blobs/…`; core memfs temp paths (`/tmp/<uuid>/<file>` from
  `tmpPath()`: draft attachments, file-picker uploads) returned `''` → broken
  previews. Now mapped to `blob-path/<uri-encoded path>`; the blobs SW decodes
  it and reuses the existing `path` passthrough (page side unchanged). No new
  read surface — same-origin JS could already `fsRead` any memfs path.
- **Camera permission**: `askForMediaAccess('camera')` was "not implemented",
  breaking the QR scanner; now primes `getUserMedia({video:true})` same as the
  microphone branch.
- **Connectivity "Change…" button dead on live**: reproduced — the click DID
  open the bridge dialog, but the old div overlay painted under the
  connectivity `<dialog>`'s top layer (invisible at any z-index). Already
  fixed by the native `<dialog>`+`showModal()` rewrite, which was committed
  but never pushed; shipping it in this deploy.
- **White connectivity iframe**: NOT reproduced (core `getConnectivityHtml`
  healthy in unconfigured/configured/io-running/bridge-down; CSP doesn't block
  srcdoc iframes; renders fine on local and live with a fresh account).
  Standing hypothesis: `get_connectivity_html` blocks on
  `scheduler.inner.read().await` while `stop()`/`pause()` hold the write lock
  across task-shutdown awaits — a wedged wasm network future would hang the
  RPC forever → srcDoc stays `''` → white. Revisit with a repro; candidate
  band-aid is a timeout+fallback in the patched ConnectivityDialog.
- **Chrome Local Network Access (138+)**: an https page (the live site) needs
  the LNA permission to reach `ws://localhost:8641`; denied/headless contexts
  get `net::ERR_BLOCKED_BY_LOCAL_NETWORK_ACCESS_CHECKS` and configure fails
  with an opaque "Could not find your mail server". Users must accept the
  prompt; headless tests need `--disable-features=LocalNetworkAccessChecks`.
  Worth mentioning in the bridge-down toast/dialog text eventually.

## Webxdc surface + connectivity polish (2026-07-07)

- **Webxdc icons render**: `getWebxdcIconURL` → `webxdc-icon/:acc/:msgId`,
  served by the blobs SW via `get_webxdc_info` + `get_webxdc_blob` (icon
  lives inside the .xdc archive, not the memfs). Verified e2e: maps.xdc sent
  through the picker renders its 256px icon.
- **Webxdc start = honest dialog**: `openWebxdc` opens a native
  `<dialog>` ("not implemented (yet) in this browser edition") linking
  issue #2 (separate-origin sandboxed host design). Running apps stays
  descoped — the icon/dialog work is UI surface only.
- **Desktop patch 0007**: connectivity view shows a centered "Loading…"
  instead of a blank iframe while `getConnectivityHtml` is pending — on a
  busy single-threaded wasm core the RPC can take a while, and an empty
  srcDoc iframe paints as a white box (the reported "white connectivity
  view"). Patch count: **9 core / 7 desktop.**

## Offline app shell (2026-07-08): the PWA works offline now

- **blobs-sw.js doubles as the app-shell SW**: everything not matched by the
  blob routes is served cache-first with a background refresh
  (stale-while-revalidate — at worst one deploy behind, and GH Pages 304s make
  the revalidation cheap). `assemble.mjs` emits `sw-precache.js` (every dist
  file minus sourcemaps/demo, ~46 MB, dominated by the wasm) which the SW
  precaches on install, so the app boots offline after a single online visit.
  `cache.match` runs with `ignoreSearch: true` — the site is fully static but
  requests carry query params (`main.html?proxy=…`, `core/worker.js?proxy=…`)
  that would otherwise miss the cache. Uncached+offline yields a synthetic 404
  (the app already handles 404s, e.g. `locales/en-US.json` → `en.json`
  fallback); offline navigations fall back to the cached `main.html`.
- **Head/manifest polish**: `theme-color` meta, apple-touch-icon +
  `*-web-app-capable` metas in `main.html`; own sloth icon (favicon, manifest
  256/512, `purpose: maskable`, notification fallback) rendered from
  `static/images/icon-source.png` by `scripts/make-icons.mjs` — rerun it when
  the source icon changes.
- **Installability**: Chrome's `Page.getInstallabilityErrors` (CDP) returns
  empty — asserted in the new suite. Lighthouse itself dropped its PWA
  category in v12 (2024), so "Lighthouse says installable" is superseded by
  this CDP check, which is the signal Chrome actually uses.
- **New suite `scripts/test-pwa-offline.mjs`**: online visit → SW precaches →
  installability check → server KILLED (playwright's `setOffline` doesn't
  apply to SWs) → cold navigation boots the full app, wasm core included,
  from the SW cache. 5/5 green; smoke-web-app + test-persistence still green.
- **Known issue — instant-reload OPFS race (pre-existing, now visible)**: an
  immediate reload can start the new core worker before the old worker's OPFS
  sync-access-handles are released → `install_sahpool` fails, and a FAILED
  install cannot be retried (it leaks its own partial handles; the retry
  HANGS — as does `createSyncAccessHandle` itself while the old worker is
  mid-teardown, it never rejects). Network reloads usually win this race by
  being slow, which is why test-persistence never tripped it; a SW-cache
  reload is fast enough to lose it often. Mitigation in `worker.ts`:
  pre-init probe waits (with timeout race) until all `.opfs-sahpool` files
  are acquirable. Terminating the old worker on `pagehide` made things WORSE
  (terminate mid-OPFS-op seems to wedge the lock) — tried and reverted. A
  real fix likely needs sahpool-crate-level cleanup-on-failed-install.
  Even with the mitigation, `test-pwa-offline.mjs` still hangs ~1 run in 3 on
  a loaded box (SW cache verified complete in failing runs — only the expected
  `en-US.json` 404; no "OPFS locked" retry warnings either, so it's the
  unretryable failed-install hang, not the probe path).

### Follow-up (same day): content-hashed precache — deploys stop re-downloading the world

- **Why**: GitHub Pages sends a fixed `cache-control: max-age=600` and
  nginx-style `hex(mtime)-hex(size)` ETags, and the Pages artifact stamps
  every file with the deploy time — so every deploy regenerates every ETag
  and the SWR background refresh re-downloaded each used asset in full
  (~35 MB with font + wasm) per deploy, even byte-identical ones.
- **Now**: `sw-manifest.mjs` (runs at the end of `pnpm build`, since it must
  hash runtime.js) emits `sw-precache.js` as `{path: sha1-16}` plus a
  whole-manifest version. The SW cache is named by that version; install
  copies unchanged-hash entries forward from the previous cache (zero
  network) and fetches only changed files with `cache: 'no-cache'` — a
  deploy landing inside the max-age window would otherwise install a
  stale-but-"fresh" HTTP-cache copy. Precached files are served cache-only
  (no per-request refresh), so updates land per-deploy as a set, closing the
  per-file version-skew window SWR had (e.g. new wasm-bindgen glue + old
  .wasm). Registration uses `updateViaCache: 'none'` — the default
  ('imports') lets update checks read a still-fresh OLD sw-precache.js from
  the HTTP cache for up to 10 min. Install failures don't brick the install
  (allSettled, self-heal on next update) and are recorded in a
  `__sw-install-errors__` cache entry instead of vanishing.
- **Measured**: a fake deploy re-fetches exactly blobs-sw.js + sw-precache.js
  + the one changed file; the 10 MB emoji font makes zero requests.
- **New suite `scripts/test-pwa-update.mjs`** (SW-only, no wasm boot — fast
  and immune to the OPFS race): serves a dist copy with Pages-like headers
  (max-age=600, mtime validators, 304s), fakes a deploy, and asserts the
  classic fail points: stale-HTTP-cache poisoning, unchanged-file re-download,
  a manifest file 404ing mid-install (tolerated + recorded), old-cache
  cleanup after activate, and offline integrity after the update. 3/3 green.
- **Playwright trap** (cost an evening): `page.waitForFunction(async () =>
  …, null, {polling: N})` does NOT await async predicates — the returned
  Promise object is truthy and the wait passes instantly. Poll from node via
  `page.evaluate` instead (see `until()` in test-pwa-update.mjs).
- **Bonus findings while investigating**: upstream `fonts.css` declares the
  same 10.35 MB NotoColorEmoji.ttf under two `@font-face` families
  ("NotoEmoji" + "EmojiMart"); Firefox fetches once per activated face
  (Chromium dedupes by URL), i.e. 2× full downloads on a production cold
  load — reproduced live. `assemble.mjs` now strips the redundant NotoEmoji
  face (exact-string replace; no-ops if upstream changes the block). And
  `serve.mjs` sent no validators at all, making everything uncacheable
  locally — it now sends Last-Modified + `no-cache` and answers 304s.

## SW regression (2026-07-08): cached responses strip worker query params

- **Symptom**: with the offline app shell deployed, every connection attempt
  spammed `no WebSocket proxy configured — call set_ws_proxy_url() first`
  even with the bridge running — but only after a reload, and never in the
  test suites.
- **Root cause**: the core worker's config rode on its script URL
  (`core/worker.js?proxy=…&persist=…`, read back via `import.meta.url`).
  For module scripts/workers, `import.meta.url` is the **response** URL, and
  a Cache-API response was stored under the bare path — no query string. So
  once the app-shell SW controls the page and serves the precached worker
  (via `cache.match(…, {ignoreSearch: true})`), the worker boots with no
  params: no proxy, and `?persist=0` silently ignored too. Suites stayed
  green because they start the core on a fresh profile before the SW's first
  install finishes; real usage hits the SW path on every reload.
- **Fix**: config now goes over `postMessage` — `startCore` sends a one-shot
  `{type: 'config', proxyUrl, persist}` right after `new Worker(…)` (messages
  queue until the worker module evaluates, so no race) and the worker awaits
  it before `init`. core-wasm 0.2.0; never pass config via script-URL params
  under a caching SW.
- **Regression coverage**: `smoke-web-app.mjs` grew an SW-controlled-reload
  phase: reload after `serviceWorker.ready`, then configure against a dead
  host via `window.exp.rpc` — through a live proxy that fails with a DNS
  error, on a config-less worker with the exact "no WebSocket proxy
  configured" line (verified red on the broken build, green after the fix).

## webimap transport (2026-07-08): madmail HTTP mail access, first bridge-free transport

Added [madmail](https://github.com/themadorg/madmail)'s
[WebIMAP/WebSMTP](https://github.com/themadorg/madmail/blob/main/docs/TDD/10-webimap.md)
as a transport variant next to IMAP/SMTP — the first transport that needs **no
WS→TCP bridge**: mail flows over plain HTTPS `fetch()` from the worker
(building on core patch 0010's fetch client, which landed independently).
Activated by a `webimap: bool` on the login params (advanced toggle in the
login form), the `webimapaccount:host[:port]` QR scheme (instant onboarding via
`POST /new`), or the welcome-screen madmail dialog. Patch count: **11 core /
11 desktop.**

- **Core patch 0011** — the transport (`src/webimap.rs`). Receive is a REST
  long-poll loop (`GET /webimap/messages?wait=60` *is* the idle — no WebSocket
  in v1), each new uid fetched raw → `receive_imf` → `DELETE` (a failed DELETE
  errors the round so the 30s backoff engages instead of hot-looping). Send
  branches in `smtp_send` (single choke point: messages, MDNs, sync) to
  `POST /webimap/send`. Configure skips the IMAP+SMTP connect verify in favor
  of an authenticated `GET /webimap/mailboxes`. The scheduler reuses the whole
  `ImapConnectionState`/SchedBox plumbing — the only branch is which loop gets
  spawned — so interrupts, stop and the connectivity view work unchanged.
  Extends patch 0010's `request()` with a timeout (native `tokio::time::timeout`,
  wasm AbortController + wasmtimer race) and `follow_redirects` (webimap passes
  RequestRedirect::Error so X-Email/X-Password never follow a redirect).
- **QR host validation**: `webimapaccount:` payloads are parsed with `url::Url`
  and reject userinfo/path/query/fragment (an attacker-suppliable scheme must
  not allow `trusted.org@evil.com`); canonical `host[:port]` stored, bracketed
  IPv6 supported.
- **Ponytail shortcuts** (marked in code): no uid persistence — restart
  re-polls from `since_uid=0` and `receive_imf`'s Message-ID dedup eats the
  duplicates (server-side delete-after-fetch keeps INBOX small); plain-http is
  allowed for localhost/`[::1]` only so the e2e mock needs no TLS.
- **Gotcha found during design**: `send_msg_to_smtp` pre-connects SMTP *before*
  `smtp_send` ever runs — branching only in `smtp_send` would have webimap
  sends die on a TCP connect to a nonexistent SMTP server. Fixed at the choke
  point: `Smtp::connect_configured()` early-returns for webimap, covering all
  callers.
- **Bridge notice is now account-aware** (runtime.ts): webimap-only account →
  no probe/warning; mixed with webimap primary → silent probe, "⚠ not
  reachable" shown in the Connectivity dialog instead of the toast (core sends
  only via the primary transport, so a webimap primary keeps working);
  bridge-primary or unconfigured → intrusive toast as before.
- **e2e**: `scripts/test-webimap.mjs` — fully offline: an in-process mock
  madmail server (long-poll, CORS preflights for the `X-Email`/`X-Password`
  headers are load-bearing) + two wasm accounts exchanging encrypted mail with
  **no bridge running**; asserts delete-after-receive.
- Multi-device caveat: `send_sync_transports` now carries the `webimap` field;
  an older core receiving the sync drops the unknown JSON field and would treat
  the transport as IMAP.

## iOS storage-corruption incident (2026-07-08): corrupted accounts.toml bricked the app

Field report from an iOS device with one account: the app never got past the
loading screen, console showed `Unhandled Promise Rejection: failed to create
accounts: invalid utf-8 sequence of 1 bytes from index 1031620` (worker.js).
Traced to core's bare `std::str::from_utf8` on `/accounts/accounts.toml`
(`vendor/core/src/accounts.rs:753`) — the OPFS mirror handed back **~1 MB of
binary garbage** for a file that is normally <300 bytes. Core's own write is
atomic (tmp + rename) and the mirror flusher is strictly sequential, so the
prime suspect is WebKit's `FileSystemWritableFileStream` (`createWritable()`),
which only shipped in Safari 18.4 (WebKit bug 283841) and was the one OPFS
write API in our pipeline that sahpool does *not* also exercise. Three fixes:

- **Self-heal** (`packages/core-wasm/rust/src/lib.rs`): if `Accounts::new`
  fails and accounts.toml exists, dump the corrupt bytes to the console (size,
  hex head, lossy 4 KiB preview), quarantine to `accounts.toml.broken` (kept
  in OPFS for forensics) and rebuild the config from the account dirs — dir
  name == account uuid, ids reassigned from 1; the sqlite DBs live in the
  sahpool VFS and are untouched, so the account comes back fully intact.
- **Mirror writes via sync access handles** (`tokio-wasm-shim/src/opfs.rs`):
  `reconcile` now uses `FileSystemSyncAccessHandle` (write at 0 → truncate to
  new length → flush → close; no empty-file window) instead of
  `createWritable()` — the same API sahpool already trusts on these devices,
  and supported since Safari 15.2 instead of 18.4.
- **No more silent brick** (`worker.ts` + `runtime.ts`): any init failure now
  posts `fatal-init-error` and shows the fatal dialog with the error text
  instead of dying as an unhandled rejection behind the loading screen.

e2e: `scripts/test-persistence.mjs` step 7 overwrites the OPFS accounts.toml
with 2 MiB of `0xff`, reloads, and asserts the account is healed and the
quarantine file exists.

## Feature — animated Lottie / Telegram `.tgs` stickers (2026-07-10)

Reference: ArcaneChat's Android client (`glide/lottie/LottieDecoder.java`)
bundles the airbnb Lottie library and decodes `.tgs` → `LottieComposition` →
animated drawable in the sticker slot. Chatmail core never renders stickers, so
the web edition needs the same two halves: core *classifies* the file, the app
*plays* it.

- **Core (2 changed lines, `patches/core`)**: `guess_msgtype_from_path_suffix`
  mapped `tgs` → `Viewtype::File`; changed to `Viewtype::Sticker` so a `.tgs`
  attachment lands in the sticker slot (and a `.tgs` you send via the file
  picker is classified as a sticker, emitting `Chat-Content: sticker`).
  `mimeparser::parse_attachments` only honored a `Chat-Content: sticker` header
  on parts already typed `Image`/`Gif`, which dropped animated stickers;
  removed that precondition so an explicitly-tagged sticker is honored whatever
  its detected type. Mirrors ArcaneChat's core changes (they also blanket-map
  `webp` → `Sticker`; we don't — that would turn every WebP image into a
  sticker, and the loosened header path already re-types tagged WebP stickers).
- **Frontend (`patches/desktop`)**: new `LottieSticker.tsx` fetches the sticker
  blob, sniffs the gzip magic (`1f 8b`) so both gzipped `.tgs` and plain Lottie
  `.json` go through one path, decompresses `.tgs` with `DecompressionStream`,
  and plays it with **lottie-web's eval-free `lottie_light`** build (the SVG
  renderer). `messageAttachment.tsx` routes Lottie stickers to it; static/WebP
  stickers keep the existing `<img>` path. Honors `prefers-reduced-motion`
  (renders a still first frame). On decode failure it shows a neutral 🧩 box so
  the message layout stays stable.
- **CSP gotcha**: the app CSP is `script-src 'self' 'wasm-unsafe-eval'` — no
  `'unsafe-eval'`. The *full* lottie-web build calls `eval()` for Lottie
  expressions and would be blocked; `lottie_light` has no expression evaluator
  (and `.tgs` forbids expressions anyway). Verified the production `bundle.js`
  contains **zero** `eval(` calls after adding it.
- **Build note**: `lottie-web` added to the vendored frontend `package.json`
  *and* its `pnpm-lock.yaml` (CI installs `--frozen-lockfile`); esbuild bundles
  `lottie_light` with 0 warnings/errors. Release browser build + frontend
  `tsc` both pass.
**Cost:** core = 2 changed lines (1 patch); desktop = 1 patch (new component +
~30 lines wiring + one dependency).

### Composer sticker picker (2026-07-10)

The picker was assumed descoped, but most of it already worked: the web-app
runtime implements `transformStickerURL`/`deleteSticker`, and the core RPCs it
drives (`misc_get_sticker_folder`, `misc_save_sticker`, `misc_get_stickers`)
run on the wasm memfs — the tokio-wasm-shim `fs` has full `create_dir_all` +
`read_dir` + `DirEntry`/`FileType` support, and the stickers dir
(`accounts/<id>/stickers/`, outside the blobdir) is mirrored to OPFS like the
rest of the memfs (`mark_dirty` fires on every write/copy/mkdir), so saved
stickers **persist across reloads**. So listing, saving to a collection,
deleting, and sending all already worked for static (png/webp/gif) stickers.

Two gaps closed to finish it for animated stickers:
- **Core (`patches/core`)**: `misc_get_stickers` filtered to png/webp/gif, so a
  saved `.tgs` never listed. Added `.tgs` to the accepted extensions.
- **Frontend (`patches/desktop`)**: the picker rendered every thumbnail with a
  plain `<img>`; `.tgs` thumbnails now use the same `LottieSticker` player
  (made reusable via an optional `className`). Static stickers keep `<img>`.

Not changed (upstream behavior, not a browser gap): the picker is populated
only by "add to sticker collection" on a received sticker — there's no bulk
pack-import UI, on desktop either.

**Cost:** core = 1 changed line (1 patch); desktop = 1 patch (picker wiring +
`LottieSticker` className refactor).

### Hardening (self-review, 2026-07-10)

- **Gzip-bomb guard**: a `.tgs` renders automatically when its message scrolls
  into view, so `LottieSticker` caps both the compressed blob (1 MiB) and the
  streamed decompressed output (8 MiB, enforced chunk-wise) — a hostile sticker
  can't expand unboundedly and OOM the tab that also hosts the wasm core.
- **Scoped the `Chat-Content: sticker` override**: it now only re-types
  file-bearing parts (`Image`/`Gif`/`File`/`Sticker`), not `Text`/`Webxdc`/
  `Voice`/etc., so the header can't turn a text message or a real file
  attachment into a fileless/broken sticker.
- Scoped Lottie detection to `.tgs` only (dropped a half-wired `.json` path) so
  message rendering, the picker, and "save to collection" agree on one format;
  remount `LottieSticker` per file via a `key` so a recycled row/thumbnail
  doesn't keep a stale failure.

## Backup-import reload race — images returned only after N reloads (2026-07-13)

Field report: after "Restore from Backup", the imported chats' images/blobs
were broken and only appeared after reloading the app ~3 times.

Root cause is the M5 async blob mirror at its worst case. Backup import unpacks
every blob into the memfs (`import_backup_stream_inner` → tar unpack + per-blob
`fs::rename`); each write only `mark_dirty`s the path onto the single FIFO OPFS
flusher (`tokio-wasm-shim/src/{fs,opfs}.rs`). The **database** is made durable
synchronously (sahpool VFS byte-swap in `Sql::import`), but the blobs drain
asynchronously and slowly (one `createSyncAccessHandle`+write+close each, only
when the single-threaded worker yields). Nothing waited for that queue: the
`importBackup` RPC resolved as soon as the DB was in, with the blob tail still
in flight. A reload before it drained rebuilt the memfs from OPFS via
`hydrate()` from a **still-incomplete** OPFS, so the not-yet-flushed blobs
showed broken. They are NOT re-downloaded from the server. They come back
because the previous core worker is not terminated on navigation (terminating
on `pagehide` was tried and reverted — see the "instant-reload OPFS race" note
above), so it keeps draining its blob queue into OPFS in the background while
the new worker blocks on the OPFS lock wait; each subsequent reload's
`hydrate()` therefore snapshots a fuller OPFS, until after a few reloads it is
complete (the "reload 3 times" symptom).

Fix: make the mirror drainable and drain it as part of finishing an import.
- `opfs.rs`: an `INFLIGHT` counter (incremented when a path enters the flusher
  channel, decremented only *after* its reconcile reaches OPFS — deliberately
  not the `PENDING` set, which is cleared before the async write) plus
  `flush_pending()`, which awaits `INFLIGHT == 0` (30s safety cap + warning).
- Exposed through `tokio::fs::flush_pending` → the wrapper's async
  `DeltaChat::fs_flush` (`packages/core-wasm/rust`) → a new `flush` fs
  side-channel op in `worker.ts` → `Core.fsFlush()` in the core-wasm package.
- `runtime.ts` holds a **successful** `import_backup` response (tracked by
  request id in the `_send` wrap) until `fsFlush()` confirms every imported blob
  is durable, then delivers it. So the frontend's `importBackup` promise resolves
  only once a reload would find everything; failed imports pass straight through.

Drain deliberately runs on the RPC *response*, not mid-import: by then core has
finished every blob write, so `INFLIGHT` reflects the whole remaining queue and
can't read a transient 0. Verified the shim compiles for `wasm32-unknown-unknown`
and that a `#[wasm_bindgen]` async `&self` method (the `fs_flush` shape) builds;
a full wasm/e2e build needs the vendored core submodule + toolchain.
