# What we changed compared to upstream

The vendored upstreams (`vendor/core` = chatmail core, `vendor/deltachat-desktop`)
are never modified in place — every change lives as a `git format-patch` file
under `patches/core` and `patches/desktop`. This file is the human-readable
summary of that patch stack: what we changed and why, without reading diffs.

Each entry references its patch file by directory and number, e.g. `core/0005`
= `patches/core/0005-wasm-IMAP-SMTP-through-a-WebSocket-TCP-proxy.patch`.

> **Keeping this up to date:** refresh this file **on every release** (see
> [RELEASING.md](RELEASING.md)). The routine: list `patches/core` and
> `patches/desktop`, diff against the references here, and fold every new or
> removed patch into the fitting section — each patch file starts with its
> commit message, which is usually all you need to read.

## Running in the browser at all (the port itself)

The bulk of `patches/core` makes a native Rust mail core compile and run on
`wasm32-unknown-unknown`. These aren't features, they're the reason the fork
exists:

- **Build surface** — native-only dependencies are target-gated, tokio is
  swapped for a browser-shim facade, and rusqlite is upgraded to a version
  with first-class wasm/SQLite support. `core/0001`
- **Clocks** — `SystemTime::now()`/`Instant::now()` abort on wasm, so
  everything reads the JS clock instead, including rustls certificate
  validation during the TLS handshake. `core/0002`, `core/0006`
- **Filesystem** — `std::fs` doesn't exist in the browser; blob storage,
  directory listing, and lockfile handling route through the project's
  memfs/OPFS shim. `core/0004`, `core/0007`
- **Networking** — browsers can't open TCP sockets, so IMAP/SMTP tunnels
  through a local WebSocket→TCP proxy; TLS still terminates inside wasm, the
  proxy only ever sees ciphertext. HTTP requests go through the browser's
  `fetch()`. SOCKS/shadowsocks proxying is stubbed out. `core/0003`,
  `core/0005`, `core/0010`
- **Backups** — file-based backup export/import reimplemented for the wasm
  VFS (sqlite-wasm-rs has no `sqlcipher_export`, so the database bytes are
  swapped at the VFS level; encrypted backups stay unsupported on wasm).
  `core/0008`, `core/0009`

## New features

