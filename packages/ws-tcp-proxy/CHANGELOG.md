# Changelog

## Unreleased

- New unfurl endpoint: `GET /unfurl?url=…` on the same port returns OpenGraph
  metadata + the `og:image` (base64) as JSON with permissive CORS, the
  fallback for the webapp's link previews on CORS-blocked sites. A hardened
  preview fetcher in a second file (`unfurl.mjs`), not a tunnel: GET-only,
  private/loopback IPs refused at the socket's own lookup, per-hop redirect
  re-checks, size caps, timeout, rate limit. Enabled by default on an
  allow-all bridge, disabled once `CHATMAIL_ALLOWLIST` is set (a vetted hosted
  bridge shouldn't silently fetch arbitrary pages); `UNFURL=1` / `UNFURL=0`
  overrides.

## 0.4.0 — 2026-07-10

<!-- originally written as 0.3.1 on 2026-07-09, but never tagged or published
     under that number; renumbered to ride the v0.4.0 release train -->

- `/dns/localhost` is now answered with a hardcoded loopback reply
  (`127.0.0.1`, `::1`) without querying the resolver and regardless of any
  allowlist, so the web app's bridge-reachability health check works
  everywhere (`localhost` lives in `/etc/hosts`, not DNS). The loopback IPs
  only reach `/tcp` when `localhost` is explicitly on `CHATMAIL_ALLOWLIST`.

## 0.1.2 — 2026-07-07

- Rename `CHATMAIL_WHITELIST` to `CHATMAIL_ALLOWLIST`. The old name still
  works as a fallback but logs a deprecation warning.

## 0.1.1 — 2026-07-07

- README: the download-one-file path needs a local `npm install ws`
  (Node's built-in WebSocket is client-only; a server still needs `ws`).

## 0.1.0 — 2026-07-07

- Initial release: WebSocket→TCP bridge (`/dns/{host}`, `/tcp/{ip}/{port}`),
  IMAP/SMTP ports only, optional `CHATMAIL_WHITELIST`.
