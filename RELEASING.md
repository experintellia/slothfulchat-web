# Releasing (npm packages + GitHub release)

Three packages are published from this repo, plus the (private) web app. They
move as **one synced release train**: a tag `vX.Y.Z` means *every* package is
at `X.Y.Z` — one version number describes the whole release, matching the git
tags. Bump them all in lockstep even when a package didn't change; the numbers
stay aligned, so a version's changelog may simply have no entry for a package
that was untouched that release (gaps in a package's *changelog* are expected;
gaps in its *version number* no longer happen).

- `@slothfulchat/ws-tcp-proxy` — packages/ws-tcp-proxy, no build step
- `@slothfulchat/core-wasm` — packages/core-wasm, built from the patched core
- `@slothfulchat/customize` — packages/customize, esbuild-bundled from
  packages/web-app/customize.mjs (`prepack` builds it automatically)
- `@slothfulchat/web-app` — private (not published to npm), shipped as the
  release zip; it still carries the synced version.

The version lives in each `packages/*/package.json` (the source of truth) —
`node scripts/set-release-version.mjs X.Y.Z` (or `pnpm set-version X.Y.Z`)
sets all of them at once. `verify-release-tag.yml` checks on the tag that they
all match `vX.Y.Z` and fails the run otherwise, so a half-bumped set never
ships. It also refuses a tag whose commit isn't on `main`, or that moved after
the run started: the tag is the only release authority.

Both `publish-npm.yml` (npm) and `deploy-pages.yml` (prod, web.slothful.chat)
run that same gate as their first job, so neither can ship what the other
would reject. Re-running either by hand works, but only with the tag itself as
the ref (`gh workflow run publish-npm.yml --ref v0.3.0`) — a branch run
publishes and deploys nothing.

