# Changelog

- **The bridge picker can no longer get stuck behind the welcome screen.** Open
  it while the app was still starting up and it could end up underneath the
  screen that appeared a moment later: greyed out, none of its buttons
  clickable and no way to close it. Our dialogs now move back to the front when
  something else opens on top of them.

- **Reporting a failed start is now one tap.** If the app can't start, the
  error screen has always shown the technical details and let you copy them —
  it now also offers to send them, prefilled, wherever the instance you use has
  said reports should go, and says what each destination costs you before you
  pick. The report now carries the error's stack and which site it came from,
  which is what makes a crash diagnosable.

- **An update caught mid-deploy no longer installs half of it.** The app checks
  each downloaded file against the checksum its release lists, so a deploy that
  is still being written out — or a CDN that answers one file from a stale copy
  — leaves the working version in place and retries, instead of pinning a
  mixture of two releases into the offline cache until the next one.

- **Adding a profile is no longer a second-and-a-half wait.** Every new profile
  built its database from scratch, step by step; it is now stamped out of a
  ready-made one, which is most of that time gone — including for the very
  first profile you create.

- **A chat engine that crashes now says so instead of spinning forever.** If
  the engine died after startup, everything the app had asked it to do simply
  waited for an answer that was never coming — an endless spinner with no error
  and no way out. The failure is now reported straight away, with a dialog that
  offers a reload.

- **The link-preview offer in the composer now looks like one thing.** The
  placeholder, the loading state and the "needs a bridge" notice used to look
  like three unrelated widgets; they are now the same card that fills in — the
  skeleton shimmers while the preview is generated and greys out when previews
  are unavailable.

- **The privacy policy now says who actually receives the usage statistics.**
  When an instance runs its own Plausible server instead of the hosted service,
  the policy says so and names that server, rather than implying the data goes
  to Plausible the company.

- **The installed app no longer offers to open every binary file on Linux.** It
  registered for webxdc apps under a catch-all file type, so the desktop listed
  it as a way to open any unknown file. It now registers `.xdc` files under
  their own type, which also makes "Open with" work for webxdc archives your
  desktop didn't recognize before.

- **Long-press menus now work on phones.** Holding a chat, a message, a photo
  or a profile is how every menu opens on mobile, and it was broken across the
  board: on Android, some elements started an invisible drag instead of
  opening their menu; on iPhones no menu could open at all — iOS doesn't tell
  web pages about long presses, and the press selected the text under your
  finger on top. The app now watches the press itself, everywhere. Selecting
  message text still works: press the text to select it, and the bubble
  around it for the menu.

- **Profiles can be reordered on a phone.** Press a profile in the account
  sidebar, wait for it to lift, then drag it where you want it — flicking still
  scrolls the list and a plain long press still opens the profile menu.

- **A half-downloaded update can no longer cost you the offline app.** If a
  file of a new version fails to download, the app now stays on the version
  you have — which still works offline — and retries later, instead of
  switching to the incomplete one and dropping the complete copy. And if the
  same update keeps failing, a message in the device chat tells you, including
  which file is stuck.

- **An account that failed to update now says so.** When a new version can't
  finish updating an account's database, the account still opens — but chatting
  with it can produce wrong contacts or messages. The app now checks after
  opening and posts a one-off message in that account's device chat: what
  happened, the error text, and a reminder to export a backup while you still
  can.

- **You can copy the text of several messages at once.** Select more than one
  message and the context menu now offers "Copy Text" next to Forward and
  Delete, or just press Ctrl/Cmd + C — the bodies land on the clipboard one
  per line, oldest first, no matter which order you clicked them in. Messages
  that are only a sticker or an attachment are left out.

- **Hardening**: bumped DOMPurify (used to sanitize HTML email before display)
  to 3.4.13, which fixes a DOM-clobbering issue in the sanitizer's own setup
  logic.

- **A voice message you haven't downloaded yet now looks like the player it's
  about to become.** With the experimental audio player switched on, the
  waiting card kept the old bar's shape and visibly changed layout the moment
  the download finished; it now shows the same two-row waveform layout.

- **The app now refuses to run inside another site's frame.** Static hosts like
  GitHub Pages can't send the header that normally forbids this, so a hostile
  page could embed the app invisibly and trick you into clicking things in it.
  The app now detects that and blanks itself instead; the HTML-mail viewer it
  embeds in its own window keeps working. A real webserver's headers are still
  the stronger protection — self-hosters have had those all along.

- **Hardening**: the offline cache now keeps to itself. It only deletes caches
  it created (anything else hosted on the same domain used to be wiped along
  with them) and only stores the app's own files, so a service sitting next to
  the app on that domain can't end up cached — or answered from the cache.

