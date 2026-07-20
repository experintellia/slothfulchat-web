# slothfulchat-web

Feasibility prototype: a DeltaChat client running **fully in the browser** — chatmail core compiled to WASM, driving the deltachat-desktop frontend as a standalone PWA. Private patch-stack experiment, **no upstream contribution intended**. Not affiliated with Delta Chat.

See [SELFHOSTING.md](SELFHOSTING.md) to run your own instance, [PLAN.md](PLAN.md) for the full plan, [PATCHES.md](PATCHES.md) for a human-readable summary of what we changed compared to upstream, [DESCOPED.md](DESCOPED.md) for deliberate omissions, [FINDINGS.md](FINDINGS.md) for the feasibility log.

## Highlights

- 📞 **Calls in the browser** — audio, video and screen share with our own
  WebRTC engine, wire-compatible with Delta Chat's calls (upstream ships
  calls on Electron only)
- 📮 **Works with your existing account** — any normal email or chatmail
  account connects through the WebSocket bridge; madmail servers even work
  without any bridge, over plain HTTPS
- 🧹 **Tracking stripped from links** — `utm_*`, click-ids and friends
  removed on click and paste, undoable
- 🔗 **Privacy-preserving link previews** — baked on the *sender's* device;
  recipients never contact the site
- 🦥 **Animated stickers** — Telegram `.tgs`/Lottie stickers render and send
- 📦 **Export Chat** — a self-contained HTML viewer + media zip, per chat
- 😀 **`:emoji:` completion** in the composer — on by default
- 🌍 **In-app translation editor** — edit UI strings live, export, create
  languages
- 🛰️ **In-app relay picker** — choose a chatmail relay with live
  reachability/latency at onboarding

…and more — see [PATCHES.md](PATCHES.md).

## Privacy & data protection

The app runs **entirely in your browser**. Your accounts, messages, encryption
keys and files are stored only on your device and are exchanged end-to-end
encrypted, directly with the mail servers, through a relay that only ever sees
encrypted traffic. **Self-hosted instances collect no analytics whatsoever** —
no events, no banner, not even an extra network origin in the
Content-Security-Policy (this is the default; see "Operators" below).

**Local profiling** (startup timing and action latency) uses the browser's
User Timing API and is **never sent anywhere** — it stays on your device and is
only shown, on request, in the in-app Diagnostics panel (Settings → open the log
→ **Diagnostics**), where a "copy diagnostics" button lets you volunteer the
numbers in a bug report.

**The official public demo instance** additionally collects **anonymous,
aggregated usage statistics** via [Plausible](https://plausible.io/data-policy)
(a privacy-focused analytics tool — no cookies, no cross-site tracking). It is
enabled by default there — an opt-out checkbox sits right on the welcome
screen, and you can **opt out at any time** in Settings → Advanced or
Diagnostics → Usage statistics (the choice is remembered). Exactly what is
collected is spelled out on the instance's generated `privacy.html`, rendered
from the same catalog the code enforces at runtime. Because events are sent by
our own code via Plausible's events API,
**no third-party JavaScript is loaded** and only a single extra `connect-src`
origin is added to the CSP.

- **Collected:** that the app was opened (new vs returning, installed-PWA vs
  tab); onboarding progress and the method chosen (default chatmail relay vs
  manual email login vs QR vs webimap); that a message was sent and of what kind
  (text/image/voice/file — never its content); which info links
  (imprint/GitHub/changelog/donate) were opened; QR scans; whether a community channel
  was used; link-preview accept/dismiss; which kind of bridge is used (local /
  provided / custom); backup/key import-export (not the contents); coarse
  chat-count milestones (first, >10); coarse buckets for startup and other
  timings; and fatal startup errors by category. The exact, closed list lives in
  `packages/web-app/src/analytics.ts` (`EVENTS`) and is what the in-app notice
  and the imprint render.
- **Never collected:** message content, contact or email addresses, account
  data, or any free text.

**Operators:** analytics is opt-in *for the instance*, at build time. It only
turns on when `SLOTHFUL_PLAUSIBLE_DOMAIN` (and optionally
`SLOTHFUL_PLAUSIBLE_API`, which defaults to Plausible cloud — point it at your
own Plausible to self-host analytics) are set in CI. Leave them unset for a
fully private instance. The per-instance imprint (`imprint.html`) documents this
automatically. See [`packages/web-app`](packages/web-app/README.md) for details.

**Calls (audio/video)** connect **directly, peer-to-peer, whenever a network
path allows it** (standard WebRTC ICE, direct-preferred). When a direct route
isn't possible — NAT/firewalls on either side — the call **automatically falls
back to relaying through a STUN/TURN server**, returned by your chatmail
relay's `ice_servers()` (the same relay your messages already use). There is
**no setting to force relay-only routing** — direct is always tried first, and
forcing relay when direct would work would just burn the relay's egress
bandwidth for no privacy gain in Delta Chat's usual threat model (calling
known contacts, not strangers). Regardless of the path, call media is
DTLS-SRTP end-to-end encrypted the same way any WebRTC call is, so **a relay
never sees call content** — only that a call is happening and the IP addresses
of the two participants, the same connection metadata any relay/bridge you use
already sees for messaging. The in-call UI shows a small, non-blocking
indicator of whether the active call is **direct** or **relayed**, purely for
troubleshooting. **Who is allowed to call you at all** is controlled by the
existing Delta Chat privacy setting (Settings → Notifications → "Calls").

