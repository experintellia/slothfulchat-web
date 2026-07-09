# @slothfulchat/ws-tcp-proxy

The one server piece [slothfulchat-web](../../README.md) needs. Browsers can't
open raw TCP sockets, so the in-browser wasm chatmail core tunnels its IMAP/SMTP
connections and DNS lookups through this WebSocket bridge. **TLS terminates
inside the wasm core** — the bridge only ever relays ciphertext, it never sees
your credentials or messages.

It's a single ~90-line file. Read it before you run it — that's the point.

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
  bridge-reachability health check.
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

## License

[Unlicense](UNLICENSE) — public domain. Do whatever you want with it. (The rest
of [slothfulchat-web](../../README.md) is GPL-3.0-or-later; this standalone
bridge is deliberately unencumbered so anyone can reuse it.)