- **The core's JSON-RPC API is now documented at `/api-docs`** — a TypeScript
  reference and a browsable OpenRPC spec (raw `openrpc.json` included), both
  built from the exact core the bundle ships (pinned version plus our patches),
  so they describe the API that is actually running rather than the closest
  published release. Self-hosters get it with the bundle; it is not part of the
  offline app shell.

- **`/api-docs` says which parts of the API are ours.** Every method, type and
  field our patches added or changed now carries a 🦥 note naming the patch, so
  you can tell at a glance whether something you are calling exists upstream or
  only here.

- **A link can no longer start a session that quietly saves nothing.** The
  `?persist=0` test switch made the app run memory-only — your accounts appear
  missing and anything you set up or receive is lost when the tab closes. It
  now has to be confirmed before anything starts, and such a session runs with
  a yellow navbar so you can tell at a glance.

- **HTML emails open again on phones and installed PWAs of self-hosted
  instances.** The webserver config forbade framing the app's own pages, which
  also blocked the HTML-mail viewer the mobile layout embeds; only that one
  page is now allowed to be framed, and only by the app itself.

- **Links into the changelog keep working across releases** — a link to a
  specific version used to slide down to the wrong one as soon as the next
  release shipped, because it pointed at a position in the page rather than at
  the version. Anchors now carry the version itself (`#v-0.8.0`).

- **Hardening**: a file that is far too big to fit in the browser — one you
  pick or drop, or one a corrupt/crafted backup claims to contain — is now
  refused with an error instead of taking the app down with it.

- **Backup files no longer linger in browser storage.** An exported backup is
  deleted once the download has it, and a backup file you imported is removed
  when the import ends; anything older is cleaned up at startup. Until now an
  ordinary export left a second, unencrypted copy of your whole account in the
  browser's storage indefinitely.

- **Hardening**: the internal address the app uses to fetch attachments now
  refuses to point anywhere outside the attachment folder. No known way to
  trigger it from a message — the other layers around attachments already
  blocked that — but the check belongs there and its siblings already had it.

- **When the app can't start, you can now copy the error.** The failure screen
  shows the technical details as selectable text with a "Copy details" button,
  so you can paste them into a bug report instead of retyping them from a
  screenshot.

- **Lockdown Mode is named as the cause it usually is**: if your browser has
  WebAssembly switched off, the app now says so and explains how to allow just
  this site, instead of reporting a storage problem you don't have.

- **A welcome message that's actually about this app** — the device chat now
  explains what SlothfulChat does differently: it runs entirely in your
  browser, which is also why you should export a backup and keep it safe
  (backups are unencrypted). Delta Chat's welcome image is gone until we have
  one of our own.

- **Voice messages and videos you send now carry their length** — the person
  receiving one sees how long it is (and how tall a video is) straight away,
  instead of a "–:––" placeholder they have to download first. Works with every
  Delta Chat client, since it travels in the standard `Chat-Duration` header.

- **Apps in "All Media" say which chat they came from**: in the global gallery
  the Apps tab now shows each app's chat — its avatar badged onto the app icon
  and its name in front of the app's own status line. Per-chat galleries are
  unchanged.

- **Custom voice-message player** — voice and audio messages
  get proper controls: play/pause, a waveform you can click to seek (with a
  plain seek bar as fallback), elapsed time, and a playback-speed pill
  (1×/1.5×/2×, applies to all voice messages). Half-listened messages resume
  where you left off. The mini-player that keeps playing while you switch
  chats gets the same controls plus the sender's name — click it to jump back
  to the message — and your lock screen / headset buttons control playback
  (without showing who sent the message, unless you opt in). Recording is
  polished too: pause and resume while recording, listen to your recording
  before sending it (send, re-record or discard), hold the mic and slide up
  to record hands-free or slide left to cancel, and an "original audio"
  option that skips noise suppression for music or ambience. If you have
  several microphones you can pick one right in the recorder (with a live
  level meter), even mid-recording — and if no sound is coming in, an inline
  hint says so instead of cancelling your recording. On by default now —
  turn it off in Settings → Advanced → Experimental features if it gives
  you trouble. The setting for showing sender and chat details in the
  system media controls has moved to Settings → Notifications, next to
  "show notification content" (it is the same lock-screen question). On
  phone-sized screens the playing voice message shows as a slim bar pinned
  under the top bar — visible inside the chat too, with play/pause, the
  sender (tap to jump to the message), speed and a thin progress line.

- **Voice-message position stays in sync**: switching profiles or chats while
  a voice message plays no longer resets the message's displayed position to
  0:00 — it picks up where the audio actually is. The recorder also fits
  phone-sized windows now instead of pushing its buttons off-screen.

- **Privacy**: on instances with usage statistics enabled, no statistics event
  of any kind leaves the app before the welcome screen has shown you the opt-out
  checkbox. A few startup events (which bridge you connect through, startup
  errors) still slipped out ahead of it. Once you have seen that notice, later
  visits report as before — including a visit where the app fails to start.