## Layout

- `vendor/core`, `vendor/deltachat-desktop` — submodules pinned at upstream commits (never modified in place)
- `patches/core`, `patches/desktop` — stacked `git format-patch` files, the only upstream modifications
- `build/` — throwaway worktrees: pinned commit + patches applied (gitignored)
- [`packages/core-wasm`](packages/core-wasm/README.md) — deliverable 1: npm package, WASM core behind the standard `@deltachat/jsonrpc-client` TypeScript API
- [`packages/web-app`](packages/web-app/README.md) — deliverable 2: standalone browser frontend using core-wasm
- [`packages/ws-tcp-proxy`](packages/ws-tcp-proxy/README.md) — the WS→TCP bridge (the one server piece; npx-able, optional chatmail-server allowlist)

## webimap transport (madmail, no bridge needed)

Next to the normal IMAP/SMTP-over-bridge transport there is an **even more
experimental** `webimap` transport that speaks
[madmail](https://github.com/themadorg/madmail)'s
[WebIMAP/WebSMTP](https://github.com/themadorg/madmail/blob/main/docs/TDD/10-webimap.md)
protocol — mail over plain HTTPS REST from the browser, so it needs **no
`ws-tcp-proxy` bridge at all**. It only works against madmail servers with the
`__WEBIMAP_ENABLED__` and `__WEBSMTP_ENABLED__` service toggles switched on
(both are off by default on madmail).

Ways to activate it:

- **Welcome screen** → "madmail server — no bridge needed, extra experimental"
  → enter the instance's IP address or domain; an account is created on that
  server and the normal onboarding flow continues.
- **QR / invite code**: `webimapaccount:host` (host = IP or domain, optional
  `:port`) — creates an account via `POST https://host/new` and configures the
  transport. Works wherever invite codes are accepted.
- **Manual login → Advanced**: the "Use webimap" toggle turns an ordinary
  addr+password login into a webimap transport (server host defaults to the
  address's domain, or set the inbox server field explicitly).

Limitations (v1): receive is REST long-polling (`/webimap/messages?wait=…`, no
WebSocket yet); INBOX only, message flags are not persisted (madmail maildir
v1); connections are always `https://` — plain `http://` is allowed only for
`localhost`/`127.0.0.1`/`[::1]` so the offline e2e test
(`scripts/test-webimap.mjs`) can run a mock server without TLS; messages are
deleted from the server after they are fetched, and deduplication relies on
Message-IDs instead of persisted UIDs; multi-device sync of a webimap
transport to an older core silently downgrades it to IMAP (unknown JSON
field). Everything here is prototype quality — even more so than the rest of
this repo.

## Workflow

```sh
git submodule update --init          # once
pnpm apply-patches                   # (re)create build/ from pins + patches
# ...edit inside build/<name>, one git commit per logical patch...
pnpm update-patches                  # regenerate patches/ from build/ commits
```

Requires: Node ≥ 22 + pnpm, Rust stable + `wasm32-unknown-unknown` target.

## Licensing

The project as a whole is **GPL-3.0-or-later** (see [LICENSE](LICENSE)) —
required because the web app is a derivative of the GPL-3.0 deltachat-desktop
frontend. Per component:

| Part | License |
|---|---|
| `patches/core` — our patches to the MPL core | `MPL-2.0 OR GPL-3.0-or-later` (dual) |
| `patches/desktop` — our patches to the GPL frontend | GPL-3.0-or-later |
| `packages/web-app` | GPL-3.0-or-later |
| `packages/core-wasm` — the reusable WASM core wrapper | MPL-2.0 (matches upstream core; GPL-compatible) |
| `packages/ws-tcp-proxy` — the standalone bridge | [Unlicense](packages/ws-tcp-proxy/UNLICENSE) (public domain) |

Our `patches/core` changes are **dual-licensed `MPL-2.0 OR GPL-3.0-or-later`**:
they modify MPL-2.0 files (so they stay available under MPL-2.0, as MPL
requires) and are also offered under GPL-3.0-or-later so they compose into this
GPL-3.0 work. The vendored upstreams keep their own licenses and notices:
`vendor/core` is **MPL-2.0**; `vendor/deltachat-desktop` is **GPL-3.0**. Because
MPL-2.0 is GPL-compatible, the combined work is distributable under
GPL-3.0-or-later.

Not affiliated with Delta Chat. "Delta Chat" and its logos are trademarks of
their owners; this project only reuses the code under the licenses above.
