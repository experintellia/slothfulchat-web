# Changelog

## Unreleased

- New package: `engine/` (pure TS, no React/DOM imports) + `ui/` (React) +
  `bridge/` (runtime glue) skeleton, wired into the pnpm workspace and the
  `@slothfulchat/web-app` build (workspace dependency + `tsconfig.json`
  "paths"). The engine/ui/bridge split is enforced at both the type level
  (`engine/tsconfig.json` has no `"jsx"`) and the import level
  (`scripts/check-calls-engine-boundary.mjs`, wired as `lint:engine-boundary`).
  No feature logic yet — see `docs/calls.md` for the milestone plan.
