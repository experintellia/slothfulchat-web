# Vendored webxdc apps

Built apps that `scripts/test-webxdc-store-apps-e2e.mjs` runs against our webxdc
runtime. They are vendored so the e2e stays offline, like the rest of our e2e tests.
Both licenses allow redistribution, and this repo is GPL-3.0 too.

| File | Source | Commit | License |
|------|--------|--------|---------|
| `webxdc-test.xdc` | https://github.com/webxdc/webxdc-test | `7c570f24c2fede4a69f31531e7cd1a75f00df9f7` | GPL-3.0 (bundles eruda, MIT) |
| `realtime-check.xdc` | https://github.com/webxdc/webxdc-realtime-check (the app store's "Realtime Check") | `93c2e6c30c28704877610b650d86b92f4c41e183` (v1.0.5) | MIT (bundles React, cytoscape, zustand, msgpack, MIT) |

To rebuild them:

- **webxdc-test**: `./create-xdc.sh` in the checkout.
- **realtime-check**: `pnpm i && pnpm build`, then take `dist-xdc/app.xdc`. Our
  egress proxy blocks codeload.github.com, so the git dependency
  `consistent-color-generation` (jsxc, MIT, commit `336449275316de201c03c2012f648c5313e61847`)
  was cloned next to the checkout and linked in with
  `"pnpm": {"overrides": {"consistent-color-generation": "file:../consistent-color-generation"}}`.
  This only changes where the package is fetched from. The build output is the same.
