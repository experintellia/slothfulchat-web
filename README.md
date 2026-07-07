# slothfulchat-web

Feasibility prototype: a DeltaChat client running **fully in the browser** — chatmail core compiled to WASM, driving the deltachat-desktop frontend as a standalone PWA. Private patch-stack experiment, **no upstream contribution intended**. Not affiliated with Delta Chat.

See [PLAN.md](PLAN.md) for the full plan, [DESCOPED.md](DESCOPED.md) for deliberate omissions, [FINDINGS.md](FINDINGS.md) for the feasibility log.

## Layout

- `vendor/core`, `vendor/deltachat-desktop` — submodules pinned at upstream commits (never modified in place)
- `patches/core`, `patches/desktop` — stacked `git format-patch` files, the only upstream modifications
- `build/` — throwaway worktrees: pinned commit + patches applied (gitignored)
- [`packages/core-wasm`](packages/core-wasm/README.md) — deliverable 1: npm package, WASM core behind the standard `@deltachat/jsonrpc-client` TypeScript API
- [`packages/web-app`](packages/web-app/README.md) — deliverable 2: standalone browser frontend using core-wasm

## Workflow

```sh
git submodule update --init          # once
pnpm apply-patches                   # (re)create build/ from pins + patches
# ...edit inside build/<name>, one git commit per logical patch...
pnpm update-patches                  # regenerate patches/ from build/ commits
```

Requires: Node ≥ 22 + pnpm, Rust stable + `wasm32-unknown-unknown` target.
