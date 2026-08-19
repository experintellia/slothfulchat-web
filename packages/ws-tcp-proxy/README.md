# @slothfulchat/ws-tcp-proxy

The one server piece [slothfulchat-web](../../README.md) needs. Browsers can't
open raw TCP sockets, so the in-browser wasm chatmail core tunnels its IMAP/SMTP
connections and DNS lookups through this WebSocket bridge. **TLS terminates
inside the wasm core** — the bridge only ever relays ciphertext, it never sees
your credentials or messages.

It's a single ~300-line file (plus an optional second one for the off-by-default
[unfurl endpoint](#unfurl-endpoint-optional-for-link-previews)). Read it before
you run it — that's the point.

## Run it

```sh
# npx (no install):
npx @slothfulchat/ws-tcp-proxy

# or download the one file and run it yourself (for the sceptical):
curl -O https://raw.githubusercontent.com/experintellia/slothfulchat-web/main/packages/ws-tcp-proxy/ws-tcp-proxy.mjs
npm install ws   # the single dependency (Node has no built-in WebSocket *server*)
node ws-tcp-proxy.mjs
```

Listens on `ws://127.0.0.1:8641` — **loopback only** (override the port with
`PORT`, the bind address with `HOST`). Point the web app at a non-default bridge
with `?proxy=wss://your-host` (or the `slothfulchat.proxyUrl` localStorage key).

Hosting it for others? Set **both** `HOST` and `CHATMAIL_ALLOWLIST` — the bridge
refuses to start with a network-reachable bind and no allowlist, because that
combination is an open relay to any mail server (see below):

```sh
HOST=0.0.0.0 CHATMAIL_ALLOWLIST=chatmail.example npx @slothfulchat/ws-tcp-proxy
```

There is still **no authentication and no Origin check** — anyone who can reach
the port can use the bridge, within the allowlist. Put it behind your TLS
reverse proxy and keep the allowlist tight.

## Endpoints

- `GET /dns/{host}` — resolves the name, replies with one JSON array of IPs, closes.
  `/dns/localhost` is always answered with the loopback IPs without hitting the
  resolver (and regardless of the allowlist), so the web app can use it as a
  bridge-reachability health check. Those loopback IPs are only tunnelable via
  `/tcp` if `localhost` is explicitly listed in `CHATMAIL_ALLOWLIST`.
- `GET /tcp/{ip}/{port}` — raw bidirectional byte tunnel to `ip:port`. Only ports
  143, 465, 587, 993 (IMAP/SMTP) are allowed.

## Allowlist (for hosting a public bridge)

Set `CHATMAIL_ALLOWLIST` to a comma-separated list of chatmail domains to run a
bridge that can only reach vetted servers:

```sh
CHATMAIL_ALLOWLIST=nine.testrun.org,chatmail.example npx @slothfulchat/ws-tcp-proxy
```

- DNS still resolves any name.
- Only IPs resolved for an **allowlisted** domain are added to an in-memory
  allow-list (10-minute TTL).
- TCP tunnels are refused (`4003 forbidden`) unless the target IP is on that
  allow-list.

Empty/unset `CHATMAIL_ALLOWLIST` = allow all — only usable on the default
loopback bind, where nobody else can reach it. A non-loopback `HOST` with an
empty allowlist **refuses to start**.
(`CHATMAIL_WHITELIST`, the pre-0.1.2 name, still works but warns.)

| Variable | What it does | Default |
|---|---|---|
| `PORT` | Port to listen on. | `8641` |
| `HOST` | Bind address. `0.0.0.0` (or one interface address) to expose it; then `CHATMAIL_ALLOWLIST` is mandatory. | `127.0.0.1` |
| `CHATMAIL_ALLOWLIST` | Comma-separated chatmail domains the bridge may reach. | empty (allow all) |
| `MAX_CONNECTIONS` | Open tunnels served in total. | `512` |
| `MAX_CONNECTIONS_PER_IP` | Open tunnels one client may hold. | `16` |
| `TUNNEL_CONNECT_MS` | Dial deadline for a tunnel's TCP connection. | `10000` |
| `TUNNEL_IDLE_MS` | Silence before a tunnel is dropped. Keep it well above your IMAP `IDLE` interval. | `1800000` |
| `TRUST_PROXY` | `1`: read the client address from `X-Forwarded-For` rather than the socket. Only where your reverse proxy overwrites that header — otherwise it is a limit bypass. | off |
| `UNFURL` | `1`/`0` to force the link-preview endpoint on/off. | on iff no allowlist |
| `UNFURL_DEADLINE_MS` | Wall-clock ceiling for one unfurl (redirects + page + image together). | `20000` |

## Resource limits

The bridge is meant to survive a hostile or broken client, so it also caps what
one can consume: 256 KB per WebSocket frame (IMAP/SMTP records are kilobytes),
512 open tunnels overall and 16 per client, 120 new connections per client per
minute, a 10 s dial deadline, a 30 min idle deadline and a 12 h hard lifetime
per tunnel, a 30 s ping that reaps peers which vanished without closing, and
backpressure in both directions — if either side stops reading, the bridge
stops reading from the other rather than buffering the difference in memory.

Resolved-IP authorizations (the allowlist above) are remembered **per client**:
one client resolving an allowlisted domain does not open that IP for anyone
else, which matters when an allowlisted domain shares an address with unrelated
services.

## Unfurl endpoint (link previews)

The bridge also serves `GET /unfurl?url={http(s) URL}` on the same port as the
tunnel (implemented in [`unfurl.mjs`](unfurl.mjs), a second single file): it
fetches the page + its `og:image` server-side and returns parsed OpenGraph
metadata as JSON with `Access-Control-Allow-Origin: *`. The webapp's composer
uses it as the fallback for link previews when browser CORS blocks the direct
fetch. **There is nothing to configure app-side** — the app derives the unfurl
URL from the bridge it's already pointed at (`?proxy=`, `ws→http`).

**Enabled by default on an allow-all bridge** (no `CHATMAIL_ALLOWLIST`) — a
local/personal bridge that already reaches anywhere, so a same-host preview
fetcher is fine and needs zero config. **Disabled by default once an allowlist
is set**: a hosted bridge that carefully vets its mail destinations shouldn't
silently double as an open web-preview fetcher, so there you opt in explicitly
with `UNFURL=1`. `UNFURL=1` / `UNFURL=0` overrides the default either way. A
bridge with it off answers `/unfurl` with `404` and the preview quietly falls
back to "not available".

This is a *preview fetcher*, not a tunnel: **HTTP GET only**; DNS is resolved
by the handler and only globally routable unicast addresses are allowed out —
loopback, private, CGNAT, link-local (incl. cloud metadata), documentation /
benchmark, multicast and reserved ranges are all refused (checked inside the
socket's own `lookup`, so a rebinding resolver can't swap the address —
literal-IP hosts are checked separately); redirects (max 5) re-run the checks
per hop; 1 MB page / 4 MB image caps; 15 s per-socket inactivity timeout plus a
20 s absolute deadline shared by every hop of one unfurl; 30 requests/min per
client and at most 4 unfurls in flight at a time. Log lines name a target's
scheme and host only, never its path or query — those routinely carry share
tokens.

(`UNFURL_ALLOW_PRIVATE=1` disables the private-IP guard for the test suite —
never set it on a real deployment.) Note that recent Chromium blocks pages
from fetching `localhost` services without a Local Network Access permission
prompt — a deployed (https, non-local) bridge avoids that.

## License

[Unlicense](UNLICENSE) — public domain. Do whatever you want with it. (The rest
of [slothfulchat-web](../../README.md) is GPL-3.0-or-later; this standalone
bridge is deliberately unencumbered so anyone can reuse it.)
