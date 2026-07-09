# Changelog viewer

The static changelog page served at `/changelog/` on the deployed site (e.g.
`web.slothful.chat/changelog`). It shows the release notes for the three npm
packages this project publishes: `@slothfulchat/core-wasm`,
`@slothfulchat/ws-tcp-proxy` and `@slothfulchat/customize`.

Vendored (code copy, then trimmed) from
[experintellia/deltachat-changelogs](https://github.com/experintellia/deltachat-changelogs) —
the same single-page viewer, cut down to our three clients and pointed at
local markdown instead of pulling live from GitHub/Codeberg.

## Files

- `index.html` — the whole viewer: tabs, sidebar TOC with year groups, search,
  scroll-spy, relative-date toggle, mobile drawer.
- `markdown-it.min.js` — vendored markdown renderer
  ([markdown-it](https://github.com/markdown-it/markdown-it), MIT). No CDN.

## How it is deployed

`packages/web-app/assemble.mjs` copies this folder into `dist/changelog/` and
drops each package's `CHANGELOG.md` in beside it as `<name>.md`
(`core-wasm.md`, `ws-tcp-proxy.md`, `customize.md`). The page then `fetch`es
those files with relative URLs, so the changelog always matches the versions
that were current when the site was built — no live network calls, no CDN
(keeps the app's `script-src 'self'` CSP happy).

## Local preview

The page needs the three `.md` files next to it, which only exist after an
assemble. From a built `packages/web-app/dist`:

```sh
python3 -m http.server 3000 --directory packages/web-app/dist
# then open http://localhost:3000/changelog/
```
