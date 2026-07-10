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
  core-wasm worker/wasm artifacts into `dist/`. Also drops in the two
  auxiliary static pages: the core-wasm `/demo/` and the `/changelog/` viewer
  (see [`changelog/`](changelog/README.md)), copying each published package's
  `CHANGELOG.md` in beside the latter.
- `changelog/` — vendored static changelog viewer served at `/changelog/`.
- `serve.mjs` — static dev server (port 8642, `PORT` env to override).
- `static/manifest.webmanifest` — PWA manifest (installable, standalone). Also
  registers the app as an OS handler for three kinds of launch, all wired in
  `runtime.ts` (see `parseShareAction` + the launchQueue consumer). Each launch
  is captured immediately but held until `emitUIFullyReady()` (the frontend has
  selected an account and re-registered its callbacks — the same gate electron
  uses via `frontendReady`; delivering earlier throws "accountId is not set"):
  - **`openpgp4fpr:` protocol handler** — that scheme is on the browser
    safelist, so an installed instance opens Delta Chat verify/invite/login
    deep links → frontend `onOpenQrUrl`.
  - **share target** — lets a `https://i.delta.chat/…` invite (or any shared
    text/link) reach the app from another app's share sheet, no upstream/domain
    registration needed. A field that is exactly a recognized invite goes to
    `onOpenQrUrl`; anything else (including prose that merely mentions a link) is
    forwarded whole as a message via `onWebxdcSendToChat(null, text)`, which
    opens the "send to which chat?" picker with the text as a draft.
  - **`.xdc` file handler** — an opened webxdc archive is read via `launchQueue`
    and forwarded into a chat with `onWebxdcSendToChat({file_name, file_content})`
    (base64 → `writeTempFileFromBase64`, the same contract electron/tauri use).
    Running webxdc isn't supported in this edition, but sending one to a
    recipient whose client can run it is.
  - `launch_handler: focus-existing` keeps the single-instance app from opening
    a second window (which would lose the OPFS lock); a warm launch arrives via
    the launchQueue consumer's `targetURL` instead of a navigation.
- `themes/*.scss` — our own themes (e.g. `rocket.scss`, a Rocket.Chat-inspired
  look). `assemble.mjs` compiles them against upstream's `_themebase.scss`
  (from `build/desktop/packages/frontend/themes/`) into `dist/themes/`, where
  the `themes.json` scan auto-registers them — adding or changing a theme
  never touches `patches/`. Underscore-prefixed files are skipped, a `dev_`
  filename prefix hides a theme from the picker (see upstream
  `docs/THEMES.md`). One exception to "no patches": desktop patch 0010
  renders hidden `.author-avatar.extra` elements on outgoing/1:1 messages
  (behavior-neutral for stock themes) so the Rocket theme can opt into
  Rocket.Chat-style avatars on every message. Iterate visually with
  `node scripts/theme-shots.mjs dc:rocket` (from repo root): first run seeds
  two throwaway accounts + a conversation into a persistent browser profile
  under `.cache/`, later runs just recompile-reload; screenshots land in
  `.cache/theme-shots/<theme>/`.

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
node scripts/test-export-chat-html.mjs  # chat → zip export: html viewer/txt/json/media (offline)
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

### Per-instance config (build-time env vars)

`assemble.mjs` bakes optional per-instance values into `dist/` from
environment variables, so the imprint text and instance identity live in CI
config (repo **Settings → Secrets and variables → Actions → Variables**), not
in source. All optional:

| Env var | Effect |
|---|---|
| `SLOTHFUL_IMPRINT_NAME` | Responsible person/entity on the imprint page (legal notice). |
| `SLOTHFUL_IMPRINT_ADDRESS` | Postal address on the imprint page (newlines allowed). |
| `SLOTHFUL_IMPRINT_EMAIL` | Contact email on the imprint page. |
| `SLOTHFUL_INSTANCE_NAME` | Instance display name: tab title, PWA install name, boot-error screens, imprint page (e.g. `SlothfulChat`). |
| `SLOTHFUL_INSTANCE_URL` | Canonical origin, e.g. `https://web.slothful.chat`. |
| `SLOTHFUL_DEFAULT_PROXY` | Default `wss://` bridge the app uses when the user hasn't set one. Without it the app defaults to `ws://localhost:8641`. |
| `SLOTHFUL_PUBLIC_BRIDGES` | Public bridges offered in the app's bridge picker dialog: `;`-separated `URL description` entries (URL up to the first space, rest is a super-short description). Malformed entries are dropped. Localhost + a custom field are always offered; the `SLOTHFUL_DEFAULT_PROXY` bridge appears automatically (deduped). |
| `SLOTHFUL_DEFAULT_CHATMAIL` | Chatmail relay the "create new account" flow signs up on (host, URL or `dcaccount:` QR). Unset = upstream's default relay. Scanned QR codes still override it. |
| `SLOTHFUL_HIDE_PUBLIC_SUGGESTIONS` | `1`/`true`: hide the "Public Bots" / "Public Channels" community suggestions in the New Chat dialog instance-wide (also hides the per-user settings toggle). |

The instance/proxy values surface at runtime as `window.__slothfulConfig`
(injected before `runtime.js`); `runtime.ts` reads `defaultProxyUrl` from it.
`imprint.html` is always emitted — with a placeholder when unconfigured, so the
About link never dangles. Its scope/privacy/reporting text (imprint covers the
site only; everything runs client-side and the operator never receives your
data; how to handle problem users) is fixed in the template; only the operator
name/address/email come from env.
