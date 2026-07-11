# @slothfulchat/ws-tcp-proxy

The one server piece [slothfulchat-web](../../README.md) needs. Browsers can't
open raw TCP sockets, so the in-browser wasm chatmail core tunnels its IMAP/SMTP
connections and DNS lookups through this WebSocket bridge. **TLS terminates
inside the wasm core** — the bridge only ever relays ciphertext, it never sees
your credentials or messages.

It's a single ~130-line file (plus an optional second one for the off-by-default
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

Listens on `ws://localhost:8641` (override with `PORT`). Point the web app at a
non-default bridge with `?proxy=wss://your-host` (or the `slothfulchat.proxyUrl`
localStorage key).

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

Empty/unset `CHATMAIL_ALLOWLIST` = allow all (local-dev default).
(`CHATMAIL_WHITELIST`, the pre-0.1.2 name, still works but warns.)

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
by the handler and private / loopback / link-local / CGNAT addresses are
refused (checked inside the socket's own `lookup`, so a rebinding resolver
can't swap the address — literal-IP hosts are checked separately); redirects
(max 5) re-run the checks per hop; 1 MB page / 4 MB image caps; 15 s timeout;
30 requests/min per client.

(`UNFURL_ALLOW_PRIVATE=1` disables the private-IP guard for the test suite —
never set it on a real deployment.) Note that recent Chromium blocks pages
from fetching `localhost` services without a Local Network Access permission
prompt — a deployed (https, non-local) bridge avoids that.

## License

[Unlicense](UNLICENSE) — public domain. Do whatever you want with it. (The rest
of [slothfulchat-web](../../README.md) is GPL-3.0-or-later; this standalone
bridge is deliberately unencumbered so anyone can reuse it.)
