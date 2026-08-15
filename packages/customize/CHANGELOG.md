# Changelog

## 0.9.0 — 2026-08-15

- The downloaded release zip is now verified before it is used: the asset is
  picked by its published name (`slothfulchat-web-<tag>.zip`) instead of "the
  first `.zip`", and its sha256 digest is checked against the release metadata.
  A missing digest or a mismatch aborts the run rather than customizing
  whatever arrived.
- Archive size is capped as well — download bytes, entry count and total
  expanded size — so a corrupt or hostile zip (including an oversized `--in`
  file) is rejected instead of exhausting memory while unpacking.
- `SLOTHFUL_RELAY_DIRECTORY` is now offered like every other variable: it was
  supported but never prompted for, so anyone using the interactive flow ended
  up with the default relay directory whether they wanted it or not.
- Two new variables are prompted for, both for the dialog shown when the app
  fails to start: `SLOTHFUL_SUPPORT_URL` (an "Open an issue" button pointing at
  your tracker) and `SLOTHFUL_CRASH_REPORT_URL` (a "Send to the developers"
  button pointing somewhere that needs no account). Leave either unset to drop
  that button; with neither set, users copy the details by hand as before.

## 0.6.0 — 2026-07-15

- New `SLOTHFUL_RELAY_DIRECTORY` variable: relay-directory JSON for the
  onboarding relay picker (an https URL, or `off` to hide the picker; unset =
  the chatmail-relays-mirror default). The CSP re-patch (`patchCsp`) now pins
  this URL alongside the analytics origin, replacing whatever relay pin the
  zip carried.

## 0.5.1 — 2026-07-12

- Regenerates `privacy.html` and re-patches the CSP `connect-src` for the
  analytics origin on every run: analytics is baked-in config that
  re-customising a zip flips off (self-hosted builds collect nothing), so the
  privacy page and CSP now follow it. The CSP patch is idempotent — origins
  baked by a previous build are stripped before this instance's is added.

## 0.4.0 — 2026-07-10

<!-- shipped in the 0.4.0 tarball, but mislabeled "Unreleased" in its copy of
     this file -->

- Prompts for (and honors the `SLOTHFUL_DEFAULT_CHATMAIL` env var of) a new
  default chatmail relay, baked into `window.__slothfulConfig` so the "create
  new account" onboarding flow signs up on the operator's own relay.
- Also carries the `version` field of `window.__slothfulConfig` through
  `config.js` regeneration (alongside `commitHash`/`commitMessage`), so the
  version shown in the web app's About dialog survives relabeling a release
  zip.

## 0.3.0 — 2026-07-09

- Preserves the source-commit info baked into a release zip
  (`commitHash`/`commitMessage` in `window.__slothfulConfig`, shown in the
  web app's About dialog as of this release) when relabeling: customize has
  no working tree to read git from, so it carries the zip's existing values
  through `config.js` regeneration instead of dropping them.
- The existing-`config.js` re-parse is tolerant of minor format drift
  (sliced from the first `{` rather than an exact prefix match), degrading
  to an empty commit line rather than failing the run.
- Version jump 0.1.0 → 0.3.0: package versions now track the release tag
  (see RELEASING.md).

## 0.1.0 — 2026-07-08

- Initial release: customize a prebuilt SlothfulChat release zip without
  rebuilding anything. `npx @slothfulchat/customize` downloads the latest
  release (or takes `--in <zip>`), prompts for the `SLOTHFUL_*` values (env
  vars are honored, Enter skips one), regenerates `config.js` and
  `imprint.html`, bakes the instance name into the tab title, PWA manifest
  and boot-error screens, recomputes the service-worker precache manifest so
  installed PWAs pick up the change, and writes a ready-to-host zip. The same
  script ships standalone as `slothfulchat-customize.mjs` on each GitHub
  release.
