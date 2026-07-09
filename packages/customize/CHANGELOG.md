# Changelog

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
