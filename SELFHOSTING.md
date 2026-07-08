# Self-hosting SlothfulChat

You host **two things**:

1. **The web app** — a static site (`packages/web-app/dist`). Serve it from
   anywhere: GitHub Pages, Netlify, an S3 bucket, your own nginx.
2. **A WS→TCP bridge** — the one server piece, because browsers can't open raw
   TCP. See [`packages/ws-tcp-proxy`](packages/ws-tcp-proxy/README.md). TLS
   terminates inside the browser, so the bridge only ever relays ciphertext.

> Exception: accounts on the experimental **webimap** transport (madmail
> servers, see the README's webimap section) talk plain HTTPS and don't use the
> bridge at all — if all your accounts are webimap, you only host the static
> site.

The app is configured entirely through **build-time environment variables** —
nothing is baked into the source, so your instance name, imprint, and default
bridge live in your CI/host config, not in the repo.

## 1. Deploy the app

**GitHub Pages (easiest):** the repo ships
[`.github/workflows/deploy-pages.yml`](.github/workflows/deploy-pages.yml).
Set the variables below under **Settings → Secrets and variables → Actions →
Variables**, then enable **Settings → Pages → Source = "GitHub Actions"** and
push. The app auto-detects its URL base, so a project site
(`https://<you>.github.io/<repo>/`) or a custom domain both work.

**Any other static host:** build locally and upload `packages/web-app/dist`:

```sh
git submodule update --init
pnpm apply-patches
# build the wasm core + frontend once (see packages/*/README.md), then:
SLOTHFUL_INSTANCE_NAME="SlothfulChat" \
SLOTHFUL_INSTANCE_URL="https://web.example.chat" \
SLOTHFUL_DEFAULT_PROXY="wss://web.example.chat/bridge" \
SLOTHFUL_IMPRINT_NAME="Jane Doe" \
SLOTHFUL_IMPRINT_ADDRESS=$'Example Str. 1\n12345 Town\nCountry' \
SLOTHFUL_IMPRINT_EMAIL="hello@example.chat" \
  pnpm --filter @slothfulchat/web-app assemble
pnpm --filter @slothfulchat/web-app build
# upload packages/web-app/dist/ to your host
```

## 2. Run the bridge

**Just for yourself?** Run it locally with no config — it listens on
`ws://localhost:8641` and the app talks to it directly:

```sh
npx @slothfulchat/ws-tcp-proxy
```

**Hosting it publicly? You MUST restrict it to an allowlist**, or you're running
an open relay: an unrestricted bridge will tunnel to *any* mail server's
IMAP/SMTP ports for anyone on the internet — an abuse magnet (credential-stuffing
against arbitrary servers, spam relaying). Set `CHATMAIL_ALLOWLIST` to only the
chatmail/email servers you allow:

```sh
# behind TLS (see below); only these servers are reachable
CHATMAIL_ALLOWLIST=nine.testrun.org,chatmail.example \
  npx @slothfulchat/ws-tcp-proxy
```

The bridge speaks plain **`ws://`** on `PORT` (default 8641). An `https://`
site **cannot** connect to `ws://` (mixed content), so put a TLS-terminating
reverse proxy (nginx, Caddy, …) in front to expose it as **`wss://`**, and
point `SLOTHFUL_DEFAULT_PROXY` at that `wss://` URL. Full options (endpoints,
how the `CHATMAIL_ALLOWLIST` allow-list works) are in the
[proxy README](packages/ws-tcp-proxy/README.md).

## The variables

### App (set at build time, baked into `dist/`)

| Variable | What it does | Example |
|---|---|---|
| `SLOTHFUL_INSTANCE_NAME` | Display name of your instance (shown on the imprint page). | `SlothfulChat` |
| `SLOTHFUL_INSTANCE_URL` | Canonical origin of your instance. | `https://web.slothful.chat` |
| `SLOTHFUL_DEFAULT_PROXY` | The `wss://` bridge the app uses when the user hasn't set one. **Without this, the app defaults to `ws://localhost:8641`** and can't connect on a hosted site. | `wss://web.slothful.chat/bridge` |
| `SLOTHFUL_IMPRINT_NAME` | Responsible person/entity on the imprint (legal notice) page. | `Jane Doe` |
| `SLOTHFUL_IMPRINT_ADDRESS` | Postal address on the imprint page (newlines allowed). | `Example Str. 1\n12345 Town` |
| `SLOTHFUL_IMPRINT_EMAIL` | Contact email on the imprint page. | `hello@example.chat` |

All are optional. Unset instance/proxy vars fall back to sane defaults; unset
imprint vars produce a placeholder imprint page telling operators to configure
them. The imprint's scope/privacy/reporting wording is fixed in the template —
only the name/address/email come from these vars. **The imprint is not legal
advice; have it reviewed if you operate under Impressum/DDG rules.**

Users can always override the bridge at runtime with `?proxy=wss://…` or the
`slothfulchat.proxyUrl` localStorage key.

### Bridge (set where you run the proxy)

| Variable | What it does | Default |
|---|---|---|
| `PORT` | Port the bridge listens on (`ws://`). | `8641` |
| `CHATMAIL_ALLOWLIST` | Comma-separated chatmail domains the bridge may reach. Empty = allow any server (fine for local dev; **set it for a public bridge**). | empty (allow all) |
