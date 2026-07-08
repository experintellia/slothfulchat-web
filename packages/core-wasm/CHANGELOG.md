# Changelog

## 0.2.0 — 2026-07-08

- BREAKING (worker embedders only): the worker no longer reads `?proxy=` /
  `?persist=` from its script URL; `startCore` now sends a one-shot
  `{ type: 'config', proxyUrl, persist }` postMessage instead. Reason: a
  service worker serving the script from cache strips the query string from
  the response URL (= the worker's `import.meta.url`), which silently dropped
  the proxy config ("no WebSocket proxy configured" on every connection).
  Code using `startCore()` is unaffected.

## 0.1.1 — 2026-07-07

- In-wasm HTTP implemented via the browser's `fetch()` (was a bail-stub):
  https-URL `DCACCOUNT:` QR codes, provider autoconfig and the webxdc apps
  list now work where the endpoint's CORS headers allow it.
- README rewritten for the post-M5 state: networking via
  `@slothfulchat/ws-tcp-proxy` (`startCore({ wsProxyUrl })`), OPFS persistence
  on by default (`persist: false` opts out), hosted demo link, and the actual
  remaining limits (HTTP subject to CORS, one tab at a time, no sqlcipher).

## 0.1.0 — 2026-07-07

- Initial release: chatmail core 2.54.0-dev (2.53.0 + 54 commits + wasm patch
  stack) compiled to wasm, typed `@deltachat/jsonrpc-client` API, Web Worker
  transport, fs side channel, OPFS persistence, WebSocket→TCP networking.
