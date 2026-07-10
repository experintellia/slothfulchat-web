# Changelog

## Unreleased

- **Self-hosting**: a new `SLOTHFUL_DEFAULT_CHATMAIL` build/customize variable
  points the "create new account" onboarding flow at your own chatmail relay
  (accepts a bare host, a URL, or a `dcaccount:` QR). The welcome-screen
  consent link then names that relay and its privacy policy. Unset keeps
  upstream's default relay; users scanning a `dcaccount:`/`dclogin:` QR still
  override it.
- **Export Chat** (three-dot menu): Telegram-style export of the open chat as
  a zip — `index.html` (a standalone viewer that looks like the message list,
  reusing the app's own stylesheets and markup, with a "Save single-file
  HTML" snapshot button), `messages.txt` (plain transcript), `messages.json`
  (the raw jsonrpc data, groundwork for a core-side export later), and
  `media/` with attachments/avatars next to it (50 MB per file / 300 MB
  total, larger attachments become file tiles). The zip carries a
  `manifest.toml`, so renamed to `.xdc` it doubles as a webxdc viewer app
  that can be sent into a chat. A confirm dialog explains what is not
  included (read receipts, full HTML e-mail contents, webxdc app content)
  and takes an optional start/end date to export only part of the history.
  The viewer names reactors (hover + click dialog), links files/images to
  the bundled originals, anchors quotes to their target message, renders
  vcard contact tiles, and marks failed/undownloaded/HTML-only messages.
  Offline e2e coverage in `scripts/test-export-chat-html.mjs`.

## 0.4.0 — 2026-07-10

- **Animated stickers**: Telegram `.tgs` (gzipped Lottie) stickers play in
  messages and in the composer sticker picker, and sending a `.tgs` via the
  file picker delivers it as a sticker. Playback uses lottie-web's eval-free
  build (CSP-safe), caps compressed/decompressed size against gzip bombs, and
  honors reduced-motion preferences.
- **Message Info** shows attachment details (file name, MIME type, size,
  image/video dimensions, audio/video duration) and the delivery-failure
  reason; clicking a failed message's status icon opens Message Info.
- **webimap setup**: pasting a full `https://…` URL into the madmail server
  field works, and an unreachable or CORS-blocked server is detected up front
  with a clear message instead of an opaque login error.
- **About dialog**: SlothfulChat's own icon on the About dialog and welcome
  screen, links restyled as buttons, and a Changelog button that opens the
  bundled changelog viewer (also reachable at `/changelog`).
- Big dialogs (settings, about, profiles, media view, new chat, QR scanner)
  go full-screen on phone-sized viewports.
- **Storage resilience**: a corrupted `accounts.toml` with no rebuildable
  accounts no longer bricks boot permanently (the self-heal rebuild now
  writes a config core accepts).

## 0.3.0 — 2026-07-09

- **Sticker picker** (fixes a crash on open).
- QR reader defaults to the rear camera; the About dialog shows the source
  commit it was built from.
- Hide the second-device / add-as-companion options — iroh-based device sync
  isn't supported in the browser.

## 0.2.0 — 2026-07-08

- **webimap transport**: madmail's WebIMAP/WebSMTP over plain HTTPS as a
  bridge-free alternative to the WS→TCP bridge (needs no `ws-tcp-proxy`).
- **Installable offline PWA**: a content-hashed precache app shell served by
  `blobs-sw.ts`, so the app boots offline, plus a boot-error screen; the
  project's own sloth app icon instead of the upstream Delta Chat icons.
- **iOS PWA robustness**: backup export and attachment downloads happen in-page
  (installed iOS PWAs block the usual download path); the on-screen keyboard no
  longer hides the layout or navbar; reload-once recovery after a hard reload so
  blob URLs resolve.
- **Storage resilience**: a corrupted `accounts.toml` / OPFS mirror self-heals
  (sync access handles) instead of bricking boot; an accurate error with a copy
  button when the browser blocks storage.
- **Theming**: patch-free SCSS themes compiled against upstream's theme base,
  including a Rocket.Chat-inspired `dc:rocket` theme with per-message avatars.
- Imprint page names the default relay and adds a links disclaimer and an
  encryption-info hint; release builds hide dev-only features.

## 0.1.0 — 2026-07-07

First prototype of the standalone web UI: deltachat-desktop's browser frontend
running fully in the browser on `@slothfulchat/core-wasm` — no node backend, no
Electron. The upstream frontend is served almost unmodified; everything
browser-specific lives in our own runtime and service worker.

- **Standalone browser client**: `runtime.ts` implements the desktop `Runtime`
  interface against the wasm core in a worker — transport, settings
  (localStorage), locales/themes (static fetches), temp files and file dialogs
  (the core's in-browser filesystem), and backup-export destination rewrite.
- **Bridge transport**: connects through the `@slothfulchat/ws-tcp-proxy` WS→TCP
  bridge (browsers can't open raw TCP); the bridge URL is configurable via
  `?proxy=`, a bridge dialog, or the `SLOTHFUL_DEFAULT_PROXY` build var, and a
  bridge overlay/warning sits above modal dialogs and surfaces on the welcome
  screen when the bridge is down.
- **Per-instance config**: imprint (legal notice) page, instance name (tab
  title, PWA name, boot-error screens) and default proxy baked in from
  `SLOTHFUL_*` build vars via a `config.js` loaded before the app (CSP is
  `script-src 'self'`, so no inline config script).
- **UI**: webxdc icons and start dialog, connectivity loading state, temp-file
  blob previews, camera-permission handling, and a manifest CSP fix.
- **Deploy**: `assemble.mjs` builds a static `dist/` deployed to GitHub Pages;
  the app derives its base path at runtime, so a project site works with no
  build-time config. The deployed site is a UI/PWA shell — sending and
  receiving still need a reachable `wss://` proxy.
