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
- `openrpc/index.html` — the OpenRPC page: header, links, and the mount point.
- `openrpc/viewer.js` — what renders into it: `@open-rpc/docs-react`
  (Apache-2.0), the OpenRPC project's own renderer, so the spec's shapes stay
  their problem rather than ours. `assemble.mjs` bundles this with esbuild into
  `viewer.js` + `viewer.css` in `dist/`, everything inlined — the page's only
  request is the same-origin, relative `../openrpc.json`, which is what keeps
  it inside `script-src 'self'` on GitHub Pages and self-hosted Caddy.
  React + MUI are **devDependencies of this package only**; nothing here is
  published, and `@slothfulchat/core-wasm`'s runtime dependencies are untouched.
  docs-react pins `react@18.3.1` as a peer — the exact version, not a range —
  so that is the version in this package's devDependencies, and aligning on the
  app's React 19 is not on offer. The app keeps 19 because `react` resolves
  relative to the importing file and the only React UI in the bundle is
  `packages/calls/ui`, which has its own. That split is load-bearing and silent
  if it breaks (the app would just ship React 18), so it is enforced rather than
  documented: `../react-isolation.test.mjs`, in CI's pure-helper suite.
- `openrpc/deref.mjs` — the one thing docs-react does not do: inline the
  document's `$ref`s. Without it every method renders with empty parameters.
  Self-check: `node --test packages/web-app/api-docs/openrpc/deref.test.mjs`.
- `typedoc.json` — typedoc options (project name, readme, sort order, entry
  point and out dir in `build/core`). Paths inside resolve relative to this
  file. Deliberately no `navigationLinks`/`titleLink`: typedoc writes those
  hrefs verbatim into pages that sit at two different depths, so no value is
  right on all of them — the file says so at length.
- `typedoc-readme.md` — rendered as the typedoc site's index page; the "this is
  a fork, get the types from `@slothfulchat/core-wasm`" framing, and the
  cross-links to the OpenRPC spec and `/api-docs/`. It is the one page where a
  relative link out of the typedoc site resolves, which is why they live here.

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
| `openrpc/viewer.{js,css}` | esbuild over `openrpc/viewer.js` here        |
| `openrpc.json`          | `build/core/…/typescript/generated/openrpc.json` |
| `typescript/`           | `build/core/…/typescript/docs/` (typedoc)      |

It warns and skips the whole block — the esbuild call included — unless BOTH
`build/core`'s typedoc output and its `generated/openrpc.json` are there, so
`pnpm assemble` on its own never requires a cargo build. Both, because typedoc
needs no cargo: a `build/core` documented before `patches/core/0031` has one and
not the other. The tree is excluded from the service worker precache
(`precacheSkip` matches the `api-docs/` prefix, so subdirectories are covered;
that is what keeps the ~1.4 MB `viewer.js` out of the offline app shell).

## Local preview

```sh
python3 -m http.server 3000 --directory packages/web-app/dist
# then open http://localhost:3000/api-docs/
```
