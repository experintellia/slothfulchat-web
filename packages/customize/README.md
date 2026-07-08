# @slothfulchat/customize

Self-host [SlothfulChat](https://github.com/experintellia/slothfulchat-web)
without rebuilding anything: this tool takes a prebuilt release zip and bakes
in your instance name (tab title, PWA name), imprint (legal notice), and
default WS-TCP bridge, then writes a customized zip you upload to any static
host.

```sh
npx @slothfulchat/customize
```

It downloads the latest release zip, prompts for the values (Enter skips one),
and writes `slothfulchat-web-custom.zip`. Options:

```sh
npx @slothfulchat/customize --in slothfulchat-web-v0.2.0.zip --out my-instance.zip
```

Values can also be passed via the `SLOTHFUL_*` environment variables — the
same ones documented in
[SELFHOSTING.md](https://github.com/experintellia/slothfulchat-web/blob/main/SELFHOSTING.md),
which also explains the one server piece you still need (the WS-TCP bridge).

The same script is attached to every GitHub release as
`slothfulchat-customize.mjs` — `node slothfulchat-customize.mjs` works
standalone, no npm needed.

How it works: the release zip is a generic build; all instance config lives in
a handful of generated text files (`config.js`, `imprint.html`, the HTML
`<title>`, `manifest.webmanifest`). The tool regenerates exactly those files
with the same templates the build uses, recomputes the service-worker precache
manifest (so installed PWAs pick up the change), and never touches the app
bundle or the wasm core.
