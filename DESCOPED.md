# Descoped / postponed

Deliberate omissions from the prototype. Postponed ≠ rejected — each entry says why and what re-enabling takes.

| What | Why | Re-enabling would take |
|---|---|---|
| iroh (webxdc realtime + P2P backup transfer) | Browser iroh (0.32+) is relay-only, no LAN connectivity; DC backup transfer is LAN-restricted so it can't work; webxdc isn't in the browser edition anyway. Stubbing also cuts a large dep tree from the wasm build. | Un-stub iroh on wasm (it does compile), plus upstream lifting the LAN restriction or webxdc landing in the browser edition. File-based IMEX covers backups meanwhile. |
| webxdc | Not implemented in upstream's browser edition either; needs sandboxed iframe hosting + iroh for realtime. | Iframe host in the web-app runtime, webxdc blob serving, iroh. |
| HTML email | Unimplemented in upstream target-browser; needs a sandboxed viewer window. | Sandboxed iframe viewer + `openMessageHTML()` impl. |
| Video calls | Runtime `startOutgoingVideoCall()` — desktop-specific. | Open call URL in new tab; low effort, low priority. |
| sqlcipher / DB encryption | SQLCipher's vendored OpenSSL doesn't build for wasm32; OPFS is origin-sandboxed anyway. | A wasm-compatible SQLite cipher VFS, or upstream rusqlite wasm support with a different cipher. |
| In-session sahpool growth (reserve-before-open core patch) | The sqlite pool is sized at boot (`max(32, 2N+8)`, FINDINGS M5); creating ~`N+8`+ accounts in one session without a reload can exhaust it. Degrades gracefully (creation errors, reload re-sizes and recovers), and mass in-session account creation isn't a real user flow — not worth a new core patch (patch-count is the prototype's headline metric). | A small core patch: an async `tokio::fs::reserve_sqlite_slots(n)` call (shim-provided, wasm-cfg'd) at the top of `Sql::open`, so every db open guarantees free slots first. Scoped during the post-#75 CANTOPEN incident (2026-07-12). |
