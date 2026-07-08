# Releasing (npm packages + GitHub release)

Three packages are published from this repo, with **independent versions**:

- `@slothfulchat/ws-tcp-proxy` — packages/ws-tcp-proxy, no build step
- `@slothfulchat/core-wasm` — packages/core-wasm, built from the patched core
- `@slothfulchat/customize` — packages/customize, esbuild-bundled from
  packages/web-app/customize.mjs (`prepack` builds it automatically)

## The flow

Everything is automated by `.github/workflows/publish-npm.yml`, triggered by
any `v*` tag. The workflow rebuilds from a clean checkout and does two things:

- **GitHub release**: builds a generic web-app dist (no `SLOTHFUL_*` vars) and
  creates a release with `slothfulchat-web-<tag>.zip` + the standalone
  `slothfulchat-customize.mjs` (see SELFHOSTING.md for how operators use them).
- **npm**: publishes **each package whose package.json version is not on the
  registry yet** — packages whose version already exists are skipped. So one
  shared tag releases whatever was bumped, and re-running is idempotent
  (release assets are re-uploaded with `--clobber`).

1. Bump `version` in the package(s) you're releasing
   (`packages/*/package.json`) and add an entry to that package's
   `CHANGELOG.md` (npm always includes CHANGELOG.md in the tarball).
2. Commit, then tag and push:

   ```sh
   git tag v0.2.0        # tag name is just the trigger; only bumped
   git push origin v0.2.0  # package versions matter
   ```

3. Watch the Actions run (`gh run watch`). The core-wasm wasm build takes
   ~10 min uncached; publish happens at the end.
4. Verify: `npm view @slothfulchat/<pkg> version` shows the new version.

## Auth

npm Trusted Publishing (OIDC) — no token secrets. Each package's npmjs.com
Settings → Trusted Publisher points at this repo + `publish-npm.yml` (never
rename that file). If the publish step fails auth, that config is the first
thing to check.

**Brand-new packages can't be created via trusted publishing**: the first
version must be published manually (see fallback below), then the Trusted
Publisher can be configured on the now-existing package.

Manual fallback (e.g. registry config broke): a granular access token with
write on the `slothfulchat` org in `~/.npmrc`
(`//registry.npmjs.org/:_authToken=...`), then `npm publish --access public`
from the package dir. Account 2FA is a security key, so interactive
`npm login` needs a browser; the token path is the reliable one.

## Pre-publish sanity checks (local)

```sh
# core-wasm needs build/core (pnpm apply-patches) + build:wasm + build first.
cd packages/<pkg> && npm pack --dry-run
```

Things that have silently broken before — check the dry-run output for them:

- **wasm-dist missing from the tarball**: wasm-pack writes a `.gitignore`
  containing `*` into wasm-dist, and `npm pack` honors it. `build:wasm`
  deletes it; if the file list has no `wasm-dist/*.wasm`, that's the cause.
- **`dist/index.d.ts` missing**: the build must run `tsc
  --emitDeclarationOnly` (not `--noEmit`) or the published `exports.types`
  points at nothing.

## The jsonrpc-client dependency (core-wasm)

core-wasm's published package.json depends on the **npm release** of
`@deltachat/jsonrpc-client` (types for consumers; the runtime is bundled into
`dist/`). Local/CI builds override it to the freshly generated client from the
patched core via `overrides:` in `pnpm-workspace.yaml`, so builds always match
the core. When vendor/core moves to a new upstream release, bump the npm
version in packages/core-wasm/package.json to the matching release.
