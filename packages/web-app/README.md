# @slothfulchat/web-app

deltachat-desktop's browser-edition frontend running **standalone in the
browser** on [`@slothfulchat/core-wasm`](../core-wasm/) — no node backend, no
Electron. The upstream frontend is served almost unmodified (a small
`patches/desktop` stack only adds an About blurb and hides the unimplemented
proxy UI); everything browser-specific lives in our own files:

- `src/runtime.ts` — our implementation of the desktop `Runtime` interface,
  shipped as `runtime.js` (the module upstream's `main.html` loads before the
  app bundle to provide `window.r`). Transport → wasm core in a worker,
  settings → localStorage, locales/themes → static fetches, temp files &
  file dialogs → core's in-browser filesystem, backup export destination
  rewrite (`'<BROWSER>'` → memfs).
- `src/blobs-sw.ts` — service worker serving `/blobs/…` (attachments,
  avatars) and `/download-backup/…` by reading the core worker's filesystem
  through a postMessage bridge.
- `assemble.mjs` — copies the built upstream frontend from
  `build/desktop/packages/target-browser/dist/` + locales, overlays our
  `static/main.html` (CSP loosened for wasm/workers, PWA manifest) and the
  core-wasm worker/wasm artifacts into `dist/`.
- `serve.mjs` — static dev server (port 8642, `PORT` env to override).
- `static/manifest.webmanifest` — PWA manifest (installable, standalone).

## Run

Prerequisites (from repo root): patches applied, core-wasm built, and the
upstream frontend built once (`cd build/desktop && pnpm install
--frozen-lockfile && pnpm build:browser`). Then:

```sh
# terminal 1 — the WS→TCP proxy (browsers can't open TCP; IMAP/SMTP tunnel)
node ../ws-tcp-proxy/ws-tcp-proxy.mjs   # or: npx @slothfulchat/ws-tcp-proxy

# terminal 2 — assemble + build + serve
cd packages/web-app && pnpm start
```

Open http://localhost:8642 — log in with a chatmail address + password
(classic email login; see FINDINGS.md for what instant onboarding can and
cannot do without in-wasm HTTP). Bridge URL defaults to `ws://localhost:8641`;
override with `?proxy=` (highest precedence, used by tests) or persistently via
the bridge dialog (warning toast when the bridge is down, or Settings →
Connectivity → "Change…"), which saves to the `slothfulchat.proxyUrl`
localStorage key. Persistence (OPFS) is on by default; `?persist=0` gives a
throwaway session.

**Install as PWA:** browsers only offer install from a secure context —
`http://localhost` (dev) or any `https://` host (e.g. the GitHub Pages deploy);
a plain-http LAN IP won't get the prompt. The manifest ships 256/512px icons
and `display: standalone`. Note an installed PWA launches from `start_url`
without query params, so configure a non-default bridge via the dialog
(localStorage), not `?proxy=`.

## Tests (from repo root)

```sh
node scripts/smoke-web-app.mjs      # boots, zero-account UI renders
node scripts/test-web-app-e2e.mjs   # UI login, send, account switch, receive
node scripts/test-web-app-imex.mjs  # backup export → download → restore
node scripts/test-persistence.mjs   # account + message survive reload
```

## Deployment (GitHub Pages)

Pushes to the default branch auto-build and deploy `dist/` to GitHub Pages
via [`.github/workflows/deploy-pages.yml`](../../.github/workflows/deploy-pages.yml).
Enable it once under repo **Settings → Pages → Source = "GitHub Actions"**.
The app derives its base path at runtime, so a project site
(`https://<user>.github.io/<repo>/`) works with no build-time config.

**The deployed site is a static PWA shell** — it boots, is installable, and
renders the full UI, but it can only send/receive with a reachable WS→TCP
proxy, and Pages provides none:

- Pages is static, so it cannot host the [`@slothfulchat/ws-tcp-proxy`](../ws-tcp-proxy/) bridge.
- An `https://` origin cannot connect to a plain `ws://` proxy (mixed
  content), and the bundled proxy speaks `ws` on localhost only.

To get a working client from the deployed site, run a `wss://` proxy
somewhere reachable and point the app at it with `?proxy=wss://your-host` (or
the `slothfulchat.proxyUrl` localStorage key). Without that, the deploy is a
UI/PWA demo only.
