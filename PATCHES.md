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

The same distinction is carried into the generated JSON-RPC documentation, so a
reader does not have to come here to find out whether an API is upstream's or
ours. `pnpm mark-fork-api` (after `pnpm apply-patches`, before generating docs)
adds a line like

```
/// 🦥 slothfulchat-web fork: added by core/0028.
```

to the doc comment of every RPC method, type, variant and field the patch stack
touches — in the throwaway `build/core` worktree only, never in `patches/` or
`vendor/`. It derives the marks from `git blame` against the submodule pin, so
they name the responsible patch, say whether it was *added* or *changed*, and
cannot drift out of date. Both generators read those same `///` comments, so the
marks reach the TypeScript client (hence typedoc's HTML and the `.d.ts` an IDE
hovers) and the OpenRPC spec alike.

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
- **Crypto offload** — PGP key generation, encryption and decryption ran
  inline on the core worker (wasm has no real `spawn_blocking`), so every
  jsonrpc call queued behind them — up to ~1s on phones for account creation,
  and seconds for a large message. The tokio facade gains a JS offload bridge
  and the four crypto call sites hand the work to a web-worker pool running
  the same wasm build, falling back to the inline path whenever the pool is
  unregistered, dead, erroring or too slow; decrypted messages are re-encoded
  at the OpenPGP packet level so core still verifies signatures itself.
  Native builds unchanged. `core/0029`

## New features

- **OpenRPC document for the JSON-RPC API** — one attribute. The
  `deltachat-jsonrpc` crate already enables yerpc's `openrpc` feature and
  every API type already derives `schemars::JsonSchema`, so the generator was
  compiled in and fully fed; `#[rpc]` just never set `openrpc_outdir`, and
  without it yerpc emits no generator at all. With it, the existing
  `cargo test -p deltachat-jsonrpc` writes `typescript/generated/openrpc.json`
  (177 methods, 40 schemas, doc comments carried through as descriptions) next
  to the TypeScript bindings it already writes there, from the same impl block.
  Nothing new lands in the tree — `generated/` is gitignored. We publish it at
  `/api-docs/openrpc.json`. Good upstream candidate: it is a one-line change
  to an unused switch, no new dependency, and native builds are unaffected.
  `core/0031`
- **Custom voice-message player controls** — play/pause
  button, seek bar, elapsed/total time and a 1×/1.5×/2× speed pill (the rate
  is global, so every voice message plays at the chosen speed) replace the
  native `<audio>` controls on voice/audio messages. The existing playback
  architecture (force-muted per-bubble mirror + global singleton, one-at-a-time
  playback, auto-advance) is untouched — the custom controls only drive the
  local element. On by default; opt out at Settings → Advanced →
  Experimental features (the switch stays there).
  Phase two adds a canvas waveform (peaks computed lazily: fetch → decode →
  64-bucket max-abs in a worker served by the web-app shell, ~4s budget,
  silent fallback to the plain bar — playback never waits on it), remembered
  per-message playback position (restored on return, cleared on natural end),
  seek positions actually carried onto the global player (scrub-before-play
  now works), a live rolling waveform in the recorder's level meter, and
  on-device User Timing profiling of peak generation surfaced in Diagnostics
  ("measure first" — no peak cache until the numbers demand it, see issue
  A2.5). Phase three upgrades the global mini-player: the same custom
  controls drive the singleton directly (waveform, time, speed), plus a
  clickable sender line (avatar + name + chat) that jumps to the message,
  and `navigator.mediaSession` wiring (lock-screen/hardware play, pause,
  seek, next = the existing auto-advance) — lock-screen metadata is
  privacy-suppressed by default, a second setting (Settings → Notifications,
  beside "show notification content" — same lock-screen exposure) opts into
  sender details (forum 5423). The final phase polishes recording:
  pause/resume that yields one contiguous MP3 (same LAME encoder, frames
  simply stop flowing while paused), preview-before-send in the same
  custom player (send / re-record / discard), press-and-hold with
  slide-left-to-cancel and slide-up-to-lock (a quick tap still toggles
  like before), and an "original audio" toggle
  (noise suppression etc. off — advisory, the UI reflects what the mic
  actually honored). A follow-up adds a microphone picker to the recording
  row (shown with multiple inputs; Jitsi-style live level on the active
  device only — no extra streams; hot-switching mid-recording keeps the MP3
  contiguous; the choice persists, with stale-device fallback) and turns the
  aborting "no input" alert into an inline non-aborting "No sound — check
  your microphone" hint after ~3s of silence, with the picker right next to
  it as the remedy. All phases of the voice-messages epic (#120);
  screenshot loop: `node scripts/shot-voice-player.mjs` (SILENT_WAV=… for
  the warning, MOBILE=1 for phone-width shots). Later refinements: bubbles
  adopt the singleton's position on remount (upstream #6378), phone-width
  layout, a two-row player (full-width waveform, time + speed below), and a
  slim under-navbar strip on the single-column mobile layout (issue #137 —
  the chat-list bar is hidden there while a chat is open; the strip stays
  visible in both views, reserves its space instead of covering content,
  and demotes the waveform to a 2px progress hairline)), and per-message
  player identity via an inert `#msg=<id>` src fragment, so a forwarded
  copy of a voice message no longer plays and auto-advances in lockstep
  with the original (peaks stay cached once per underlying file).
  `desktop/0072` – `desktop/0074`