- **Security**: a link can no longer silently route your traffic through
  someone else's bridge. A `?proxy=` in the page URL that isn't one this
  instance offers, one you already picked, or one on your own machine is now
  ignored until you confirm it — the app keeps using its usual bridge and shows
  you which bridge the link wanted, and what it would learn about you.
- **Security**: a link you open from the app can no longer reach back and
  navigate SlothfulChat away to somewhere else — a favourite trick for pointing
  you at a fake login page. Self-hosted setups using the shipped Caddy config
  also now refuse to be embedded in other people's pages.
- **Security**: opening a received attachment can no longer run its code as
  part of the app. A scripted SVG sent to you could reach your local app data;
  attachments now open isolated, and images, video and audio still display
  inline as before.
- **Answering a call no longer turns your camera on by itself.** An incoming
  call now offers **Accept** (audio only) and **Accept with video**, so the
  person calling you can't decide whether your camera starts. You can still
  switch the camera on at any point once the call is connected.
- Large videos now show a preview frame while they are still waiting to be
  downloaded: the poster is grabbed from the video when you attach it, so the
  recipient sees what is coming before spending the bandwidth.
- Downloading a big message now shows a live percentage on the message bubble,
  and an interrupted download continues where it stopped.
- **Long messages are no longer cut off**: message text used to be trimmed to
  38 lines when it was saved, with the rest tucked away behind "Show Full
  Message" — which also made long messages uneditable. The full text is now
  kept as written: long messages get a "Show more"/"Show less" toggle, stay
  editable, and are searchable and copyable in full. Messages already stored
  on your device are left as they are.
- **"Show Full Message…" now works**: HTML emails open in a sandboxed viewer.
  Scripts in the mail are stripped and can never run, and remote images stay
  blocked — no tracking pixels — until you allow them (Never / Once / Always;
  "Always" is remembered, and not offered for message requests). Email
  addresses and Delta Chat invite links inside a mail open right in the app
  (new chat / invite dialog, on the account the mail belongs to) instead of
  leaving it, and ordinary web links get the same tracking-parameter
  stripping as links in a chat.
- **Chat export works again**: the `index.html` viewer inside exported chat
  zips threw a script error and showed an empty page; exports now render
  correctly again.
- **Newest emoji everywhere**: the emoji picker and the composer `:emoji:`
  completion now include Unicode 16 and 17 emoji (e.g. 🪎 treasure chest), so
  you can search for and insert the latest ones. The composer completion is
  also correctly on by default in the browser edition again.
- **Resizable chat list**: drag the divider between the chat list and the
  chat view to set your own sidebar width — it sticks across reloads on this
  device. Double-click the divider to go back to the default split.
- **Choose your emoji style** (Settings → Appearance): pick between Standard
  (your device’s own emoji on Apple, Google Noto Color elsewhere), Google Noto
  Color, Google Noto black & white, Twemoji, or Full native (whatever your
  system provides). Each option shows a live preview, and only the set you
  actually pick is ever downloaded. This also fixes Firefox showing a broken
  emoji font and logging a "font rejected by sanitizer" error on every load.
- **Restored data is verified as saved**: after restoring from a backup or
  receiving a transfer from another device, the app now warns instead of
  silently reporting success if some of it didn't make it into persistent
  storage (e.g. the disk filled mid-restore), so you're not left thinking a
  restore completed when part of it is missing. Part of a broader hardening of
  account storage against loss — see the core-wasm changelog.

## 0.8.0 — 2026-07-24

- **Your data is now kept safe from browser eviction**: once you have an
  account, the app asks the browser to store its data persistently, so it
  won't be wiped to reclaim disk space when the disk runs low. The Diagnostics
  panel (Log dialog → Diagnostics) gained a Storage section showing whether
  storage is persistent, how much is used, and a button to request it — and
  the panel now opens full-screen and scrolls properly on phones.
- Dragging a profile to reorder the sidebar no longer shows the white
  "selected" indicator in the drag preview.
- **Unread filter in the chat list**: a filter button next to the search box
  shows only chats with unread messages — an "Unread" heading reminds you the
  filter is on, and tapping again shows everything. Works together with a
  typed search.
- **Groundwork for webxdc mini-apps**: the release zip now ships ready-made
  Caddy config (`dist/caddy/`) so self-hosters can set up the wildcard
  subdomain webxdc will need — see the new webxdc section in SELFHOSTING.md.
  Nothing changes in the app yet; without the subdomain it will simply report
  webxdc as unsupported.

## 0.7.0 — 2026-07-20

- **Settings open as one two-pane window** on wide screens (≥800px):
  navigation on the left, the selected section on the right, instead of a
  stack of dialogs. Narrow viewports keep the stacked flow. Experimental
  features now live in their own settings section, and settings that only
  exist in this fork are marked with a small sloth badge.

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
