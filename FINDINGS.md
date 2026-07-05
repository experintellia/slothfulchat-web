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
