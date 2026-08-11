# SlothfulChat core API

**This is not upstream Delta Chat's API reference.** It documents
[SlothfulChat](https://github.com/experintellia/slothfulchat-web)'s fork of
[chatmail core](https://github.com/chatmail/core) — the pinned core commit with
this repository's `patches/core` stack applied — so it describes the JSON-RPC
API **this bundle actually runs**, not the nearest published upstream release.

It is regenerated from that patched Rust source on every build, by the same
`cargo test` that emits the client bindings. Items the fork added or changed
carry a 🦥 note in their description saying which patch did it.

## Getting these types

There is no separate types package. The generated client and its declarations
ship inside **`@slothfulchat/core-wasm`**:

```ts
import { BaseDeltaChat, C, type T } from '@slothfulchat/core-wasm'
```

Do not install `@deltachat/jsonrpc-client` alongside it — you would get two
nominally distinct declarations of the same types, and `BaseDeltaChat` /
`yerpc.BaseTransport` clash where structural typing does not save you.

## Start here

- **{@link RawClient}** — every JSON-RPC method lives on this class. If you are
  looking for a call, it is here.
- {@link BaseDeltaChat} — `RawClient` plus the event loop; `.rpc` is the
  `RawClient`.
- `T` — the request/response types. `C` — the generated constants.

## The same API, described twice

- **this page** — the TypeScript reference (TypeDoc over the generated client).
- <a href="../openrpc/"><strong>OpenRPC spec</strong></a> — the same methods as
  a machine-readable OpenRPC document, browsable, with the
  <a href="../openrpc.json">raw <code>openrpc.json</code></a> next to it for
  pointing tools at.
- <a href="../index.html">/api-docs/</a> — the signpost page both hang off.
  Spelled with the filename, not `../`: typedoc rewrites a relative link that
  resolves to something next to THIS file into a `media/` copy, and `../` is
  `packages/web-app/`. All three targets are outside the source tree, so they
  survive verbatim.

These links resolve from this page only — it is the one typedoc page at the root
of the site. From a deeper page, the site title in the header comes back here.
