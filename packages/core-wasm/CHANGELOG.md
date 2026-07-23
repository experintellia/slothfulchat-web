# Changelog

## 0.7.1 — 2026-07-23

- Fixed total account loss on boot: the sahpool slot-reclaim sweep decided
  which accounts still existed from the asynchronously-mirrored account folders
  rather than the synchronously-durable `accounts.toml`, so an account whose
  folder mirror merely lagged (or was dropped on tab close) had its intact
  database deleted and was then rebuilt away to nothing. The sweep now trusts
  `accounts.toml`, and skips entirely when that file is missing or corrupt.

## 0.7.0 — 2026-07-20

- Switching the UI language now refreshes already-rendered text (chatlist
  message summaries, self/device contact names, connectivity view) instead of
  leaving it in the old language until a full reload: the jsonrpc layer emits
  change events when stock strings are updated (backport of chatmail/core#7719
  / deltachat-desktop#5403).

## 0.6.0 — 2026-07-15

- Backup-import durability: new `flush` fs side-channel op and `Core.fsFlush()`
  (backed by `DeltaChat::fs_flush` → the shim's `tokio::fs::flush_pending`),
  which resolve once every queued OPFS write-through is durable. The web app
  awaits it before reporting an `import_backup` success, so imported blobs are
  persisted before the RPC resolves — otherwise a reload while the async OPFS
  flusher is still draining rebuilt the fs from an incomplete OPFS and the
  images were missing (#89).
- Pool-slot leak fixed (post-#75 boot `SQLITE_CANTOPEN`): `remove_account` only
  cleared the memfs keys and never the account's sqlite files (they live solely
  in the sahpool VFS), so every removed account permanently burned a pool slot
  until the fixed 32-slot pool filled and the next boot failed "unable to open
  database file". The memfs removal paths now free the pool files, boot sweeps
  orphaned slots (un-bricking already-exhausted installs) and grows the pool to
  the live account count, and the accounts.toml self-heal is gated on the config
  actually being implausible so a storage failure no longer triggers a
  quarantine boot-loop (#85).
- accounts.toml no longer rots to 0 bytes in OPFS: a trailing-slash spelling
  from a subtree rename slipped past the synchronous write-through guard and the
  file was left empty; paths are now compared component-wise. The self-heal's
  rebuild also preserves account IDs (using the last-good backup as id hints)
  instead of renumbering from 1, which had broken persisted per-account
  references (#83).

## 0.5.1 — 2026-07-12

- The tokio shim now profiles inline `spawn_blocking`/`block_in_place`
  closures (PGP keygen/encrypt/decrypt): per-session total/max/count exposed
  via `blocking_profile()`, individually slow closures logged as
  `sc:blocking …ms`. Groundwork ("Step 0 — profile first") for offloading PGP
  to a worker (issue #3); feeds the web app's Diagnostics panel.

## 0.4.0 — 2026-07-10

- Animated sticker support in the bundled core (core patches 0014, 0015):
  `.tgs` files are classified as `Viewtype::Sticker` (previously `File`), the
  `Chat-Content: sticker` header is honored for any file-bearing part (not
  just `Image`/`Gif` — and never for `Text`/`Webxdc`/`Voice`, so it can't
  hijack those), and `misc_get_stickers` lists `.tgs` alongside
  `.png`/`.webp`/`.gif`.
- accounts.toml self-heal: the last-resort rebuild wrote a file without the
  required `accounts` key when no account dirs existed, so core rejected its
  own rebuilt config with "missing field `accounts`" forever — a transient
  corruption (e.g. the OPFS-lock race reading the file as 0 bytes on
  service-worker reload) became a permanent boot failure. The zero-account
  rebuild now writes an explicit `accounts = []`.

## 0.3.0 — 2026-07-09

- webimap: connectivity badge no longer sticks at "Connecting…"/"Updating…"
  (core patch 0012). `ConnectivityStore::set()` dedups unchanged values, the
  receive loop sets Idle after every successful poll (not only on
  transitions), and the first poll — including the first after an error
  backoff — uses `wait=0` so "Connecting…" clears after one round-trip
  instead of a full 60s long-poll on an empty inbox.
- webimap: a 404 on `GET`/`DELETE /webimap/message/{uid}` is treated as
  already-gone, not an error (core patch 0013). Previously every stale UID —
  routine on iOS, where Safari suspends in-flight fetches and DELETE
  responses get lost while still landing server-side — bought a spurious 30s
  backoff and an error connectivity badge. GET 404 skips (a transient 404 is
  retried via the next listing), DELETE 404 counts as success; a server that
  keeps listing UIDs it cannot serve is throttled after three such rounds in
  a row. The warn logs remain as the trace that another consumer may exist.
- example page: the worker's fatal states (`fatal-opfs-locked` /
  `fatal-storage-blocked` / `fatal-init-error`, incl. the underlying error
  detail) are now surfaced as an inline hint instead of the page sitting on
  "loading core in a worker…" forever, e.g. when the demo is already open in
  another tab.
- Version note: 0.2.1 skipped — package versions now track the release tag
  (see RELEASING.md).

## 0.2.0 — 2026-07-08

- **webimap transport** (core patch 0011): madmail's WebIMAP/WebSMTP as a
  transport variant next to IMAP/SMTP — mail over plain HTTPS from the
  browser, needing no WS→TCP bridge. Enabled per-account via the `webimap`
  login param; `webimapaccount:host[:port]` QR scheme for instant onboarding;
  receive is a REST long-poll loop, send goes through `POST /webimap/send`.
- BREAKING (worker embedders only): the worker no longer reads `?proxy=` /
  `?persist=` from its script URL; `startCore` now sends a one-shot
  `{ type: 'config', proxyUrl, persist }` postMessage instead. Reason: a
  service worker serving the script from cache strips the query string from
  the response URL (= the worker's `import.meta.url`), which silently dropped
  the proxy config ("no WebSocket proxy configured" on every connection).
  Code using `startCore()` is unaffected.
- Storage robustness (field incident on iOS: a corrupted OPFS mirror bricked
  boot): a corrupted `accounts.toml` is self-healed instead of failing init,
  the OPFS mirror uses sync access handles, and the worker waits for OPFS
  handles on reload instead of racing the old worker.
- Fatal boot failures now reach the page as typed messages
  (`fatal-opfs-locked` / `fatal-storage-blocked` / `fatal-init-error`)
  instead of dying as unhandled rejections behind the loading screen.

## 0.1.1 — 2026-07-07

- In-wasm HTTP implemented via the browser's `fetch()` (was a bail-stub):
  https-URL `DCACCOUNT:` QR codes, provider autoconfig and the webxdc apps
  list now work where the endpoint's CORS headers allow it.
- README rewritten for the post-M5 state: networking via
  `@slothfulchat/ws-tcp-proxy` (`startCore({ wsProxyUrl })`), OPFS persistence
  on by default (`persist: false` opts out), hosted demo link, and the actual
  remaining limits (HTTP subject to CORS, one tab at a time, no sqlcipher).

## 0.1.0 — 2026-07-07

- Initial release: chatmail core 2.54.0-dev (2.53.0 + 54 commits + wasm patch
  stack) compiled to wasm, typed `@deltachat/jsonrpc-client` API, Web Worker
  transport, fs side channel, OPFS persistence, WebSocket→TCP networking.
