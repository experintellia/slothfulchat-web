# Changelog

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
