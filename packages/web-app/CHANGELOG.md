# Changelog

## Unreleased

- **Readable invite links**: a group, channel or contact invite link
  (`https://i.delta.chat/#…`) in a message now shows as a small card with the
  name and a "View" button instead of the long fingerprint URL. Tapping it
  opens the same join/chat confirmation as before.

- **Emoji completion menu is now on by default**: type `:smile` in the
  composer to pick an emoji. Turn it off in Settings → Experimental features
  if it gets in your way.

- **Links lose their tracking**: known tracking parameters (`utm_*`, YouTube
  `si=`, click ids, Amazon affiliate refs, …) are now removed when you open a
  link and when you paste one into the composer — pasting shows a quiet
  "Tracking removed from link" note with Undo. On by default; switch it off in
  Settings → Chats and Media.

- **Add relays without a QR code**: Settings → Advanced → Transports now has
  an "Add from relay list…" button — pick from the public relay directory
  (with live ping), from relays your contacts already use, or just type a
  relay's domain. Relays derived from your contacts are only pinged when you
  press "Measure ping", so nothing about your contacts leaks to the bridge
  unless you ask.

- **Experimental: estimated read time on the unread badge** — the chat list
  can show roughly how long a chat's unread messages take to read (e.g.
  "~4 min", capped at "10+ min") next to the unread counter. Off by default;
  opt in under Settings → Advanced → Experimental features.

- **In-app translation editor** (`Ctrl/Cmd+Shift+L`, in every build): a popup
  window to edit the current language's UI strings live, with badges for
  untranslated / experimental keys, category filters, per-language completion,
  Android-XML / JSON export, and an element inspector (🎯) that finds a string's
  translation key. You can create languages on the fly (with an LTR/RTL toggle);
  edits and created languages persist in the browser. RTL languages now render
  right-to-left. See [`docs/translation-editor.md`](../../docs/translation-editor.md).

## 0.6.0 — 2026-07-15

- **Native 1:1 calls — audio, video, and screen share**: place and receive
  in-app calls, wire-compatible with real Delta Chat clients (raw-SDP
  offer/answer carried over DeltaChat messages, non-trickle ICE). Includes
  mic/camera selection with mid-call hot-switching, avatar speaking-ring
  indicators, mute, a direct-vs-relay connection indicator, a synthesized
  ringtone + vibration for incoming calls, content-free call analytics, and a
  full-bleed mobile layout. An active call prefers a detached popup window
  (same origin, `/call-popup.html`) so it keeps running while you use the rest
  of the app, and falls back seamlessly to an in-page overlay if the popup is
  blocked; ringing always stays in the main window so it can't be
  popup-blocked. See [`docs/calls.md`](../../docs/calls.md).
- **Webxdc app icons in the title bar can't impersonate native controls**: the
  last-used-app icons shown in a chat's title bar are app-supplied images. One
  with transparency could be shaped to look like a native navbar control (a
  fake three-dot menu, say). They now render on an opaque white tile, so
  transparent areas never blend into the navbar and the icon always reads as a
  distinct app. Their click target stays icon-sized — unlike the native navbar
  buttons below, a stray tap won't launch an app.
- **Bigger click targets for the chat title-bar buttons**: the apps, map and
  three-dot menu icons in a chat's title bar had a cramped 20×20&nbsp;px hit
  box sitting in a 50&nbsp;px-tall navbar, with an unclickable 12&nbsp;px gap
  between them, so it was easy to miss them. Each button's clickable area now
  fills the navbar's vertical dead space and the inter-button gap. The icons
  and the navbar height are pixel-for-pixel unchanged — only the hit box grew,
  cancelled out by negative margins so nothing moves visually.
- **Emoji autocomplete in the composer**: type a colon and a couple of letters
  (e.g. `:sm`) to get a popup of matching emoji — arrow keys to move, Enter to
  insert. Matches shortcodes, names and keywords. Off by default; turn it on
  under Settings → Advanced → Experimental features.
