# Self-hosting SlothfulChat

You host **two things**:

1. **The web app** — a static site (`packages/web-app/dist`). Serve it from
   anywhere: GitHub Pages, Netlify, an S3 bucket, your own nginx.

   > **Prefer a host that lets you set response headers.** `dist/caddy/routes.caddy`
   > sends `Content-Security-Policy: frame-ancestors 'none'`, `X-Frame-Options`,
   > `X-Content-Type-Options` and `Referrer-Policy`. A page cannot set
   > `frame-ancestors` for itself — `<meta>` CSP ignores it — so on a host that
   > serves fixed headers only (GitHub Pages among them) the app can be framed
   > by a hostile site and attacked by clickjacking. Everything else works
   > there; this one protection needs a real server or a CDN edge in front.
   > `dist/frame-guard.js` is a page-level backstop (see below), not a
   > replacement.
2. **A WS→TCP bridge** — the one server piece, because browsers can't open raw
   TCP. See [`packages/ws-tcp-proxy`](packages/ws-tcp-proxy/README.md). TLS
   terminates inside the browser, so the bridge only ever relays ciphertext.

> Exception: accounts on the experimental **webimap** transport (madmail
> servers, see the README's webimap section) talk plain HTTPS and don't use the
> bridge at all — if all your accounts are webimap, you only host the static
> site.

The app is configured entirely through **environment variables** — set at
build time, or baked into a prebuilt release zip by the customize script.
Nothing lives in the source, so your instance name, imprint, and default
bridge stay in your CI/host config, not in the repo.

## 1. Deploy the app

**Prebuilt release (any static host, no toolchain):**

```sh
npx @slothfulchat/customize
```

It downloads the latest release zip from the
[releases page](https://github.com/experintellia/slothfulchat-web/releases) —
a generic build of exactly what GitHub Pages serves — prompts for each
variable below (Enter skips one; the `SLOTHFUL_*` env vars are honored too),
and writes `slothfulchat-web-custom.zip` with your values baked in: the
instance name lands in the web UI as well (tab title, PWA install name), and
the service-worker precache manifest is recomputed so installed PWAs pick up
the change. Unzip the output onto your host — done. Prefer no npm? Each
release also ships the script standalone as `slothfulchat-customize.mjs`
(`node slothfulchat-customize.mjs --in <downloaded zip>`).

**GitHub Pages:** the repo ships
[`.github/workflows/deploy-pages.yml`](.github/workflows/deploy-pages.yml).
Set the variables below under **Settings → Secrets and variables → Actions →
Variables**, then enable **Settings → Pages → Source = "GitHub Actions"**. It
deploys on **`v*` release tags**, not on pushes to main: the workflow's first
job ([`verify-release-tag.yml`](.github/workflows/verify-release-tag.yml))
requires the ref to be an unmoved tag whose commit is on `main` and whose
package versions match it (see [RELEASING.md](RELEASING.md)). The
`github-pages` environment also needs a `v*` tag deployment rule (Settings →
Environments → github-pages), or the deploy is rejected by environment
protection rules. The app auto-detects its URL base, so a project site
(`https://<you>.github.io/<repo>/`) or a custom domain both work.

**Building it yourself:** build locally and upload `packages/web-app/dist`:

```sh
git submodule update --init
pnpm apply-patches
# build the wasm core + frontend once (see packages/*/README.md), then:
SLOTHFUL_INSTANCE_NAME="SlothfulChat" \
SLOTHFUL_INSTANCE_URL="https://web.example.chat" \
SLOTHFUL_DEFAULT_PROXY="wss://web.example.chat/bridge" \
SLOTHFUL_DEFAULT_CHATMAIL="chat.example.chat" \
SLOTHFUL_IMPRINT_NAME="Jane Doe" \
SLOTHFUL_IMPRINT_ADDRESS=$'Example Str. 1\n12345 Town\nCountry' \
SLOTHFUL_IMPRINT_EMAIL="hello@example.chat" \
  pnpm --filter @slothfulchat/web-app assemble
pnpm --filter @slothfulchat/web-app build
# upload packages/web-app/dist/ to your host
```

## Response headers on a host that can't send them (GitHub Pages)

A static host that serves fixed headers only cannot be made to send security
headers, and **the repository cannot fix this from inside** — GitHub Pages has
no header configuration, so a Pages deployment (including the flagship one this
repo's `deploy-pages.yml` produces) ships with none of the headers below. Put a
header-capable edge in front of it — Cloudflare (Transform Rules), Fastly,
CloudFront + Lambda@Edge, or any reverse proxy — and have it add:

| Header | Value | Why |
|---|---|---|
| `Content-Security-Policy` | `frame-ancestors 'none'` | The one directive `main.html`'s `<meta>` CSP cannot express. A second CSP header never relaxes the meta policy — policies are enforced independently. |
| `X-Frame-Options` | `DENY` | Same job for browsers that predate `frame-ancestors`. |
| `X-Content-Type-Options` | `nosniff` | Stops MIME sniffing turning an upload or a blob into script. |
| `Referrer-Policy` | `no-referrer` | Chat URLs can carry invite/QR fragments; don't leak them onward. |
| `Strict-Transport-Security` | `max-age=63072000; includeSubDomains` | Pins HTTPS. Add `preload` only if you mean it — it is hard to undo, and `includeSubDomains` covers webxdc origins too. |

Two exceptions, both already encoded in `dist/caddy/routes.caddy` — copy them:
`/html-email.html` needs `frame-ancestors 'self'` / `X-Frame-Options: SAMEORIGIN`
(the app frames its own HTML-mail viewer on phones and installed PWAs), and any
`*.webxdc.` origin needs `frame-ancestors https://<app-host>` (webxdc apps are
meant to be framed by the app — see [WEBXDC.md](WEBXDC.md)).

Without such an edge, the only thing standing between the app and a clickjacking
page is `dist/frame-guard.js`: it runs first in `main.html`, `call-popup.html`
and `html-email.html`, and blanks the document when a foreign origin frames it.
That is defence in depth — it needs scripting to be enabled and it protects only
our own documents. **It is not equivalent to the headers.**

## Optional: webxdc apps

[webxdc](https://webxdc.org) mini-apps run each in their own **origin**, so they
need a wildcard subdomain and a webserver that terminates TLS for it. This is
purely optional: skip everything here and the app still works — webxdc just
reports as unsupported. Turning it on takes three steps:

1. **DNS.** Point both your app host and a wildcard beneath it at your server:
   `yourdomain` and `*.webxdc.yourdomain`. (The wildcard covers every app's
   origin with one record; keep it DNS-only if you're on Cloudflare.)
2. **Caddy config.** The release zip ships `dist/caddy/Caddyfile.example` — edit
   the marked lines (your domain and dist path) and uncomment the `tls { dns … }`
   block for your DNS provider (porkbun and cloudflare variants are both there).
   Keep the API token in the environment variable, not in the file: the config
   lives inside the web root. The shipped routes refuse to serve `/caddy/*` as a
   safety net, but hardcoded secrets in the webroot are one webserver swap away
   from being public — copy the file outside `dist/` if you prefer.
3. **Run Caddy.** Wildcard certificates use the DNS-01 challenge, which needs a
   Caddy built with your provider's plugin:

   ```sh
   xcaddy build \
     --with github.com/caddy-dns/porkbun \
     --with github.com/caddy-dns/cloudflare
   ```

   Then `caddy run --config dist/caddy/Caddyfile.example`.

The full design — the naming rule, the DNS-vs-TLS wildcard distinction, storage
and deletion, and the flagship/preview deployment model — is in
[WEBXDC.md](WEBXDC.md).

## 2. Run the bridge

**Just for yourself?** Run it locally with no config — it listens on
`ws://127.0.0.1:8641`, loopback only, and the app talks to it directly:

```sh
npx @slothfulchat/ws-tcp-proxy
```

**Hosting it for others?** Two variables, both required: `HOST` to bind an
address the network can reach, and `CHATMAIL_ALLOWLIST` to restrict where it may
tunnel. Without the allowlist you'd be running an open relay — an unrestricted
bridge tunnels to *any* mail server's IMAP/SMTP ports for anyone who reaches it,
an abuse magnet (credential-stuffing against arbitrary servers, spam relaying) —
so **the bridge refuses to start** in that combination:

```sh
# behind TLS (see below); only these servers are reachable
HOST=0.0.0.0 \
CHATMAIL_ALLOWLIST=nine.testrun.org,chatmail.example \
  npx @slothfulchat/ws-tcp-proxy
```

> **Upgrading from ≤ 0.8?** Older versions bound every interface by default. If
> your bridge stopped being reachable, add `HOST=0.0.0.0` (or your interface
> address) — and note it now needs `CHATMAIL_ALLOWLIST` to start at all.

The bridge authenticates nobody and does not check `Origin`: anyone who can
reach the port may use it, bounded only by the allowlist. Keep the allowlist
tight, and don't expose it more widely than you need.

The bridge speaks plain **`ws://`** on `PORT` (default 8641). An `https://`
site **cannot** connect to `ws://` (mixed content), so put a TLS-terminating
reverse proxy (nginx, Caddy, …) in front to expose it as **`wss://`**, and
point `SLOTHFUL_DEFAULT_PROXY` at that `wss://` URL. Full options (endpoints,
how the `CHATMAIL_ALLOWLIST` allow-list works) are in the
[proxy README](packages/ws-tcp-proxy/README.md).

## The variables

### App (baked into `dist/` at build time, or by the customize script)

| Variable | What it does | Example |
|---|---|---|
| `SLOTHFUL_INSTANCE_NAME` | Display name of your instance: tab title, PWA install name, imprint page. | `SlothfulChat` |
| `SLOTHFUL_INSTANCE_URL` | Canonical origin of your instance. | `https://web.slothful.chat` |
| `SLOTHFUL_DEFAULT_PROXY` | The `wss://` bridge the app uses when the user hasn't set one. **Without this, the app defaults to `ws://localhost:8641`** and can't connect on a hosted site. | `wss://web.slothful.chat/bridge` |
| `SLOTHFUL_PUBLIC_BRIDGES` | Public bridges offered as options in the app's bridge picker dialog, each with a super-short description. Format: `;`-separated `URL description` entries — the URL runs to the first space, the rest of the entry is the description (so descriptions can't contain `;`). Entries without a `ws://`/`wss://` URL are ignored. A local bridge and a custom-URL field are always offered too, and the `SLOTHFUL_DEFAULT_PROXY` bridge shows up automatically (deduped, your description wins if you list it here). | `wss://a.example/bridge Community bridge, for testing; wss://b.example/bridge Backup bridge` |
| `SLOTHFUL_DEFAULT_CHATMAIL` | The chatmail relay the "create new account" onboarding flow signs up on when a user just taps the button. Point it at your own chatmail server so new sign-ups land there. Accepts a bare host, a URL, or a `dcaccount:` QR. Unset = the upstream default relay. Users scanning a `dcaccount:`/`dclogin:` QR still override it. | `chat.example.chat` |
| `SLOTHFUL_RELAY_DIRECTORY` | Where the onboarding relay picker fetches the public relay list — JSON of the shape `{"relays":[{"host":"…"}]}`, served with CORS. Unset = an automated daily mirror of [chatmail.at/relays](https://chatmail.at/relays) ([chatmail-relays-mirror](https://github.com/experintellia/chatmail-relays-mirror)). `off` = no relay picker; users then always sign up on the default relay. The page CSP (`connect-src`) is pinned to exactly this URL at build/customize time. | `https://relays.example.chat/relays.json` |
| `SLOTHFUL_IMPRINT_NAME` | Responsible person/entity on the imprint (legal notice) page. | `Jane Doe` |
| `SLOTHFUL_IMPRINT_ADDRESS` | Postal address on the imprint page (newlines allowed). | `Example Str. 1\n12345 Town` |
| `SLOTHFUL_IMPRINT_EMAIL` | Contact email on the imprint page. | `hello@example.chat` |
| `SLOTHFUL_HIDE_PUBLIC_SUGGESTIONS` | `1`/`true`: hide the community suggestions ("Public Bots", "Public Channels") in the New Chat dialog for the whole instance — the per-user settings toggle is hidden too. Unset/empty: suggestions are shown and each user can hide them in Settings → Chats and Media. | `1` |
| `SLOTHFUL_SUPPORT_URL` | Your issue tracker — a button on the "could not start" screen that opens a prefilled issue. Needs an account there. See [docs/crash-reports.md](docs/crash-reports.md). | `https://github.com/you/your-fork/issues/new` |
| `SLOTHFUL_CRASH_REPORT_URL` | A crash-report destination that needs no account — the same screen's other button. A webserver route is the entire backend; see [docs/crash-reports.md](docs/crash-reports.md). | `https://report.example.chat/` |

All are optional. Unset instance/proxy vars fall back to sane defaults; unset
imprint vars produce a placeholder imprint page telling operators to configure
them. The imprint's scope/privacy/reporting wording is fixed in the template —
only the name/address/email come from these vars. **The imprint is not legal
advice; have it reviewed if you operate under Impressum/DDG rules.**

> **Setting these as GitHub Actions Variables?** Three things trip people up:
> - Add them as **Repository variables** (Settings → Secrets and variables →
>   Actions → Variables → *Repository variables*). An **Environment** variable
>   scoped to the `github-pages` environment does *not* work: the build reads
>   these in the `build` job, which has no `environment:`, so it can't see
>   environment-scoped variables — the value comes through empty.
> - Use the **Variables** tab, not **Secrets** — the build reads
>   `${{ vars.* }}`, which cannot read Secrets.
> - Enter the **raw value with no quotes** — GitHub stores the field verbatim,
>   so `"…"` becomes part of the value. The `NAME="value"` form in the shell
>   examples above is shell quoting and belongs only on a command line.
>   (`SLOTHFUL_PUBLIC_BRIDGES` tolerates accidental wrapping quotes; the others
>   take the field as-is.)

Users can always override the bridge at runtime in the app's bridge picker
dialog (which offers a local bridge, your `SLOTHFUL_PUBLIC_BRIDGES` options
and a custom URL; stored in the `slothfulchat.proxyUrl` localStorage key), or
with `?proxy=wss://…` in the URL.

### Bridge (set where you run the proxy)

| Variable | What it does | Default |
|---|---|---|
| `PORT` | Port the bridge listens on (`ws://`). | `8641` |
| `HOST` | Address the bridge binds. The default is loopback-only, so a bridge you didn't configure for hosting can't be reached from the network. Set `0.0.0.0` (or one interface address) to host it — that requires `CHATMAIL_ALLOWLIST`. | `127.0.0.1` |
| `CHATMAIL_ALLOWLIST` | Comma-separated chatmail domains the bridge may reach. Empty = allow any server (fine on the loopback default; a non-loopback `HOST` with an empty allowlist **refuses to start**). | empty (allow all) |