The gate also refuses a commit whose required CI checks aren't green, so tag
only what CI has already finished — see
[Repository settings the release model depends on](#repository-settings-the-release-model-depends-on)
for the half of this that lives in GitHub settings rather than in git.

## The flow

Everything is automated by `.github/workflows/publish-npm.yml`, triggered by
any `v*` tag. The workflow rebuilds from a clean checkout and does two things:

- **GitHub release**: builds a generic web-app dist (no `SLOTHFUL_*` vars) and
  creates a release with `slothfulchat-web-<tag>.zip` + the standalone
  `slothfulchat-customize.mjs` (see SELFHOSTING.md for how operators use them).
- **npm**: publishes **each package whose package.json version is not on the
  registry yet** — versions already on the registry are skipped. Since every
  release bumps all three to a fresh number, they normally all publish; the
  skip only makes re-running the same tag idempotent (a complete GitHub
  release is likewise skipped — releases are immutable, so assets attach at
  creation only; an asset-less one must be deleted before re-running).

1. Pick the next tag version (strictly greater than the last — the whole train
   moves up together) and set it everywhere at once:

   ```sh
   pnpm set-version 0.3.0   # -> node scripts/set-release-version.mjs 0.3.0
   ```

   Then add a `## 0.3.0 — <date>` entry to the `CHANGELOG.md` of each package
   that actually changed (npm always includes CHANGELOG.md in the tarball);
   packages that didn't change just carry the bumped version with no new entry.

   Also refresh [PATCHES.md](PATCHES.md) — the human-readable summary of the
   upstream patch stack — whenever `patches/` changed since the last release:
   go over the patch files (each starts with its commit message) and fold
   anything new or removed into the fitting section there.
   Finally write the release device message — see
   ["What's new" device message](#whats-new-device-message) below. It ships in
   the app, so it has to be in before the tag.
2. Commit, then tag and push (the tag must match the version you just set —
   `publish-npm.yml` rejects a tag whose packages drifted):

   ```sh
   git tag v0.3.0
   git push origin v0.3.0
   ```

3. Watch the Actions run (`gh run watch`). The core-wasm wasm build takes
   ~10 min uncached; publish happens at the end.
4. Verify: `npm view @slothfulchat/<pkg> version` shows the new version.

## "What's new" device message

Every existing account gets one short message in its device chat per release,
from `updateDeviceChat()` in `build/desktop/packages/frontend/src/deviceMessages.ts`
under the label `changelog-version-X.Y.Z` (brand-new accounts skip it, and the
label makes it a no-op once added). For most users this is the only release
note they will ever read — treat it as the release's user-facing summary, not
as a changelog dump.

Where it goes: keep all release messages in **one** desktop patch and amend it
each release, so the stack doesn't grow a patch per version. The text is a
plain literal in `deviceMessages.ts`, not an `_untranslated_en.json` key —
release-specific blurbs go stale before anyone could translate them.

**A human approves the text before it is committed. Always.** Drafting it with
an AI is fine and is what the recipe below is for; shipping a draft nobody
read is not. It reaches every user, and it cannot be edited or withdrawn once
released.

Recipe — hand this to whoever (or whatever) drafts it:

> 1. Gather from the repo:
>    - the last released tag: `git fetch --tags; git tag --sort=-v:refname | head -3`
>    - the version being released — **the one you are about to tag.**
>      `packages/*/package.json` still holds the *previous* version until step 1
>      of the release runs, so don't read it from there unless the bump already
>      happened.
>    - what changed: `git log --oneline <last-tag>..HEAD` plus the new
>      `## <version>` sections of `packages/*/CHANGELOG.md`.
> 2. Write it:
>    - 3-4 bullets, lead with the single biggest thing.
>    - Only what a user notices, in their words. No mechanism, no root cause —
>      those live in the commit message. Drop refactors, CI, patch-stack
>      chores, dependency bumps, internal hardening.
>    - Operator-facing changes (bridge config, self-hosting) count only through
>      their user-visible result — describe what someone using the app would
>      see, never the flag or the deployment step.
>    - Plain text: device messages are not markdown, URLs autolink. Emoji
>      sparingly.
>    - Under ~600 characters including the header and the link line.
>    - Close with the version's own anchor on the public instance, e.g.
>      `https://web.slothful.chat/changelog/?p=web-app#v-0.9.0` — the anchor
>      carries the version, so the link keeps pointing at this release once
>      later ones ship. Check the `## X.Y.Z` heading exists first, or it
>      resolves to nothing.
>    - Never claim a change you can't point at a commit or changelog entry for.
> 3. Deliver a "changes since <last tag>" list for the release engineer, plus
>    **three variants** to choose between, and say what you had to guess.

The variants are for a person to pick from and edit — expect to refine the
chosen one before it goes in.

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

## Repository settings the release model depends on

The workflows can only check what a run gives them. Who may create a `v*` tag,
who may approve a deploy, and what must be green on `main` are **repo settings**
— they are not in version control, so this is the record of what they have to
be. They matter because a tag-push run executes the workflow files *at the
tagged commit*: someone who can push a `v*` tag to a commit of their choosing
can also push one where `verify-release-tag.yml`, or the caller's `needs:` on
it, has been deleted. The gate cannot defend itself; the tag ruleset is what
defends it.

Admin checklist — each item is one setting, with what it prevents:

- [ ] **Tag ruleset for `v*`** (Settings → Rules → Rulesets → New tag ruleset).
      Target `v*`; enable *Restrict creations*, *Restrict updates* and
      *Restrict deletions*; bypass list = the release maintainers only, nobody
      else (no "Repository admin" blanket entry, no apps). Without it, any
      write-access account can tag anything and ship it with the gate removed.
- [ ] **Branch ruleset for `main`**. Require a pull request before merging,
      ≥1 approval, *Dismiss stale approvals when new commits are pushed*, and
      *Require approval of the most recent reviewable push* (so the person who
      pushed last cannot be the only approver). Require status checks: `lint`
      and `test` — the same names the release gate demands on the tagged
      commit; keeping the two lists equal is what makes "on main" imply
      "tested". Block force pushes and deletions. Keep the bypass list empty.
- [ ] **`github-pages` environment** (Settings → Environments → github-pages).
      *Deployment branches and tags* = `v*` only — already configured, and
      tag deploys are rejected without it. Add **required reviewers** (release
      maintainers) and *Prevent self-review*: today prod deploys with no human
      in the loop once a tag exists.
- [ ] **A protected environment for the npm publish.** `publish-npm.yml` uses
      none, so the trusted-publisher OIDC token is minted with no approval step
      at all. Create one (e.g. `npm`) with the same `v*` tag rule and required
      reviewers, then reference it from the publish job — the job that holds
      `id-token: write`, and only that one.
- [ ] **Actions settings** (Settings → Actions → General): workflow permissions
      default to *read repository contents*, and *Allow GitHub Actions to
      create and approve pull requests* stays off.

Read back what is actually configured (settings drift, and nothing here fails
a build when it goes missing):

```sh
gh api repos/:owner/:repo/rulesets --jq '.[] | "\(.target) \(.name) \(.enforcement)"'
gh api repos/:owner/:repo/environments --jq '.environments[].name'
gh api repos/:owner/:repo/environments/github-pages --jq '.protection_rules'
```

## The jsonrpc-client dependency (core-wasm)

core-wasm's published package.json depends on the **npm release** of
`@deltachat/jsonrpc-client` (types for consumers; the runtime is bundled into
`dist/`). Local/CI builds override it to the freshly generated client from the
patched core via `overrides:` in `pnpm-workspace.yaml`, so builds always match
the core. When vendor/core moves to a new upstream release, bump the npm
version in packages/core-wasm/package.json to the matching release.
