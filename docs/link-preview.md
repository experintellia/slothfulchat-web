# Privacy-preserving link previews (sender-baked image cards)

Status: **increments 1+2 implemented** (UI prototype; core-native metadata is
the eventual goal, see below) · Branch: `claude/link-preview-ghost-ui-wcprj0`

## What & why

When you type a message that contains a URL and you haven't attached an image,
the composer shows a faint, dismissible **ghost card** offering to add a
preview. If you accept, the app fetches the link's OpenGraph metadata, renders a
preview **card into a PNG on the sender's device**, and attaches that PNG as the
message's image. The link text stays in the body.

This implements the Delta Chat forum's "privacy-preserving rich links" idea
([Generate link preview](https://support.delta.chat/t/generate-link-preview/1009),
[Options to have link previews](https://support.delta.chat/t/options-to-have-link-previews-in-delta/5138)):

- **The recipient never contacts the link's server.** Normal unfurling has the
  *receiving* client fetch the URL, leaking the recipient's IP/metadata to the
  website and breaking the E2E model. Here the *sender* — who already chose the
  link — builds the preview, so only the sender ever touches the site.
- **Compatible with every client, no protocol change.** The result is an
  ordinary text + image message. The "main" Delta Chat clients (and any other)
  render it as-is; there is nothing new to implement on the receive side.

The receive side needs **zero** changes: `ClickableLink.tsx` already renders the
URL, and the baked PNG renders as a normal image.

## Status: UI prototype now, core-native metadata later

This is deliberately a **frontend/desktop patch that attaches the preview as an
image** — a compromise to build and validate the UX quickly, while staying
compatible with every existing client (the preview is just an image, so nothing
new is needed on the receive side). It is **not** the intended final form.

The end goal is to move preview generation **into core** and carry the preview
as **real structured message metadata** (title / description / image / host as
first-class fields on the message), not a baked-in PNG — so clients can render a
native card, restyle it per theme, and handle it as data rather than a picture.
Treat the current image approach as scaffolding to iterate on the UI; when the
feature graduates into core, the desktop card here becomes a renderer over that
metadata.

**The unfurl endpoint is a webapp-only concern.** Native clients fetch URLs
directly with no CORS restriction, so they need no unfurl endpoint at all —
they just fetch and generate. Only the browser edition is CORS-bound and thus
routes through the bridge's unfurl endpoint. Keep that in mind so it doesn't leak into the
eventual core design.

## Decisions (locked)

| Topic | Decision |
|---|---|
| Ghost trigger | **Auto-appears**, quiet/dashed, when a URL is present and no file is attached; dismissible per URL |
| Fetch strategy | **The bridge's unfurl endpoint only** (no direct browser fetch — CORS makes it near-useless and it double-fetches). On by default for an allow-all bridge, off once an allowlist is set. Never the tunnel / an open proxy — see below |
| Manual editor | **None.** No preview for a page → ghost quietly disappears; unfurl endpoint unreachable → a quiet "needs a bridge with unfurl" hint |
| Image format | **PNG** (universally decoded; WebP intentionally avoided). Kept **≤ 0.6 MB** via a shrink-to-fit encode loop |
| Card surface | Self-contained **opaque light** surface (`#f4f6f9`), rounded corners + soft drop shadow; transparency only in the corner/shadow margin so it composites onto any theme |
| Layout | **Compact** (side thumbnail) or **Hero** (large top image), **auto-selected from the metadata**; video ⇒ hero + baked play glyph |
| Card controls | On the generated card: **remove (✕)** and **expand↔collapse (compact↔hero)**; re-composites locally, no re-fetch |
| Skeleton | Loading state is always a **slim compact bar**, never a blank hero box |

### Why a self-contained opaque card (not transparent-to-background)

The sender bakes one image but can't know the recipient's theme. A card that let
the chat colour show through behind the text could not keep the text legible on
both a white and a near-black chat. Instead the content sits on its **own**
opaque surface (contrast fixed at authoring time); the PNG is transparent **only**
in the rounded-corner cut-outs and the drop-shadow feather, and those pixels
composite cleanly onto any ground. A soft off-white surface (not pure white)
reads on every theme without glaring on dark ones. This is how Signal / Telegram
/ iMessage link cards survive light and dark.

### Why metadata-derived layout (not a hardcoded site list)

The site already declares how it wants to be shown; we read those signals
instead of maintaining a brittle per-domain table:

- `og:type` = `video*`, or `og:video` / `twitter:card=player` present → **hero** (+ play glyph)
- `twitter:card = summary_large_image` → **hero**
- large landscape `og:image` (wide aspect + decent `og:image:width/height`) → **hero**
- small / square / icon-ish image, or `twitter:card = summary` → **compact**
- no image → **compact**, text-only
- Manual expand/collapse always overrides.

## Fetch pipeline (unfurl endpoint only)

```
type in composer ──▶ detect first URL (debounced)
                         │
                 [ghost card auto-appears: "Add preview" / ✕]
                         │ user taps Add
                         ▼
   GET {bridge}/unfurl?url=…                 ← browser fetch of the bridge's
   (URL derived from ?proxy=, ws→http)         unfurl endpoint (sends ACAO)
                 │ ok                    │ endpoint unreachable
                 ▼                       ▼
   { title, description, image(base64),   "needs a bridge with unfurl" hint
     imageWidth/Height, isVideo, … }       (no preview → ghost/hint clears)
                 │
   choose compact/hero from metadata → draw card on <canvas>
                 │
   export PNG (shrink-to-fit ≤ 0.6 MB) → writeTempFileFromBase64
                 │
   addFileToDraft(path, "link-preview.png", "Image") → removeTempFile
```

**Why no direct browser fetch.** In this browser/wasm build the core's HTTP is
the browser's `fetch()` (`patches/core/0010`), which is CORS-bound — virtually
every real site blocks cross-origin reads of its HTML, so a direct-first attempt
almost always fails. Worse, a blocked cross-origin GET still *reaches* the site
(the browser blocks the response, not the request), so it just double-fetches
(sender's IP + bridge). So there is **no direct tier**: previews always go
through the bridge's unfurl endpoint, which also keeps the sender's IP off the
preview target (only the bridge touches it). Cost: the feature needs a bridge
with unfurl enabled — default-on for a local bridge; when the endpoint is
unreachable the composer shows a quiet hint instead of silently doing nothing.

**Why not "HTTP over the bridge" (the tunnel).** The obvious alternative —
opening ports 80/443 on the ws-tcp *tunnel* — would turn the bridge into an
**open TCP relay**: arbitrary bytes to arbitrary hosts, TLS-tunnelled so the
operator can't even see what flows. That is an open proxy usable for anything,
and no responsible public bridge should enable it. Rejected.

**The endpoint: unfurl on the bridge.** A `GET /unfurl?url=…` route on the
bridge's own HTTP port (`unfurl.mjs`, distinct from the tunnel) that fetches the
page server-side and returns the OpenGraph metadata plus the preview image
(base64) as JSON with a permissive `Access-Control-Allow-Origin`. The frontend
calls it via browser `fetch()`, deriving the URL from the configured bridge
(`?proxy=`, ws→http). It is a *preview fetcher*, not a relay: **HTTP GET only**,
blocks private/loopback/link-local IPs (checks the resolved IP inside the
socket's own `lookup`; refuses redirects into private ranges), caps response
size, has a timeout, and is rate-limited. **Enablement follows the allowlist**:
on for an allow-all (local/personal) bridge, off once `CHATMAIL_ALLOWLIST` marks
a vetted hosted bridge (opt back in with `UNFURL=1`). So a local user gets
CORS-blocked previews with zero config, while a hosted operator must choose to
turn the fetcher on.

**Privacy.** This is a fair trade: you already have to trust your bridge, so a
second self-hosted endpoint you also trust is not a new class of exposure. The
unfurl operator learns which links you preview (over its own connection, like
opening the link would); the **message recipient still never contacts the URL**.

## Delivery in two increments

### Increment 1 — desktop UI patch (`patches/desktop/0033`)

Everything user-visible; works immediately on CORS-permissive sites; the unfurl
fallback path is wired but simply behaves as "fetch failed" until increment 2
lands. New files under `packages/frontend/src/components/composer/`:

- **`linkPreview/detectUrl.ts`** — extract the first previewable http(s) URL from
  the draft text; ignore `mailto:`/`openpgp4fpr:`/invite links; debounce.
- **`linkPreview/openGraph.ts`** — decode the fetched HTML (respect charset),
  parse `og:*` / `twitter:*` / `<title>` / `<link rel=icon>` via `DOMParser`;
  return a normalized `{ title, description, imageUrl, host, kind, imageDims }`.
- **`linkPreview/renderCard.ts`** — pure Canvas renderer: given the metadata and
  the decoded thumbnail bytes, draw compact or hero card (rounded corners, soft
  shadow, transparent margin, play glyph for video), then
  `canvas.toBlob('image/png')` with the **shrink-to-fit** loop (2× → 1.5× → 1× →
  shrink thumbnail until ≤ 0.6 MB). No React, unit-testable.
- **`linkPreview/generate.ts`** — orchestration: fetch via the bridge unfurl
  endpoint, then `renderCard`, stages the temp file, returns the path + chosen
  layout. Holds fetched metadata + thumbnail bytes in memory so expand/collapse
  re-renders without re-fetching.
- **`LinkPreviewGhost.tsx`** — the composer chip: states *idle ghost → loading
  (slim bar) → generated card (remove + expand/collapse)*. Rendered in the
  composer `upper-bar` alongside the existing quote/attachment previews.
- **`linkPreview/styles.module.scss`** — dashed ghost, chip layout, buttons.

Wiring in **`Composer.tsx`**: derive the current URL from `draftState.text` in
`onComposerMessageInputChange`; show the ghost when a URL exists and
`!draftState.file`; on accept call `generate.ts` then `addFileToDraft(...,
'Image')`; clear/replace on URL change, on manual attach, and in edit mode
(skip entirely). i18n strings + a settings toggle (default on) + a
`packages/web-app` changelog entry.

### Increment 2 — optional unfurl service (new package, no core/proxy change)

✅ Done.

- **`packages/ws-tcp-proxy/unfurl.mjs`** — a second single file in the bridge
  package, served by the bridge's HTTP server on the same port as the tunnel
  (plain GETs never touch the tunnel code):
  `GET /unfurl?url=…` fetches the page server-side and returns `{ url, title,
  description, isVideo, twitterCard, imageWidth, imageHeight, image (base64),
  imageMime }` as JSON with `Access-Control-Allow-Origin: *`. Hardening as
  specced: HTTP GET only; DNS resolved with the private/loopback/link-local/
  CGNAT guard *inside the socket's `lookup`* (literal-IP hosts checked
  separately — they bypass `lookup`); redirects (max 5) re-guarded per hop;
  1 MB page / 4 MB image caps; 15 s timeout; 30 req/min rate limit.
  **Enablement is tied to the allowlist**: on by default for an allow-all
  (local/personal) bridge — it already reaches anywhere, so a same-host
  preview fetcher is fine and needs no config; off by default once
  `CHATMAIL_ALLOWLIST` is set — a vetted hosted bridge shouldn't silently
  become an open web-preview fetcher, so there you opt in with `UNFURL=1`
  (`UNFURL=1`/`UNFURL=0` overrides either way). Self-check:
  `scripts/test-unfurl.mjs` (offline, in CI).
- **Frontend** (`patches/desktop/0034`) — `generate.ts`'s fallback derives the
  unfurl endpoint from the **already-configured bridge URL** (`?proxy=` /
  `slothfulchat.proxyUrl` / default, swapping `ws→http`, `wss→https`) — there
  is no separate config. A local bridge previews CORS-blocked links out of the
  box; a hosted bridge does so once its operator sets `UNFURL=1`; a bridge with
  the endpoint off just 404s and the ghost quietly disappears. The reply feeds
  straight into the card renderer (`chooseLayout` is shared; the HTML
  `DOMParser` path is skipped). One webapp tweak: `main.html`'s CSP
  `connect-src` adds `http://*:*/unfurl` and `https://*:*/unfurl` so the page
  can fetch the unfurl endpoint on the configured bridge — any host/port
  (matching the `ws:`/`wss:` the tunnel already allows for that same bridge),
  but pinned to the `/unfurl` path so the page can't fetch any other URL (a
  guardrail against accidentally reaching a CDN, and it rules out a lazy exfil
  bucket at another path). `:*` is a wildcard port, needed because the local
  bridge is on `:8641`. Note Chromium's Local Network Access blocks a
  `localhost` unfurl URL without a permission prompt — use a deployed https
  bridge, or the `--disable-features=LocalNetworkAccessChecks` flag in tests.
- Covered end-to-end in `scripts/test-link-preview-e2e.mjs`: a page served
  without CORS headers fails the direct tier and generates via the unfurl
  endpoint; the baked card is identical to the direct-path one.

## Card spec (summary)

- Surface `#f4f6f9`, title `#121821`, description `#525d68`, host accent
  `#0e7f5b`; hairline border `rgba(16,26,38,.14)`; shadow `rgba(8,14,22,.30)`,
  blur ~22, offset y ~8; corner radius ~14; transparent margin ~28 for the shadow.
- Rendered at 2× for crisp text; thumbnail downscaled to card size before
  compositing (the main size lever). Hero image height capped; hero gets a play
  triangle when the link is a video.
- Text: title ≤ 2 lines, description ≤ 1–2 lines, ellipsis-clamped; host row with
  a favicon square.

A standalone visual study of the card on light/dark/custom grounds with live
PNG/WebP/JPEG sizes lives outside the repo (design scratch), used to validate the
approach.

## Testing

- Unit: `openGraph.ts` parsing fixtures; `detectUrl.ts` edge cases;
  `renderCard.ts` stays under budget for a worst-case photographic hero.
- e2e — `scripts/test-link-preview-e2e.mjs` (offline, in CI): a local
  OpenGraph server on `*.localhost` exercises the real direct-fetch tier (no
  mock); ghost → Add → Image draft → send → baked card in the message list;
  layout toggle, remove, dismiss; the `/nocors-*` pages force the
  unfurl-service fallback; card screenshots on light/dark/rocket themes land
  in `.cache/link-preview-e2e/`.
- Unfurl service self-check — `scripts/test-unfurl.mjs` (offline, in CI):
  metadata + inline image, entity decoding, redirects, private-IP and
  literal-IP refusal, size cap, rate limit, GET-only.

## Privacy notes

- Preview generation is **explicit** (you tap Add) and **sender-only**; the
  recipient's client never fetches the URL.
- The direct path reveals the request to the site over the sender's own
  connection (as opening the link would). The optional unfurl-service fallback
  additionally reveals which links you preview to that service's operator — a
  fair trade, since you already trust your bridge, and it is a separate endpoint
  you choose to run/point at. The unfurl service is never the public bridge and
  is never an open proxy (GET-only, private-IP-blocked, size-capped,
  rate-limited).
- The baked card can embed whatever the site returns; the user sees the card
  before sending and can remove it.

## Out of scope (for now)

- Manual metadata editor (explicitly declined).
- WebP/AVIF output (compat caution).
- Animated/video-frame thumbnails (static frame only).
- Receiver-side re-rendering or per-theme variants (a single baked image by design).
