# webxdc in SlothfulChat

[webxdc](https://webxdc.org) apps are little HTML/JS bundles (a `.xdc` file is
just a zip) that run inside a chat and sync state over the messages themselves.
Running untrusted third-party code next to a messenger means one thing above
all: **each app must be its own origin**, so the browser's same-origin policy
does the isolation for us. This document explains how we get one origin per app
out of plain DNS and TLS, why the server config ships inside the release
bundle, how storage and deletion work, and what is still left to build. It is
the reference for developing the feature over the coming weeks; the operator's
quick start lives in [SELFHOSTING.md](SELFHOSTING.md).

The important framing up front: **webxdc is optional, and the webserver only
ever serves static files.** A plain static host (GitHub Pages, `serve.mjs`, an
S3 bucket) keeps working exactly as today — the app detects that webxdc origins
aren't configured and reports webxdc as unsupported. Turning it on is a DNS
record and a Caddy that terminates TLS for a wildcard; nothing more.

**Status:** apps run (issue #2), realtime channels included. The app side is
`packages/web-app/src/webxdc.ts` (+ `static/webxdc-window.html`, a desktop
app's own window); what each webxdc origin serves is `src/webxdc-host.ts` +
`src/webxdc-sw.ts` (+ `static/webxdc-host.html`); the pure rules both sides
share (naming, CSP, paths) are `src/webxdc-origin.ts`. Locally, plain
`pnpm serve` already serves webxdc origins at
`http://<slug>.webxdc.localhost:8642` — no Caddy needed.

## Architecture

### Why per-app origin isolation

A webxdc app is arbitrary code from whoever sent the message. If two apps — or
an app and the main SlothfulChat UI — shared an origin, one could read the
other's `localStorage`, IndexedDB, cookies and service worker, and script the
other's DOM. The browser already has a hardened boundary for exactly this: the
**same-origin policy**. The cheapest correct isolation is therefore to give
each app a distinct origin and let the platform enforce the wall, rather than
inventing a sandbox in application code.

"Distinct origin" means distinct scheme + host + port. We vary the host: every
app slug gets its own subdomain.

### The naming rule

There is exactly one rule, and it takes zero app configuration:

```
https://<slug>.webxdc.<app-host>
```

`<app-host>` is wherever the main app is served from; `<slug>` identifies the
app **instance** — one per account and message, like Electron's
`webxdc://{account}.{msg}.webxdc`: two copies of the same app in two chats
must not share state either. The same rule produces the right origin in every environment, so the app
never needs a per-environment setting for where webxdc lives — it derives the
origin from its own `location.host`:

| Environment  | App host                        | Example webxdc origin                          |
|--------------|---------------------------------|------------------------------------------------|
| prod         | `web.slothful.chat`             | `https://calc.webxdc.web.slothful.chat`        |
| next (main)  | `next.slothful.chat`            | `https://calc.webxdc.next.slothful.chat`       |
| PR preview   | `pr-123.preview.slothful.chat`  | `https://calc.webxdc.pr-123.preview.slothful.chat` |
| self-hoster  | `chat.example.com`              | `https://calc.webxdc.chat.example.com`         |
| local dev    | `app.localhost:8642`            | `http://calc.webxdc.app.localhost:8642`        |

**Slug constraints.** Slugs are `[a-z0-9]` only and must fit in a single 63-char
DNS label. Lowercase because DNS is case-insensitive and origins are not; the
restricted alphabet keeps slugs safe as both a DNS label and an origin
component. In practice a slug is a short hash/id of the app, well under 63
characters — the label limit is the hard ceiling, not the target.

**The slug is `<salt>m<msgId>`**, where `salt` is 12 random `[a-z0-9]`
characters minted per account on first use and kept in that account's own
config (`ui.slothfulchat.webxdc_salt`). Message ids never repeat within an
account database, but the *database* can start over: a fresh account that gets
id 1 again after the old profile was wiped, or a throwaway `?persist=0`
session. Without the salt, such a restart would land a new app on an origin
still holding some older app's storage. With it, origins live exactly as long
as the account they belong to.

### Runtime support probe

The app decides at runtime whether webxdc origins are reachable, because the
same static build runs both on hosts that have the wildcard configured and on
hosts that don't. There is no separate probe request: opening an app *is* the
probe. The bootstrap page posts `hello` to its parent as soon as its script
runs; a frame that finishes loading without one is not ours (no DNS record, no
cert, a plain static host answering 404) and the app shows "webxdc apps are not
available here" instead of a broken window — or "you are offline" when the
browser says so. No `SLOTHFUL_*` variable turns webxdc on or off, the
environment does. A fetch-based probe would also have needed CORS on the
webxdc origin and a `connect-src` entry in `main.html`; the handshake needs
neither.

### Content flow

The webserver never sees a `.xdc` file. A webxdc origin has exactly three files
of its own — `/webxdc-host.html`, `/webxdc-host.js`, `/webxdc-sw.js` — and
answers 404 for everything else; the chat app's own files are not reachable
there at all. The actual app bytes flow like this:

1. The user taps **Start**. The app (on `<app-host>`) reads the `.xdc` from the
   core's memfs, unzips it (fflate) and adds its own `webxdc.js` — the API
   object, adapted from upstream's Electron preload, with `selfAddr`,
   `selfName` and friends baked in as JSON.
2. It opens a window (see "Where an app runs") with a sandboxed iframe at
   `https://<slug>.webxdc.<app-host>/webxdc-host.html`.
3. The bootstrap page says `hello`; the app posts
   `{type: 'open', files, entry}` (buffers transferred, not copied).
4. The bootstrap page registers the service worker, empties the Cache API
   bucket, writes the files into it, and navigates its own frame to the entry
   (`/index.html`, or the place an info message's `href` points to — only its
   path, query and fragment are ever used).
5. From then on the frame **is** the app. Its service worker serves every
   request on the origin from the cache, building each response itself with the
   app CSP. Its `webxdc.js` talks to the app over `postMessage`, and the app
   answers against the core (`getWebxdcStatusUpdates`,
   `sendWebxdcStatusUpdate`, the frontend's send-to-chat picker) — the job
   Electron's main process does over IPC. Core events (`WebxdcStatusUpdate`,
   `MsgsChanged`, `WebxdcInstanceDeleted`) reach the open app the same way.

Every reopen replaces the whole cached copy, and the app's own reloads keep
working while it is open. This keeps the server dumb (static files, no per-app
state, no uploads) while still giving every app a real, isolated,
service-worker-backed origin.

### Where an app runs

- **Desktop** (a fine pointer, not iOS): a browser window of its own.
  `static/webxdc-window.html` is a script-less page on the chat app's origin
  that the chat app opens with `window.open` and fills from its side — the
  sandboxed frame, title, icon and the same `frame-src` pin as `main.html`. An
  installed PWA shows it as an app window, a browser as a popup. The chat app
  still does all the talking: it listens for the app's messages on that window,
  and closes every app window when it goes itself (they have no one else to
  talk to).
- **Phones and tablets**, and wherever the browser refuses a window (Safari
  after our awaits, a popup blocker): a window floating in the page, full
  screen below 600px. A floating app owns a history entry, so Android's back
  gesture or the browser's back button closes the app, not the chat. On iOS
  the keyboard covers fixed elements instead of resizing them;
  `viewport-keyboard.js` publishes the visible height (`--sc-vvh`) and a
  full-screen app follows it. iOS never gets windows: there `window.open` hands
  the page to an in-app browser, which is no window of ours.

**Links** in an app: its own pages navigate as usual. Anything else — the
frame could only show this origin, and `mailto:` and friends would replace
the app with an error page — `webxdc.js` hands to the chat app: `mailto:`,
`openpgp4fpr:` and invite links go to the flows the chat uses for them (which
ask for themselves); a web link is shown and asked about first, because
whatever the app put in it reaches that site.

**Saving on close.** Apps save in `pagehide`, `visibilitychange` or `unload`
(the Editor does, in `beforeunload`). A removed frame's messages never arrive,
so a floating app is unloaded first — its frame goes to `about:blank` while
still attached — and only then removed; a message from a page on its way out
comes without a source, so the bridge goes by its origin, which names exactly
one instance. In an app window the user closes, only `beforeunload` gets
through: the window and its frame go together (Electron has the same
property). `scripts/test-webxdc-store-apps-e2e.mjs` counts what arrives.

### Realtime channels

`joinRealtimeChannel` works: `webxdc.js` → the bridge →
`sendWebxdcRealtimeAdvertisement` / `sendWebxdcRealtimeData` /
`leaveWebxdcRealtime`, and core's `WebxdcRealtimeData` events back into the
app (bytes, as `Uint8Array`). Core runs iroh unmodified on wasm; in a browser
iroh is relay-only — a WebSocket to an iroh relay, no direct UDP — which is
fine for realtime, whose peers usually sit behind NAT anyway.

Which relay: the account's `iroh_relay` config if set (core/1027), else the one
the chatmail server advertises in IMAP METADATA, else n0's public relays.
Webimap accounts have no METADATA, so they use n0's unless `iroh_relay` names
one. A relay must be `https:` — the browser refuses plain `http:` from an
`https:` app as mixed content (madmail's default relay is `http://<ip>:3340`).
The relay is chosen at the account's first realtime call of the session.

Measured offline (`scripts/test-webxdc-realtime-e2e.mjs`, local relay, two
accounts in one tab, loopback): the channel joins about 0.6 s after the second
app opens; app-to-app round trips (app → bridge → core → relay → core → bridge
→ app and back) median 92 ms, p95 97 ms. The store's Realtime Check app shows
pings of about 66 ms. Two upstream behaviours to know: what is sent before the
swarm forms is dropped (realtime is best effort by design), and two peers
advertising at the very same moment can each drop the other's connection in
iroh-gossip 0.35 — reopening the app recovers.

## DNS and TLS: multi-label vs one-label

This distinction is repeatedly mis-remembered, so it is written down once here.

**DNS wildcards match multiple labels.** Per [RFC 4592](https://www.rfc-editor.org/rfc/rfc4592),
a wildcard `*.preview.slothful.chat` A record answers for *any* name ending in
`.preview.slothful.chat`, however many labels deep. So a single record covers
both:

- `pr-123.preview.slothful.chat` (the preview app host), and
- `calc.webxdc.pr-123.preview.slothful.chat` (a webxdc origin two labels below it).

One A record, all the webxdc origins for every PR, for free. Same story for a
self-hoster: `*.webxdc.example.com` resolves `calc.webxdc.example.com`,
`chess.webxdc.example.com`, and so on with one record.

**TLS wildcard certs match exactly one label.** Per [RFC 6125](https://www.rfc-editor.org/rfc/rfc6125),
a wildcard certificate for `*.webxdc.example.com` is valid for
`calc.webxdc.example.com` but **not** for `deep.calc.webxdc.example.com` — the
`*` stands for a single label only. This is why DNS is cheap (one record covers
the whole tree) but certificates are the real per-deployment cost (you need a
cert per wildcard level you actually serve).

For previews this makes the cert the unit of cost. Each new PR needs roughly two
certs via DNS-01: one for `pr-<n>.preview…` (the app) and one for
`*.webxdc.pr-<n>.preview…` (its webxdc origins). Let's Encrypt's budget is 50
certs/week/registered-domain; certs persist across pushes to the same PR (you
pay once per PR, not once per commit), and Caddy automatically falls back to
ZeroSSL if the LE bucket is exhausted. In normal PR throughput this is a
non-issue; the escape hatch below exists only if it ever becomes one.

**Two caveats that bite in practice:**

- **Shadowing.** An explicit DNS record placed *at* `pr-N.preview.slothful.chat`
  would shadow the wildcard for everything below it — the wildcard stops
  answering for names under a name that has its own explicit record. So do not
  create per-PR A records; rely on the one `*.preview.slothful.chat` wildcard and
  let it cover both the app host and the webxdc origins beneath it.
- **Cloudflare grey-cloud.** Cloudflare's proxied ("orange-cloud") wildcards are
  one level only (Universal SSL), and proxying would also mean Cloudflare, not
  Caddy, terminates TLS. Since Caddy terminates TLS and obtains the multi-level
  certs itself, these records **must stay DNS-only (grey-cloud)**. An
  orange-clouded wildcard here breaks both the multi-label coverage and the
  cert story.

### Escape hatch (documented, not built)

If per-PR cert limits ever actually bite, the fallback is to **flatten** the
webxdc origin into a single extra label instead of nesting a second wildcard
level:

```
https://<slug>--pr-<n>.webxdc.preview.slothful.chat
```

Now a single `*.webxdc.preview.slothful.chat` wildcard cert covers every
preview's webxdc origins at once — the per-PR cert cost disappears. The origin
pattern would come from a baked `SLOTHFUL_WEBXDC_ORIGIN_PATTERN` build variable
so the flattened naming is a config change, not a code change. This is written
down so we know the move; it is deliberately **not implemented** — the default
nested naming is simpler and the cert budget is comfortable.

## Storage and deletion

Each webxdc app stores its state per-origin: `localStorage`, IndexedDB, the
Cache API, and its service-worker registration all live under
`<slug>.webxdc.<app-host>`. Deleting an app must wipe exactly that origin's
storage and nothing else.

**Deletion via a hidden iframe.** The app opens a hidden iframe of the xdc
origin's bootstrap page and sends it a `wipe` command; the page clears its own
storage and `postMessage`s back when done. Doing it from inside the origin (rather than from a browser API on the
parent) is what makes the next point correct.

**The third-party partitioning subtlety.** Browsers partition third-party iframe
storage by the pair *(top-level origin, iframe origin)*. A webxdc that ran
embedded under `next.slothful.chat` wrote its data into the partition keyed by
`(next.slothful.chat, <slug>.webxdc.next.slothful.chat)` — **not** into a
first-party bucket for the xdc origin. So the wipe must run in an iframe embedded
under that *same* top-level origin, or it clears a different (empty) partition
and leaves the real data behind. The hidden-iframe design does this naturally:
the wipe iframe is embedded by the app under the app's own top-level origin, so
it lands in the right partition. A standalone tab opened directly at the xdc
origin would be first-party and would wipe the wrong partition — which is exactly
why we don't do it that way.

**Mechanism.** The wipe clears, from inside the origin: `localStorage`,
`sessionStorage`, its cookies, every IndexedDB database, the Cache API, OPFS
and the service worker registration, then answers `wiped`. Each store is
cleared on its own, so a browser lacking one doesn't keep the others alive. A
`Clear-Site-Data: "storage"` header would be belt and braces where supported
(not Safari) — not built, since the JS sweep already covers every store.

**What gets wiped, and when.** The app keeps a record of every origin it ever
ran (`localStorage['slothfulchat.webxdcOrigins']`, origin → account + message).
Deleting a webxdc message (core's `WebxdcInstanceDeleted`) closes the app and
wipes its origin; deleting a chat triggers the same sweep for every recorded
app of that account whose message no longer exists (core does not fire the
per-message event for those yet, chatmail/core#6670); removing an account wipes
everything recorded for it. A wipe that fails — offline, say — keeps its
record entry and is retried by the next sweep. In a throwaway `?persist=0`
session the record stays in memory: its account ids restart at 1, and wiping
by such an id must never reach the real profile's apps.

**Framing works in both directions because we control both sides.** The app's
CSP `frame-src` must already list the xdc origins for embedding to work at all;
and the xdc routes set `frame-ancestors` to only the app origin so nothing else
can embed them. Because `frame-ancestors` is a version-coupled header on the xdc
routes, it belongs in `routes.caddy` (shipped in the bundle — see below), not in
hand-written server config.

## Security model

The load-bearing wall is the browser's same-origin policy: each app instance
is its own origin, so it can neither script the chat app (whose origin holds
the whole chat database in OPFS) nor read another app's storage. Around it:

| Layer | What it stops | Where |
|---|---|---|
| One origin per instance | reading the chat app, reading other apps | naming rule, `webxdc-origin.ts` |
| iframe `sandbox` without `allow-popups` / `allow-top-navigation*` | opening windows, navigating the chat app away | `webxdc.ts` |
| App CSP on **every** response, set by the SW at serve time | `fetch`/XHR/WebSocket/images/media/fonts from anywhere but its own origin, foreign nested frames, form posts | `APP_CSP`, `webxdc-sw.ts` |
| Chat app `frame-src` pinned to `*.webxdc.<host>` and the HTML-mail viewer's exact URL | the app navigating **its own frame** with data in the URL — to a foreign server, or to any other URL of the chat app's origin (a server-side endpoint, a page of ours) | a `<meta>` CSP added by `webxdc.ts` everywhere, and the same as a response header where Caddy serves the app (`routes.caddy`) |
| `frame-guard.js` refuses every same-origin frame but the unsandboxed HTML-mail viewer | belt and braces for the row above: a page of ours that boots in an app's frame | `static/frame-guard.js` |
| A guard script first in every page of the app, removing WebRTC there and in every frame the app makes | WebRTC, the one way out no CSP the browsers implement reaches — a speed bump, see the known gaps | `webxdc-guard.ts`, injected by `webxdc-sw.ts` |
| No internet access, ever | Delta Chat lets an app set as a webxdc *integration* (the maps app) online; core still reports `internetAccess` for one, and the browser edition ignores it — the app CSP is fixed | `APP_CSP`; tested by giving an app that flag |
| 256 MB cap on the declared unpacked size | a zip bomb from a chat partner freezing or crashing the chat app's thread | `webxdc.ts` |
| SW refuses top-level navigations | running an app outside the sandbox, driven by an opener | `webxdc-sw.ts` |
| `frame-ancestors <app>` + parent/origin check in the bootstrap page | a stranger framing a webxdc origin and planting code in it | `routes.caddy`, `serve.mjs`, `webxdc-host.ts` |
| Bridge checks `event.source` **and** `event.origin`, validates every field | spoofed or cross-instance calls | `webxdc.ts` |

Why the CSP is set at serve time and never stored: the app shares its origin
with its cache, so it can write entries of its own. A header-less cached
document framed by the app would be a page with no CSP at all — the same class
as the Electron audit's XDC-01-002. The bootstrap page itself carries an even
stricter CSP (`default-src 'none'`), because the app can frame and script it.

Why two CSPs on the chat app: `main.html`'s static `frame-src` has to admit any
`https:` frame — one build serves prod, next, every preview and every
self-hoster, so the host is unknown at build time. `webxdc.ts` adds a second
`<meta>` policy at startup pinning `frame-src` to the HTML-mail viewer's exact
URL (`<origin>/html-email.html`, a CSP source with a path matches that path
only) and `<scheme>//*.webxdc.<this host>`. Every policy is enforced, so the
narrow one is what applies — and since the parent's `frame-src` governs every
navigation of the frame, not just its first, this is also what stops
self-navigation exfil: off-site, and to this origin too. `'self'` would have
let an app send any GET to the chat app's origin with data in the URL (a
server-side endpoint such as the bridge's `/unfurl`, a page of ours that isn't
the app), and `blob:` would have let it replace its frame with a page it wrote
itself, one without the guard (below).
`scripts/test-webxdc-e2e.mjs` checks that against a real server that must see
no request. A `<meta>` policy inserted after parsing is enforced per the HTML
spec (pragmas run on insertion), but it is the kind of thing a browser could
get wrong, so `routes.caddy` also sends the same `frame-src` as a response
header — `{args[0]}` knows the host there. A static host that can't send
headers (GitHub Pages) has the `<meta>` policy only; it has no webxdc origins
either, unless they come from a split-DNS Caddy.

**Known gaps** — what the risk dialog means by "not independently audited"
(tracked, with what would fix each, in
[#297](https://github.com/experintellia/slothfulchat-web/issues/297)):

- **WebRTC.** Peer connections don't go through Fetch, so no CSP directive but
  `webrtc 'block'` reaches them, and the browsers ignore that one (we send it;
  Chromium 141 still makes a TURN connection with it set). Electron firewalls
  this at the network layer; a page can't. What a page can do,
  `webxdc-guard.ts` does: every page of the app starts with a script that
  removes `RTCPeerConnection`, and guards every frame the app makes the moment
  it exists (inserted and reached into at once, its synchronous load event,
  `srcdoc`, a frame sent to a new document, a grandchild made with a child's
  own DOM methods). A non-HTML file shown as a page is refused outright, and
  the pinned `frame-src` has no `blob:`, so the app's frame can't become a page
  it wrote itself. That stops apps and libraries using WebRTC the ordinary
  way. It is a speed bump, not a wall: it runs in the app's own realm, and an
  app that polls a frame while that frame loads one of its pages can sometimes
  take a pristine constructor in the moment before the guard runs
  (`scripts/test-webxdc-host.mjs` shows the race both ways).
- **DNS via a refused navigation.** When an app navigates its frame somewhere
  `frame-src` refuses, Chrome has already preconnected to the target — a DNS
  lookup and a TCP connection to a host name the app chose, so a slow channel
  out (the request itself never goes; Chrome's net log calls it
  `is_preconnect`). Chrome's own "Preload pages" setting (Settings ›
  Performance), off, stops it; a page can't. Resource hints themselves
  (`preconnect`, `dns-prefetch`, `prefetch`, `preload`) connect nowhere and
  look nothing up under the app CSP (Chromium 141, tested).
- **Cookies are per site, not per origin.** Every webxdc origin is same-site
  with the app host, so an app can set a cookie with `Domain=webxdc.<host>`,
  `Domain=<host>` or the registrable domain above it: two colluding apps can
  pass data that way, and an app can toss cookies into sibling services under
  the same registrable domain (a chat at `chat.example.com` next to
  `mail.example.com`). Nothing in the page can stop it — the app owns its
  documents, and a fresh same-origin realm hands back a pristine
  `document.cookie` — and a server header can't either: stripping the
  `Cookie` request header in Caddy protects nothing that reads cookies in
  JavaScript (and the preview gate refuses `request_header`), while
  `Clear-Site-Data: "cookies"` would clear the whole registrable domain,
  logging people out of the sibling services. The fix is a registrable domain
  of its own for the chat (SELFHOSTING.md says so), or for the webxdc origins.
  The wipe clears the app's cookies under its own host and `webxdc.<host>`,
  never above.
- **Nested sandboxed frames.** An app's own `<iframe sandbox>` without
  `allow-same-origin` has an opaque origin, which no service worker controls:
  its document comes from the server, which has none of the app's files (404).
  Rare in apps (webxdc-test uses one); serving app files server-side would
  break the "static files only" rule.
- **The wipe** relies on `indexedDB.databases()` to find an app's databases
  (Firefox since 126, Safari since 14, Chromium); on older browsers an app's
  IndexedDB outlives its message. Everything else is cleared regardless,
  Chromium's storage buckets included.
- **Risk notice** before the first start of each app on this device — each new
  app is a new decision about whom to trust — and "Warn before opening webxdc
  apps" in Settings › Chats switches it off for good (desktop/1070).
- **The bridge** answers at most 64 calls of one app at a time; more are
  refused, so a looping app can't queue unbounded work on the core.
- **Tested on Chromium only** (Playwright). Firefox and Safari, and real iOS
  and Android devices, are untested here.

## Deployment overview

### Routes ship in the bundle

The parameterized route/header config lives in the release bundle at
`dist/caddy/routes.caddy` (assembled from `packages/web-app/caddy/routes.caddy`),
and every deployment — self-host, flagship next, each PR preview — imports that
same file:

```caddyfile
import caddy/routes.caddy <app-host> <dist-root>
```

The reason is version coupling. webxdc routes and their headers (the CSP
`frame-src`, the xdc `frame-ancestors`, the three bootstrap paths) evolve together with the app code that relies on them. If the server
config were maintained separately from the bundle it serves, the two would drift
and a header change in the app would silently need a matching server edit
everywhere. Shipping `routes.caddy` inside `dist/` means the config for a given
build travels with that build: each deployment reloads Caddy pointed at the
freshly deployed `dist/caddy/routes.caddy`, so the routes always match the
version being served, and preview-vs-release divergence stays minimal.

`routes.caddy` deliberately contains **no TLS config** — the importing Caddyfile
owns certificates. The `*.webxdc.` block does `import wildcard_tls`, so the outer
Caddyfile must define a `(wildcard_tls)` snippet (the DNS-01 provider block). The
shipped `Caddyfile.example` provides that snippet with commented porkbun and
cloudflare variants.

### Preview trust model (summary)

PR previews run untrusted-ish PR branches on a shared server, so the trust model
matters:

- **Fork PRs are excluded.** Only same-repo PRs get previews; same-repo authors
  already have push access, so previews grant no new capability. Fork-PR previews
  are a separate, later decision (tracked as an issue when the infra lands).
- **The deploy key is a forced command.** The preview SSH key can only invoke the
  server-side gate script (`deploy-preview.sh`), never an arbitrary command. The
  gate script stages the upload, generates the site-address-defining wrapper
  itself **from the PR number only** (uploads never contain config that names a
  hostname), runs `caddy validate` on the full merged config, and reloads only on
  success.
- **The server validates itself; the action is not trusted.** A PR that tried to
  claim prod's hostname produces a duplicate site address — a hard
  `caddy validate` error — so the reload is rejected and the previously-serving
  config stays up. Nothing the CI action sends is taken on faith.

Full bring-up details and the gate-script subcommands live in
[`infra/flagship/README.md`](infra/flagship/README.md).

### Split-DNS option

Because the naming rule needs zero app config, a Pages-hosted (or any static)
app can gain webxdc purely through DNS: keep the app host pointed at Pages, and
point `*.webxdc.<app-host>` at a Caddy server that serves **only** the xdc
origins. The main app stays on the static host untouched; the webxdc origins come
from the small Caddy box. This is how prod (`web.slothful.chat`, on GitHub Pages)
can eventually get webxdc without leaving Pages — see the roadmap.

## Roadmap

Built: the runtime probe and unsupported UI, the bootstrap page + service
worker, the wipe, the `main.html` CSP, app windows and floating ones,
realtime channels. Tested by `scripts/test-webxdc-host.mjs` (the origin side,
attacked from inside an app, no core), `scripts/test-webxdc-e2e.mjs` (two
accounts, real core, real UI, desktop windows and a phone — and with `CADDY=1`
the same behind the shipped Caddy routes on a same-site https domain, where
cookies behave as in production),
`scripts/test-webxdc-realtime-e2e.mjs` (realtime over a local iroh relay, with
latency) and `scripts/test-webxdc-store-apps-e2e.mjs` (webxdc-test and the
store's Realtime Check, vendored in `scripts/fixtures/webxdc/`).

Still open:

- **Maps integration** — descoped here on purpose; maps will be done
  differently ([DESCOPED.md](DESCOPED.md)).
- **Offline start.** The bootstrap page comes from the network, so a webxdc app
  can't be *started* offline even though its files are cached. The SW could
  serve the bootstrap files network-first with a cache fallback.
- **Window bounds** aren't remembered per app (Electron keeps them in the
  account's `ui.desktop.webxdcBounds.*` config).
- **Prod webxdc via split-DNS**: `*.webxdc.web.slothful.chat` → the Caddy server
  serving prod-version xdc content, so prod keeps its GitHub Pages app. Watch for
  version skew between the Pages-served app and the server-served xdc origins.
- **Fork-PR previews**: open a GitHub issue to decide the trust model once the
  preview infra is live.
- **`main.html` CSP**: watch the **multi-line CSP `<meta>` grep trap** — the
  CSP is a multi-line `<meta>` tag, so a naive single-line grep for a directive
  misses it; edit the tag, don't trust a one-line search to find every
  occurrence.

Everything on this list assumes the origin/DNS/TLS foundation described above;
none of it changes the naming rule or the "server serves only static files"
invariant.
