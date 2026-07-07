# Changelog

## 0.1.1 — 2026-07-07

- README: the download-one-file path needs a local `npm install ws`
  (Node's built-in WebSocket is client-only; a server still needs `ws`).

## 0.1.0 — 2026-07-07

- Initial release: WebSocket→TCP bridge (`/dns/{host}`, `/tcp/{ip}/{port}`),
  IMAP/SMTP ports only, optional `CHATMAIL_WHITELIST`.
