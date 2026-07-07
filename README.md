# slothfulchat-web

Feasibility prototype: a DeltaChat client running **fully in the browser** — chatmail core compiled to WASM, driving the deltachat-desktop frontend as a standalone PWA. Private patch-stack experiment, **no upstream contribution intended**. Not affiliated with Delta Chat.

See [SELFHOSTING.md](SELFHOSTING.md) to run your own instance, [PLAN.md](PLAN.md) for the full plan, [DESCOPED.md](DESCOPED.md) for deliberate omissions, [FINDINGS.md](FINDINGS.md) for the feasibility log.

## Layout

- `vendor/core`, `vendor/deltachat-desktop` — submodules pinned at upstream commits (never modified in place)
- `patches/core`, `patches/desktop` — stacked `git format-patch` files, the only upstream modifications
- `build/` — throwaway worktrees: pinned commit + patches applied (gitignored)
- [`packages/core-wasm`](packages/core-wasm/README.md) — deliverable 1: npm package, WASM core behind the standard `@deltachat/jsonrpc-client` TypeScript API
- [`packages/web-app`](packages/web-app/README.md) — deliverable 2: standalone browser frontend using core-wasm
- [`packages/ws-tcp-proxy`](packages/ws-tcp-proxy/README.md) — the WS→TCP bridge (the one server piece; npx-able, optional chatmail-server allowlist)

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