- **webimap transport (madmail)** — a second mail transport speaking
  [madmail](https://github.com/themadorg/madmail)'s WebIMAP/WebSMTP REST API
  over plain HTTPS `fetch()`, so accounts on such servers need no bridge at
  all. Includes the login toggle and the welcome-screen "madmail server"
  entry. When account setup fails, the error alert appends a webimap
  troubleshooting checklist (address/server online, webimap+websmtp enabled,
  CORS headers) — a cross-origin fetch failure is deliberately opaque in the
  browser, and an earlier up-front reachability/CORS probe misdiagnosed
  working servers, so the hints ride on the real error instead. `core/0011`,
  `desktop/0011`, `desktop/0021`, `desktop/0026`
- **Profiling & anonymous usage statistics** — an in-app Diagnostics panel
  (opened from the log dialog) shows on-device startup/RPC timing that never
  leaves the device; PGP timing is measured in the wasm shim
  (`crates/tokio-wasm-shim`, issue #3 Step 0). The official demo instance can
  additionally collect opt-out, cookieless usage stats via Plausible's events
  API from our own bundle (no third-party script, one extra `connect-src`
  origin); self-hosted builds collect nothing. Most events are derived from
  JSON-RPC traffic in `packages/web-app/src`; three desktop hooks add the UI-only
  signals (onboarding welcome, link-preview accept/dismiss, community-channel
  use), the Diagnostics button, and the consent surfaces (welcome-screen opt-out
  checkbox, Settings → Advanced toggle, privacy-policy links in About/welcome);
  a fourth fires `chat_export` when a chat export succeeds.
  `desktop/0043`, `desktop/0044`, `desktop/0045`, `desktop/0046`
- **Attachment details & failure reason in Message Info** — file name, MIME
  type, size, image/video dimensions, audio/video duration; delivery failures
  show as an error banner, and clicking a message's failed-status icon opens
  Message Info instead of a bare alert. `desktop/0022`
- **Hover popovers for read-by and reactions** — hovering the delivery-status
  icon of a *read* outgoing message shows who has read it (avatar, name and a
  relative timestamp); hovering a single reaction lists just the people who
  reacted with that emoji, while the "+N" overflow pill lists the rest. Both
  surface the info already in the Message Info / Reactions dialogs without a
  click, sharing a new `PeopleHoverInfo` component (and an `xSmall` Avatar
  variant). `desktop/0034`
- **Themeable avatars on all messages** — upstream renders avatars only for
  incoming group messages; we render them everywhere but hide the new cases
  by default, so themes can opt in to Rocket.Chat-style avatars on every
  message. Pixel-identical for existing themes. `desktop/0010`
- **Build info in the About dialog** — shows the slothfulchat-web version and
  source commit a deployed instance was built from, with the commit message
  on hover. `desktop/0016`, `desktop/0024`, `desktop/0025`
- **Stickers, including animated Lottie** — Telegram `.tgs` (gzipped Lottie)
  stickers render and send, alongside static ones. Core classifies `.tgs` as a
  sticker and honors the `Chat-Content: sticker` header for file-bearing parts;
  the frontend plays `.tgs` with lottie-web's eval-free player (CSP-safe, with a
  gzip-bomb size cap) in both messages and the composer sticker picker (which
  now lists `.tgs` too). Mirrors ArcaneChat's animated-sticker support.
  `core/0014`, `core/0015`, `desktop/0027`, `desktop/0030`
- **Export Chat** — the three-dot menu exports the open chat as a
  Telegram-style zip: a standalone `index.html` viewer that renders the chat
  with the app's own stylesheets and message markup (embedded JSON data +
  self-contained renderer, "Save single-file HTML" snapshot button),
  `messages.txt`, the raw jsonrpc data as `messages.json`, and the media
  files next to it; a `manifest.toml` makes the zip double as a webxdc
  viewer app when renamed to `.xdc`. A confirm dialog names what is not
  included (read receipts, full HTML e-mails, webxdc app content) and takes
  an optional date range. `desktop/0032`, `desktop/0035`, `desktop/0037`,
  `desktop/0039`