- **Native 1:1 calls (audio, video, screen share)** — our own WebRTC peer,
  wire-compatible with real Delta Chat clients (which run
  [`deltachat/calls-webapp`](https://github.com/deltachat/calls-webapp)): raw-SDP
  offer/answer carried over DeltaChat messages, non-trickle ICE. Mic/camera
  selection with mid-call hot-switching, avatar speaking rings, mute, a
  direct-vs-relay indicator, ringtone/vibration, content-free call analytics,
  and a mobile layout. An active call runs in a detached popup window when
  allowed (falling back to an in-page overlay); ringing always stays in the main
  window. Lives mostly in our own `packages/calls` (engine/ui/bridge split) and
  `packages/web-app` wiring — see [`docs/calls.md`](docs/calls.md); the one
  upstream change is un-gating the ChatView call button and the `WhoCanCallMe`
  setting for the browser target. `desktop/0048`
- **Resumable chunked downloads with progress** — "download on demand"
  messages are fetched with IMAP partial FETCH (`BODY.PEEK[]<offset.count>`,
  mandatory RFC 3501) in adaptively-sized chunks (128 KiB doubling to 4 MiB)
  appended to a blobdir staging file: an interrupted download resumes where it
  stopped across reconnects and reloads, the download yields to new-mail
  fetching every 15 s so a big attachment no longer delays incoming messages,
  and a new `DownloadProgress` event drives a live percentage on the message
  bubble (on native platforms peak download memory also drops from
  message-size to chunk-size). Servers without working partial FETCH fall
  back to whole-message downloads with a one-time device-message notice.
  `core/0020`–`core/0021`, `desktop/0067`; plus a `Fetch::body_origin()`
  accessor in the vendored async-imap (to be proposed upstream).
- **HTML email viewer ("Show Full Message…")** — the browser edition of
  desktop's sandboxed email window: a fullscreen in-app dialog whose content
  is DOMPurify-sanitized and rendered in an iframe with an opaque no-script
  origin and its own Content-Security-Policy. Remote images (tracking pixels)
  never touch the network until the user opts in — Never / Once / Always,
  "Always" persisted as the same desktop setting upstream uses and never
  offered for contact requests. Links inside the mail are handled by the app,
  not opened raw: app links (`mailto:`, `openpgp4fpr:`, `dcaccount:`,
  `dclogin:`, `i.delta.chat` invites — desktop's `shouldHandleLinkInMainApp`
  set) run the invite/mailto flow bound to the account the mail was opened
  from (not whatever account is selected when the link is clicked), and
  `http(s)` links go through the app's safe-link path so they get the same
  tracking-parameter stripping a pasted link gets, opened `noreferrer`.
  Lives almost entirely in `packages/web-app` (`static/html-email.html`,
  `src/html-email.ts`, `openMessageHTML` in `src/runtime.ts`); guarded by
  `scripts/test-html-email.mjs` and the `scripts/test-html-email-e2e.mjs`
  end-to-end check. Two small desktop changes: enlarge the "Show Full
  Message…" tap target on touch devices (`desktop/0070`), and expose the
  frontend safe-link opener the viewer routes `http(s)` links through
  (`desktop/0071`).
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
- **Add relays from a list, contact scan, or typed domain in the Transports
  dialog** — upstream's "Add transport" only scans a QR code (now labeled
  "Scan relay QR code…" so that's obvious). A second button, "Add from relay
  list…", reuses the onboarding relay-picker dialog: the public directory
  relays (probed with live latency on open, exactly like onboarding) plus a
  new "Relays your contacts use" section — relay domains harvested locally
  from the contact list with per-relay contact counts, already-configured
  transports and directory duplicates filtered out. Contact-derived relays
  are deliberately **not** probed on open: on the web every probe goes
  through the WS bridge, so pinging that set would broadcast a digest of
  your contacts' domains to the bridge operator. A "Measure ping" button is
  the opt-in — clicking it probes those relays and re-sorts the section by
  latency (unreachable last, disabled); until then rows are listed by
  contact count and stay selectable. Picking a relay (or typing one into the
  existing "Other relay…" field) runs the same confirm-and-add flow as the
  QR path (`dcaccount:` + host); the default row preserves an operator's
  URL-form `SLOTHFUL_DEFAULT_CHATMAIL` endpoint exactly like onboarding
  does. A contact's mail domain isn't necessarily a chatmail relay — adding
  one that isn't fails loudly through the existing error alert.
  `desktop/0054`
- **Privacy-preserving link previews** — when the draft contains a URL and no
  image, the composer offers a dismissible ghost to add a preview. Accepting
  fetches the link's OpenGraph metadata (through a bridge with unfurl enabled)
  and renders it into a card image *on the sender's device*, attaching it as
  the message image — so the recipient's client never contacts the link (no
  IP/metadata leak) and every client renders an ordinary text+image message.
  Layout (compact vs large hero) follows the site's metadata and is toggleable
  on the draft; off by default (experimental), enableable in Settings → Advanced.
  `desktop/0041`

- **Composer completion menu (`:emoji:`)** — typing a colon shortcode plus two
  characters opens a scrollable, keyboard-navigable menu above the composer
  (↑/↓ to move, Enter to pick, Esc to dismiss) that inserts the Unicode emoji.
  Matches shortcode, name and keywords over the already-bundled
  `@emoji-mart/data` (no new dependency); a boundary guard keeps it from firing
  inside `http://` or `12:30`. Built as a generic `CompletionProvider` primitive
  so a future `@mention` menu reuses the same machinery. On by default,
  switchable off in Settings → Experimental features. `desktop/0050`,
  `desktop/0051`, `desktop/0061`

- **Emoji style picker** — an "Emoji style" picker under Settings →
  Appearance (browser edition only) chooses which emoji font the app renders
  with, previewing each set in its own face; the emoji-mart composer picker
  follows the choice too, which needs overriding the font-family emoji-mart
  hardcodes inline inside its shadow DOM. The catalogue itself lives in our
  own `packages/web-app/src/emoji-sets.ts` and reaches the frontend through
  the `window.__slothfulchatEmoji` runtime hook, so Electron — which never
  sets that global — renders no picker at all. Alongside it, the bundled
  `@emoji-mart/data` (~Unicode 15) is extended with a generated supplement
  (from emojibase-data, see `scripts/build-emoji-supplement.mjs`) so both the
  picker and the `:emoji:` completion can find newer emoji such as 🪎; the
  base dataset is untouched and the supplement's versions are capped at 15 so
  emoji-mart's own version filter doesn't hide them. `desktop/0065`,
  `desktop/0066`

- **Translation editor in the keyboard-shortcuts cheat sheet** — lists the
  in-app translation editor (`Ctrl/Cmd+Shift+L`, implemented in `web-app`'s
  `runtime.ts`) in the shortcuts dialog so it's discoverable. One entry in
  `getKeybindings`. `desktop/0052`

- **Estimated time-to-read on the unread badge (experimental)** — the chat
  list can show roughly how long a chat's unread messages take to read
  ("~4 min") next to the unread counter: word count at 200 wpm plus a flat
  cost per media message, voice messages by their duration. Only a capped
  window of the newest messages is fetched (scaled up and shown as "10+ min"
  beyond it), cached per chat on the fresh-message counter. Off by default,
  Settings → Advanced → Experimental features. `desktop/0053`

- **Tracking-parameter removal from links** — known trackers (`utm_*`,
  `fbclid`/`gclid` click ids, YouTube `si=`, Instagram `igsh=`, X `s=`/`t=`,
  Spotify `si=`, Amazon affiliate refs) are stripped from an allowlist, never
  "all query params". Two automatic intervention points: clicked links are
  cleaned silently before opening, and pasting a link with tracking rewrites
  the draft and shows an undoable "Tracking removed from link" chip in the
  composer (same slot as the link-preview ghost). One switch in Settings →
  Chats and Media, on by default. `desktop/0055`

- **Invite links render as cards** — an `https://i.delta.chat/#…` invite link
  in a message becomes a compact card (letter avatar, "Group/Channel/Contact
  invitation" label, decoded name, View button) instead of the raw fingerprint
  URL. The name is parsed from the URL fragment alone — deliberately not via
  core's `checkQr`, which would create a hidden contact as a side effect —
  so it is sender-controlled and cosmetic; clicking still opens the usual
  join/chat confirmation dialog, and unparseable fragments fall back to a
  plain link. `desktop/0060`

- **Unread-only filter in the chat list** — a filter toggle next to the chat
  list search shows only chats with unread messages, via core's `is:unread`
  chatlist query (also composed with typed search text). The toggle filters
  the plain list without switching into search-results mode, with an
  "Unread: N chats" heading (mirroring search-in-chat) as a reminder that the
  filter is active; the archive view is unaffected. `desktop/0063`

- **Resizable chat-list sidebar** — a drag handle between the chat list and
  the chat view sets an explicit sidebar width (clamped so both panes stay
  usable), persisted per device in localStorage. Double-click resets to the
  default 3:8 split; the handle is a keyboard-operable separator
  (ArrowLeft/ArrowRight, RTL-aware) and is absent in the single-pane
  small-screen layout. `desktop/0064`

- **Rich download-on-demand placeholders** — large attachments in encrypted
  chats arrive as a placeholder before the real message; upstream shows a plain
  "text [Image – 228 KiB] - Download" line. The pre-message metadata now carries
  the real MIME type and a small blurred thumbnail preview, and the placeholder
  renders as a styled per-type card (image/video/audio/file/webxdc) with the
  attachment size, the live download percentage, and a big download button.
  Videos get a preview too: core can't decode frames (its wasm has no DOM), so
  the sender grabs one with `<video>` + canvas when the video is attached and
  drops it in the `<blob>-preview.jpg` sidecar that core's housekeeping already
  keeps alive — the same slot the mobile clients use, so no new param and no
  storage of its own. The video card labels itself "Video · 0:23" rather than
  showing a play glyph, which would offer a click that cannot do anything until
  the attachment is downloaded. `core/0022-0023`, `desktop/0068-0069`

- **Length and size of the media we send** — core measures images itself, but it
  has no audio or video decoder, so nothing ever set `Param::Duration` on an
  outgoing message and no message we sent carried a `Chat-Duration` header: our
  own placeholders (above) rendered "–:––" for our own voice messages, and so
  did every other client. `MessageData` grew optional `width`/`height`/
  `duration`, and the send path fills them in from a `<video>` element, which
  reads audio files just as well. It hangs off `sendMessage` rather than off the
  draft because the composer does not send its draft — it rebuilds a fresh
  `MessageData` from the draft state, so anything stored on the draft would be
  dropped. `core/0028`, `desktop/0077`

- **The all-media gallery says which chat an app came from** — the Apps tab of
  "All Media" mixes webxdc apps from every chat, and nothing in a row said
  where an app came from; the only way to find out was the context menu's
  "Show in chat". Each row now carries its chat twice: the chat avatar badged
  onto the corner of the app icon (the same construction the chat list uses
  for message search results), and the chat name ahead of the app's own
  summary. Only in the global gallery — per-chat galleries would just repeat
  the chat you are already in. `desktop/0075`

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
- The drag image when reordering profiles in the sidebar included the white
  active/hover indicator bar; its color is blanked for the duration of the
  dragstart snapshot. `desktop/0062`
- webimap: the connectivity badge no longer sticks at "Connecting…" /
  "Updating…", and a message that 404s on fetch/delete is treated as
  already-consumed instead of putting the poll loop into an error backoff.
  `core/0012`, `core/0013`
- Right-clicking a chat in the chat list showed the browser's own context
  menu on top of the app's: the chat-list handler awaited `getFullChatById`
  before calling `preventDefault`, so it fired too late for the web build
  (Electron has no native menu, so upstream never saw it). `preventDefault`
  now runs synchronously before the await. `desktop/0036`
- Receiving a message from a contact left that contact's 1:1 chatlist item
  stale: becoming "recently seen" updates the item's indicator, but the event
  that tells the UI to re-render it was only emitted for the reverse
  (un-seen) transition. A message arriving in a shared group therefore never
  refreshed the sender's 1:1 item; the into-seen transition now emits the
  chatlist-item event too, mirroring the un-seen path. `core/0017`
- Switching the UI language left already-rendered text stale until a reload:
  `setStockStrings` updated the shared core stock strings but emitted no
  events, so cached chatlist message summaries, the self/device contact
  names and the connectivity view kept the old language. A new
  `stock_str::emit_events_for_updated_stock_strings()` is now called once
  for the selected account after the strings change, emitting
  `ChatlistItemChanged`, `ContactsChanged` (SELF and DEVICE) and
  `ConnectivityChanged` so the UI refetches automatically. Backport of the
  closed chatmail/core#7719 by Simon Laux / deltachat-desktop#5403 (the
  upstream import hunk was de-duplicated and the call site adapted to the
  pinned core). `core/0018`
- The profile-deletion screen showed "?" instead of the account's storage
  size: `get_account_file_size` sized the database with `std::fs`
  (`get_dbfile().metadata()`) and the blobdir with `walkdir`, both unsupported
  on wasm (the database is a sqlite-VFS file with no real path), so the RPC
  errored. A new `storage_usage::get_account_size` sizes the database
  logically (`page_size * page_count`) and sums the blobdir via `tokio::fs`;
  the RPC uses it on wasm, native path unchanged. `core/0019`
- Marking the archived-chats list as noticed didn't refresh its chatlist item
  (unread badge) until something else re-rendered it, and marking a single
  chat noticed while archived double-emitted the archived-list event.
  `on_archived_chats_maybe_noticed` now also emits `ChatlistItemChanged`, and
  `marknoticed_chat` skips the redundant call for the archived-link itself.
  Backport of upstream chatmail/core#7721. `core/0025`
- Setup-contact secure-join left the new 1:1 chat's composer stuck showing
  "can't send" after the handshake finished: `can_send` flipped in the
  database but no `ChatModified` event told the UI to re-check it (broadcast
  joins already worked, since a broadcast's `can_send` doesn't depend on the
  handshake). Backport of upstream chatmail/core#7735. `core/0026`, `core/0027`

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
- The chat title-bar icon buttons (apps, map, three-dot menu) had a cramped
  20×20 px hit box in a 50 px-tall navbar with an unclickable 12 px gap
  between them; each button's click target now fills that vertical dead space
  and the gap. Compensating negative margins keep the icons and navbar height
  pixel-for-pixel unchanged. `desktop/0047`
- Webxdc last-used-app icons in the chat title bar (app-supplied, untrusted
  images) render on an opaque white tile, so a transparent icon can't blend
  into the navbar to impersonate a native control; their hit target stays
  icon-sized, unlike the enlarged native buttons. `desktop/0049`

- On wide screens (≥800px) Settings opens as a single two-pane dialog —
  navigation sidebar on the left, the selected section on the right, like
  Discord or macOS System Settings — instead of stacked dialogs; narrow
  viewports keep the stacked flow. `desktop/0056`
- Experimental features moved out of Advanced into their own settings
  section, grouped under Composer / Chats / System sub-headings.
  `desktop/0057`, `desktop/0059`
- Settings that only exist in this fork are marked with a small sloth
  badge (tooltip explains it's not an upstream Delta Chat setting).
  `desktop/0058`

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
- **Device chat** — core's welcome image is Delta Chat branding, so it is
  dropped until we have our own (the `core-welcome-image` label is untouched,
  so adding one later is the same code with a different file). After core's
  welcome message the app adds one of its own: what the fork does differently,
  that everything lives in this browser and should be backed up (unencrypted),
  that it's a prototyping ground, and where to report bugs / self-host.
  `core/0030`, `desktop/0078`
- **Hidden upstream UI that can't work in this build** — proxy settings
  (unimplemented on wasm), the second-device / multi-device backup
  transfer flow (iroh doesn't run in browsers yet), and the experimental
  "Enable Webxdc Devtools" switch (it only toggles Electron's DevTools on a
  webxdc iframe — a browser's built-in dev tools can't be gated by the app,
  and webxdc apps don't run in this build anyway). `desktop/0001`,
  `desktop/0014`, `desktop/0040`
- **Long message text is stored in full** — core truncates message text to
  38 lines × 100 chars when writing `msgs.txt`, stashing the full body in
  `mime_headers` so a UI can re-offer it as an HTML message; that stores
  every long body twice and leaves it uneditable ("Cannot edit HTML
  messages"). We drop the truncation from both write paths and clamp the
  text visually instead — CSS line-clamp plus a Show more/less toggle — so
  copy, in-page search and link parsing all see the whole body. The previews
  that used to lean on the write-time bound (summaries, quotes, chatlist
  items, notifications, search hits) now bound themselves. The schema is
  unchanged and rows written by official core are never rewritten, so
  messages already in a database keep their truncated text and still open in
  the HTML viewer. `core/0024`, `desktop/0076`
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
- **Database encryption (sqlcipher)** — doesn't build for wasm32; OPFS
  storage is origin-sandboxed by the browser instead.

Like ArcaneChat, this fork experiments a few steps ahead of upstream Delta
Chat while staying protocol-compatible with it; where ArcaneChat (or a
closed upstream PR) already designed something well, planned features borrow
that shape — e.g. the map POI API (#36) and per-account disabling modeled on
chatmail/core#5314 (#37).