- **Backup import now persists its images before finishing**: after restoring
  from a backup you no longer have to reload several times for the pictures to
  show up. Imported blobs are written to the in-memory fs and mirrored to OPFS
  by an asynchronous flusher; a reload before that queue drained rebuilt the fs
  from a still-incomplete OPFS, so images were missing until enough further
  reloads let the background flush catch up. The `importBackup` call now waits
  for every imported blob to be durably in OPFS before it resolves, so a reload
  immediately afterwards finds everything.
- **Relay picker: dialog with reachability & latency, custom relay**: the
  onboarding relay picker is now a row that opens a "Choose a chatmail relay"
  dialog (instead of an inline dropdown that clipped against the screen edge).
  The list appears instantly; each relay is probed over the bridge only when the
  dialog opens (with a little sonar-ping animation while it probes, so the
  common "take the default" path doesn't wait). A relay shows its round-trip
  latency when it answers, otherwise "unreachable" — including a relay a hosted
  bridge's allowlist won't route to, since the real signup would be refused the
  same way; a refused probe is never shown as reachable. An "Other relay…" field
  lets you type any chatmail relay by hostname. Creating an account on a
  picked or typed relay no longer runs the slow classic-email autoconfig
  lookups — the core tries the standard chatmail server setup first and only
  falls back to autoconfig if that doesn't connect.
- **Relay picker directory source fixed**: the relay picker (shipped in 0.5.0)
  fetched the relay list from a chatmail pages repo that is private, so the
  fetch 404ed and the dropdown never appeared. It now fetches JSON from
  [chatmail-relays-mirror](https://github.com/experintellia/chatmail-relays-mirror),
  an automated daily mirror of [chatmail.at/relays](https://chatmail.at/relays)
  (which a browser app can't read directly — no CORS, private source repo),
  served with CORS from GitHub raw. A new `SLOTHFUL_RELAY_DIRECTORY`
  build/customize variable points an instance at another directory URL (the
  page CSP is pinned to it automatically) or disables the picker with `off`.

## 0.5.1 — 2026-07-12

- **Relay picker on onboarding**: the "create profile" screen shows a dropdown
  right above the privacy-policy consent to choose which public chatmail relay
  the new address is created on — the default relay first, then the relays
  fetched live from the chatmail directory (the `relays.markdown` source
  behind chatmail.at/relays), filtered down to those the WS→TCP bridge can
  resolve over its `/dns` endpoint. The consent link follows the choice to the
  picked relay's privacy policy. The dropdown only appears when there is a
  real choice (more than one reachable relay, and no scanned
  `dcaccount:`/`dclogin:` QR pinning the server); if the directory or bridge
  is unreachable, onboarding looks exactly like before.
- **Contact the developer for feedback**: the New Chat dialog gains a "Sloth
  (Slothful.chat Developer)" entry ("Send feedback & report bugs") that opens a
  chat with the developer via a baked-in invite link. It sits with the other
  community suggestions, so Settings → Chats and Media's "Hide community
  suggestions" toggle (and the `SLOTHFUL_HIDE_PUBLIC_SUGGESTIONS` instance
  variable) hide it too, and it automatically disappears once you've
  established the chat with the developer.
- **Diagnostics panel** (Settings → open the log → Diagnostics): on-device
  profiling — cold/warm startup breakdown (worker → core → UI, plus first
  account configured), recent-startups history, and timed round-trips (account
  configure, send by kind, backup import/export, chat load) — with a copy
  button. Never leaves your device. PGP encrypt/decrypt/keygen time is measured
  in the wasm shim (issue #3, Step 0).
- **Anonymous usage statistics** on configured instances only (via Plausible's
  events API from our own bundle — no third-party script). Opt-out, with a
  one-time notice, a diagnostics-panel toggle, a closed and fully documented
  event list, and an imprint privacy section. Self-hosted builds collect
  nothing. Events cover onboarding funnel + method, account/server type, sends
  by kind, QR scans, community-channel use, link-preview accept/dismiss, info-
  link clicks, bridge kind, backup/key import-export, chat export, first-chat /
  >10-chat milestones, bucketed startup (cold/warm), and fatal boot errors by
  category.
- **Seekable video/audio**: the blob service worker now answers HTTP Range
  requests (206 Partial Content, `Accept-Ranges`), so seeking in served
  `<video>`/`<audio>` works instead of the media being treated as
  non-seekable.
- `SLOTHFUL_PUBLIC_BRIDGES` parsing tolerates shell-style quotes pasted into
  the GitHub Variable (previously a stray quote failed the `ws://`/`wss://`
  guard and silently dropped the whole list); SELFHOSTING.md documents the
  Variables-tab traps next to the env-var table.
- The webimap setup-failure alert no longer dumps the raw wasm stack
  backtrace before the troubleshooting checklist; the trimmed error message
  survives as a footnote under it.

## 0.4.0 — 2026-07-11

- **Link previews** (privacy-preserving, sender-baked): when the message you're
  typing contains a URL and has no image, the composer offers a dismissible
  ghost to add a preview. Accepting renders the link's OpenGraph metadata into a
  card image **on your device** and attaches it as the message image — so the
  recipient's client never contacts the link (no IP/metadata leak) and every
  client renders it as an ordinary text+image message. Metadata is fetched
  through a bridge with unfurl enabled; layout (compact vs large "hero") follows
  the site's own metadata and can be toggled or removed on the draft. Off by
  default (experimental); turn it on in Settings → Advanced.
- **Self-hosting**: a new `SLOTHFUL_DEFAULT_CHATMAIL` build/customize variable
  points the "create new account" onboarding flow at your own chatmail relay
  (accepts a bare host, a URL, or a `dcaccount:` QR). The welcome-screen
  consent link then names that relay and its privacy policy. Unset keeps
  upstream's default relay; users scanning a `dcaccount:`/`dclogin:` QR still
  override it.
- **Public WS→TCP bridges**: operators can advertise bridges via a new
  `SLOTHFUL_PUBLIC_BRIDGES` build/customize variable (`;`-separated
  `URL description` entries), and the bridge dialog becomes an option picker
  — localhost, the instance default, each public bridge, or a custom URL —
  with a "Test selected" probe and copy explaining why a bridge is needed and
  that its traffic is end-to-end encrypted.
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
- **Animated stickers**: Telegram `.tgs` (gzipped Lottie) stickers play in
  messages and in the composer sticker picker, and sending a `.tgs` via the
  file picker delivers it as a sticker. Playback uses lottie-web's eval-free
  build (CSP-safe), caps compressed/decompressed size against gzip bombs, and
  honors reduced-motion preferences.
- **New Chat suggestions**: a "Public Bots" entry opens a searchable
  directory of community bots (from `deltachat-bot/public-bots`; first-run
  consent, revocable in settings), and "Public Channels" links out to
  community channel lists. A settings toggle hides them per user;
  `SLOTHFUL_HIDE_PUBLIC_SUGGESTIONS` hides them instance-wide.
- **Read-by & reaction popovers**: hovering a message's delivery-status icon
  shows who read it (avatar, name, relative time) once it's read, and hovering
  a reaction shows who reacted per emoji — in a shared, compact card.
- **OS integration** (installed PWA): registers as a handler for Delta Chat
  invite links (`openpgp4fpr` / `i.delta.chat`), for shared text/links (opens
  a "send to which chat?" picker), and for `.xdc` files. Launches are buffered
  until an account is ready so they never fire too early.
- **Message Info** shows attachment details (file name, MIME type, size,
  image/video dimensions, audio/video duration) and the delivery-failure
  reason; clicking a failed message's status icon opens Message Info.
- **webimap setup**: pasting a full `https://…` URL into the madmail server
  field works, and a failed madmail account setup appends a troubleshooting
  checklist (server online? webimap enabled? CORS configured?) to the error
  alert instead of leaving only an opaque NetworkError.
- **About dialog**: SlothfulChat's own icon on the About dialog and welcome
  screen, links restyled as buttons, and a Changelog button that opens the
  bundled changelog viewer (also reachable at `/changelog`).
- Big dialogs (settings, about, profiles, media view, new chat, QR scanner)
  go full-screen on phone-sized viewports.
- Dialog & input polish: single-input prompt dialogs (edit display name,
  contact name, account tag) submit on Enter; a dialog no longer closes when a
  drag started inside it is released over the backdrop; right-clicking the chat
  list no longer leaks the browser's own context menu; and the inert "Enable
  Webxdc Devtools" setting is hidden.
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