- **Community suggestions in the New Chat dialog** — pseudo entries below
  "New Group"/"New Channel": "Sloth (Slothful.chat Developer)" opens a chat
  with the developer (via a baked-in invite link, routed through the regular
  invite-link confirmation flow) so users can send feedback and report bugs —
  it disappears once a contact with the developer's address exists (i.e. once
  the invite has been accepted and there is a real chat to use instead);
  "Public Bots" opens a searchable directory of community-made bots (name,
  admin, description, language) pulled from
  [deltachat-bot/public-bots](https://github.com/deltachat-bot/public-bots);
  the first open asks for consent to load from that third-party site and
  explains that the bots are community-made, not endorsed by us, and problems
  should be reported in that repo's GitHub issues; a second visit fetches
  without asking (revocable via a settings switch). "Public Channels" opens a
  small dialog linking channel directories (arcanechat.me/channels and
  fedimeteo.com's per-city weather channels). Settings → Chats and Media can
  hide all these entries per user; the `SLOTHFUL_HIDE_PUBLIC_SUGGESTIONS`
  build/customize variable hides them instance-wide including the toggles.
  `desktop/0033`
- **Configurable default chatmail relay** — the welcome-screen "create new
  account" flow (instant onboarding, no scanned QR) creates addresses on the
  chatmail relay named by the `SLOTHFUL_DEFAULT_CHATMAIL` build/customize
  variable (baked into `window.__slothfulConfig.defaultChatmailInstance`), so
  self-hosters can send new sign-ups to their own server. The value may be a
  bare host, a URL, or a `dcaccount:` QR. The welcome-screen consent link
  points at the configured relay and its `/privacy.html` (not upstream's
  default) whenever the account is actually created on it. Unset falls back to
  upstream's default instance; scanned `dcaccount:`/`dclogin:` QR codes still
  override it. `desktop/0038`
- **Relay picker on instant onboarding** — the "create profile" screen shows a
  row (right above the privacy-policy consent) with the chatmail relay the new
  address will be created on, and a button that opens a "Choose a chatmail
  relay" dialog: the default relay first, then the public relays fetched live
  from the relay directory. The directory is JSON from
  [chatmail-relays-mirror](https://github.com/experintellia/chatmail-relays-mirror),
  a dumb automated daily mirror of chatmail.at/relays (the site's markdown
  source repo is private and the site sends no CORS headers, so a browser app
  can read neither directly); the `SLOTHFUL_RELAY_DIRECTORY` build/customize
  variable points the fetch (and the CSP `connect-src` pin, via
  `instance-config.patchCsp`) elsewhere, or `off` disables the picker. The
  consent link follows the choice to the picked relay's `/privacy.html`. Only
  rendered when there is a real choice (more than one relay, no scanned
  `dcaccount:`/`dclogin:` QR); fails soft to no picker when the directory is
  unreachable. Fetching the list is cheap and done up front; each relay is
  probed over the bridge only when the dialog opens (a few at a time through a
  small worker pool, so a large directory doesn't flood a single-process local
  bridge) — it actually opens the relay's IMAP port (:143) through the bridge,
  with a little sonar-ping animation while it does — and the row shows an honest
  state: a round-trip
  latency (colour-coded dot) when the relay answers, otherwise `unreachable`
  (greyed, unselectable). "Otherwise" deliberately includes the case where the
  relay resolves but a hosted bridge's allowlist forbids the tunnel (close
  4003): the real signup would be refused the same way, so it is genuinely
  unreachable through this bridge — a refused probe is never shown as a success.
  A dialog rather than an inline dropdown so the list can't clip against the
  onboarding dialog and the status has room. An "Other relay…" field accepts any
  chatmail relay by hostname. Because these are all chatmail relays, account creation on
  a picked/typed relay skips the classic-email autoconfig probes: the core
  tries the standard chatmail server convention first and only autoconfigures
  if that doesn't connect (see `core/0016`). `desktop/0042`, `core/0016`
- **Privacy-preserving link previews** — when the draft contains a URL and no
  image, the composer offers a dismissible ghost to add a preview. Accepting
  fetches the link's OpenGraph metadata (through a bridge with unfurl enabled)
  and renders it into a card image *on the sender's device*, attaching it as
  the message image — so the recipient's client never contacts the link (no
  IP/metadata leak) and every client renders an ordinary text+image message.
  Layout (compact vs large hero) follows the site's metadata and is toggleable
  on the draft; off by default (experimental), enableable in Settings → Advanced.
  `desktop/0041`

## Bugfixes

Fixes for behavior that is broken (or only broken-in-a-browser) upstream. Not
upstreamed — this is a private patch-stack experiment with no upstream
contribution intended.

- Camera selection in the QR reader did nothing on multi-camera Android
  Chromium devices, and the camera menu was blank before permissions were
  granted; stale stored camera ids no longer show the error screen.
  `desktop/0013`
- Dialogs no longer close when a drag that started inside them (e.g.
  selecting text in an input) is released over the backdrop — an outside
  click only closes a dialog when the press also started on the backdrop.
  `desktop/0029`
- Cancelling account creation crashed the welcome screen: a link component
  resolved the (now unselected) account at render time instead of click time.
  `desktop/0008`
- Fast double-clicks on the "add account" button created duplicate accounts
  (account creation isn't instant in the wasm core); creation is now
  coalesced and the button shows a spinner. `desktop/0018`
- Search fields gave no visual indication of focus; they now use the app's
  standard focus outline. `desktop/0009`
- webimap: the connectivity badge no longer sticks at "Connecting…" /
  "Updating…", and a message that 404s on fetch/delete is treated as
  already-consumed instead of putting the poll loop into an error backoff.
  `core/0012`, `core/0013`
- Right-clicking a chat in the chat list showed the browser's own context
  menu on top of the app's: the chat-list handler awaited `getFullChatById`
  before calling `preventDefault`, so it fired too late for the web build
  (Electron has no native menu, so upstream never saw it). `preventDefault`
  now runs synchronously before the await. `desktop/0036`

## UI & mobile polish

- Big dialogs (settings, about, profiles, media view, new-chat, QR scanner)
  go edge-to-edge on phone-sized viewports, and the QR camera view fills the
  available height. `desktop/0020`
- The settings sub-pages (chats & media, notifications, appearance, advanced,
  connectivity, profile editor) go edge-to-edge on phones too, matching the
  settings root; small pickers and alerts stay popups. `desktop/0031`
- The QR reader defaults to the rear camera — you scan someone else's code,
  not your own face. `desktop/0015`
- The connectivity view shows a loading state instead of a blank iframe while
  the core is busy, and displays the WS bridge address with an edit button.
  `desktop/0002`, `desktop/0007`
- About dialog links are restyled as settings-style buttons, including
  entries for the source repo and the bundled changelog viewer.
  `desktop/0019`
- Prompt dialogs with a single text input (profile display name, contact
  name, account tag) confirm on Enter like a native `prompt()` would.
  `desktop/0028`

## Different decisions than upstream

- **Branding** — the app calls itself SlothfulChat and uses its own icon in
  the About dialog and welcome screen, with explicit "experimental fork, not
  affiliated with Delta Chat" notices and a source-code link. Only
  self-referential "Delta Chat" strings are renamed (in every locale, via the
  translation-conversion step); credits, delta.chat links, and donation
  strings keep the Delta Chat name. `desktop/0001`, `desktop/0003`,
  `desktop/0006`, `desktop/0017`, `desktop/0023`
- **Imprint links** on the About dialog and welcome screen — a hosted web app
  needs a legal-notice page. `desktop/0004`, `desktop/0005`
- **Hidden upstream UI that can't work in this build** — proxy settings
  (unimplemented on wasm), the second-device / multi-device backup
  transfer flow (iroh doesn't run in browsers yet), and the experimental
  "Enable Webxdc Devtools" switch (it only toggles Electron's DevTools on a
  webxdc iframe — a browser's built-in dev tools can't be gated by the app,
  and webxdc apps don't run in this build anyway). `desktop/0001`,
  `desktop/0014`, `desktop/0041`
- **Logging** — core Info/Warning/Error events are printed once by the
  core-wasm console bridge instead of twice, and the Log dialog points to the
  browser dev console instead of fetching a `/log` route this build never
  serves. `desktop/0012`, `desktop/0024`

## Missing / descoped (compared to upstream Delta Chat)

Deliberate omissions — postponed, not rejected. [DESCOPED.md](DESCOPED.md) has
the full table with what re-enabling each one would take.

- **webxdc apps** — not in upstream's browser edition either; needs a
  sandboxed iframe host on a separate origin (planned, see issue #2).
- **Second-device / multi-device backup transfer** — the UI is hidden
  (`desktop/0014`) because it *cannot* work here: browser iroh is relay-only
  with no LAN connectivity, and Delta Chat's backup transfer is
  LAN-restricted by design. File-based backup export/import covers moving an
  account meanwhile.
- **Maps / location streaming** — no map UI ships (it's a webxdc upstream).
  When it lands, the plan is to adopt ArcaneChat's per-message POI location
  API so a shared pin is tappable (issue #36).
- **Video calls** — the runtime hook is desktop-specific; opening the call
  URL in a new tab would be low effort but hasn't been prioritized.
- **HTML email viewing** — unimplemented in upstream's browser target too;
  needs a sandboxed viewer.
- **Database encryption (sqlcipher)** — doesn't build for wasm32; OPFS
  storage is origin-sandboxed by the browser instead.

Like ArcaneChat, this fork experiments a few steps ahead of upstream Delta
Chat while staying protocol-compatible with it; where ArcaneChat (or a
closed upstream PR) already designed something well, planned features borrow
that shape — e.g. the map POI API (#36) and per-account disabling modeled on
chatmail/core#5314 (#37).
