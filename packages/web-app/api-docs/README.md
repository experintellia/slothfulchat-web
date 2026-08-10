# /api-docs/

The core JSON-RPC API reference served at `/api-docs/` on the deployed site
(e.g. `web.slothful.chat/api-docs/`). It documents **this fork's** API: the
pinned `vendor/core` commit with `patches/core` applied, which is the core the
shipped wasm bundle actually runs.

Nothing here is written by hand. Both references are generated from that
patched Rust source by `cargo test -p deltachat-jsonrpc` and typedoc; this
folder only holds the framing (project name, index pages, cross-links).

## Files

- `index.html` — the `/api-docs/` signpost: what this is, and links to both
  references plus the raw spec.
- `openrpc/index.html` — viewer for `openrpc.json`. Fetches it with a relative
  URL and renders methods, parameters, results and schemas. No CDN, no
  bundler, no runtime dependency — same shape as `../changelog/`.
- `typedoc.json` — typedoc options (project name, readme, RawClient-first
  navigation links, entry point and out dir in `build/core`). Paths inside
  resolve relative to this file.
- `typedoc-readme.md` — rendered as the typedoc site's index page; the "this is
  a fork, get the types from `@slothfulchat/core-wasm`" framing.

## How it is built and deployed

```sh
scripts/apply-patches.sh                 # build/core = pin + patches/core
cd build/core/deltachat-jsonrpc/typescript
pnpm install && cargo test -p deltachat-jsonrpc   # generated/{client,types}.ts + openrpc.json
node scripts/generate-constants.js && ./node_modules/.bin/tsc
cd - && pnpm api-docs                    # typedoc, with typedoc.json above
pnpm --filter @slothfulchat/web-app assemble
```

`assemble.mjs` then lays out `dist/api-docs/`:

| path                    | from                                          |
| ----------------------- | --------------------------------------------- |
| `index.html`            | `index.html` here                              |
| `openrpc/index.html`    | `openrpc/index.html` here                      |
| `openrpc.json`          | `build/core/…/typescript/generated/openrpc.json` |
| `typescript/`           | `build/core/…/typescript/docs/` (typedoc)      |

It warns and skips the whole block when `build/core`'s docs are absent, so
`pnpm assemble` on its own never requires a cargo build. The tree is excluded
from the service worker precache (`precacheSkip` matches the `api-docs/`
prefix, so subdirectories are covered).

## Local preview

```sh
python3 -m http.server 3000 --directory packages/web-app/dist
# then open http://localhost:3000/api-docs/
```
