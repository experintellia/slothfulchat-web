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
app. The same rule produces the right origin in every environment, so the app
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

### Runtime support probe

The app decides at runtime whether webxdc origins are reachable, because the
same static build runs both on hosts that have the wildcard configured and on
hosts that don't. The idea: fetch a well-known path on a probe subdomain under
`webxdc.<app-host>` and see whether it resolves to our static content. If the
probe succeeds, webxdc is enabled; if it fails (no DNS record, no cert, plain
static host), the app shows webxdc as unsupported and everything else keeps
working. The probe result is the single gate for the whole feature — no
`SLOTHFUL_*` variable turns webxdc on or off, the environment does.

### Content flow (eventual)

The webserver never sees a `.xdc` file. It serves a small set of **static**
files on the xdc origin — a bootstrap page and a service worker — and nothing
else. The actual app bytes flow like this:

1. The main app (on `<app-host>`) has the `.xdc` bytes; it embeds a hidden/visible
   iframe pointing at `https://<slug>.webxdc.<app-host>`.
2. The bootstrap page loads there and registers its service worker.
3. The parent app `postMessage`s the `.xdc` contents into the frame.
4. The service worker on the xdc origin serves those bytes for the app's own
   requests — so the app runs entirely within its isolated origin, fed from the
   parent, with Caddy only ever having served the static bootstrap + SW.

This keeps the server dumb (static files, no per-app state, no uploads) while
still giving every app a real, isolated, service-worker-backed origin.

For now — before any of the bootstrap machinery exists — every path on an xdc
origin serves a single isolation test page (`dist/webxdc-test.html`). It stores
a random id in `localStorage` and shows it, so you can confirm by eye that two
different slugs get two different persistent origins. That page is the proof the
isolation works; the bootstrap/SW replaces it as the feature lands.

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

**Deletion via a hidden iframe.** The app opens a hidden iframe to a wipe route
on the xdc origin; the page there clears its own storage and `postMessage`s back
when done. Doing it from inside the origin (rather than from a browser API on the
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

**Mechanism.** The primary, portable path is a **JS self-clear** from inside the
wipe page: empty `localStorage`, delete the IndexedDB databases, delete the
Cache API entries, unregister the service worker, then `postMessage` "done" to
the parent. As an enhancement the wipe route also sends
`Clear-Site-Data: "storage"`, which lets the browser do the sweep for us — but
Safari does not support the header, so JS stays the primary mechanism and
`Clear-Site-Data` is belt-and-suspenders where available.

**Framing works in both directions because we control both sides.** The app's
CSP `frame-src` must already list the xdc origins for embedding to work at all;
and the xdc routes set `frame-ancestors` to only the app origin so nothing else
can embed them. Because `frame-ancestors` is a version-coupled header on the xdc
routes, it belongs in `routes.caddy` (shipped in the bundle — see below), not in
hand-written server config.

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
`frame-src`, the xdc `frame-ancestors`, the wipe route, later the bootstrap/SW
paths) evolve together with the app code that relies on them. If the server
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

The foundation (docs, isolation test page, shipped Caddy files, dev harness,
flagship config + gate script, preview workflows) is what this increment builds.
The actual webxdc feature in the app is deferred and tracked here:

- **Runtime probe + graceful-unsupported UI.** Detect whether webxdc origins
  resolve, and present webxdc as unsupported (not broken) when they don't.
- **Bootstrap page + service worker** on the xdc origin: receive `.xdc` bytes
  from the parent via `postMessage` and serve the app from within the isolated
  origin.
- **Wipe route** on the xdc origin: hidden-iframe deletion with JS self-clear +
  `Clear-Site-Data` enhancement, embedded under the app's top-level origin so it
  hits the right storage partition.
- **Prod webxdc via split-DNS**: `*.webxdc.web.slothful.chat` → the Caddy server
  serving prod-version xdc content, so prod keeps its GitHub Pages app. Watch for
  version skew between the Pages-served app and the server-served xdc origins.
- **Fork-PR previews**: open a GitHub issue to decide the trust model once the
  preview infra is live.
- **`main.html` CSP updates**: add the xdc origins to `frame-src`. Watch the
  **multi-line CSP `<meta>` grep trap** — the CSP is a multi-line `<meta>` tag,
  so a naive single-line grep for a directive misses it; edit the tag, don't
  trust a one-line search to find every occurrence.

Everything on this list assumes the origin/DNS/TLS foundation described above;
none of it changes the naming rule or the "server serves only static files"
invariant.
