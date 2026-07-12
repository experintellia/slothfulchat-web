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
Variables**, then enable **Settings → Pages → Source = "GitHub Actions"** and
push. The app auto-detects its URL base, so a project site
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
| `CHATMAIL_ALLOWLIST` | Comma-separated chatmail domains the bridge may reach. Empty = allow any server (fine for local dev; **set it for a public bridge**). | empty (allow all) |
