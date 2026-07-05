# Descoped / postponed

Deliberate omissions from the prototype. Postponed ≠ rejected — each entry says why and what re-enabling takes.

| What | Why | Re-enabling would take |
|---|---|---|
| iroh (webxdc realtime + P2P backup transfer) | Browser iroh (0.32+) is relay-only, no LAN connectivity; DC backup transfer is LAN-restricted so it can't work; webxdc isn't in the browser edition anyway. Stubbing also cuts a large dep tree from the wasm build. | Un-stub iroh on wasm (it does compile), plus upstream lifting the LAN restriction or webxdc landing in the browser edition. File-based IMEX covers backups meanwhile. |
| webxdc | Not implemented in upstream's browser edition either; needs sandboxed iframe hosting + iroh for realtime. | Iframe host in the web-app runtime, webxdc blob serving, iroh. |
| Stickers | Unimplemented in upstream target-browser (stubbed endpoint). | Sticker serving from shim FS + runtime `transformStickerURL()`. |
| HTML email | Unimplemented in upstream target-browser; needs a sandboxed viewer window. | Sandboxed iframe viewer + `openMessageHTML()` impl. |
| Video calls | Runtime `startOutgoingVideoCall()` — desktop-specific. | Open call URL in new tab; low effort, low priority. |
| sqlcipher / DB encryption | SQLCipher's vendored OpenSSL doesn't build for wasm32; OPFS is origin-sandboxed anyway. | A wasm-compatible SQLite cipher VFS, or upstream rusqlite wasm support with a different cipher. |
