# Composer completion menu (`:emoji:`, mentions later)

Status: **implemented** as `patches/desktop/0049` · Branch:
`claude/emoji-completion-menu-ix4kdq`

## What & why

Typing a colon shortcode plus at least two characters (e.g. `:sm`) opens a
scrollable, keyboard-navigable menu above the composer. Arrow keys move the
selection, Enter picks it, Escape dismisses. Picking an entry replaces the
`:token` with the **Unicode emoji glyph** — DeltaChat sends plain text and other
clients don't decode `:shortcode:` syntax, so inserting the real glyph is what
every client renders.

It's built as a generic completion primitive (a trigger char + a provider) so
the planned `@mention` menu is just another provider on the same machinery, not
a second implementation.

## Decisions (locked)

| Decision | Choice | Why |
|---|---|---|
| Inserted value | Unicode glyph (`😄`) | Interoperable; DeltaChat sends plain text. |
| Positioning | Float above the composer, left-aligned | No per-caret pixel math; reuses the picker-overlay idea. |
| Generality | Reusable `CompletionProvider` primitive | Mentions reuse it with one new provider. |
| Trigger + matching | `:` + ≥2 chars; shortcode + name + keywords, prefix-ranked | Avoids lone-colon noise; keyword hits (`:happy` → 😄). |
| Selection key | Enter only (Tab left alone) | Matches the composer's existing Enter semantics. |
| Trigger guard | Require start-of-input or whitespace before `:` | No firing inside `http://` or `12:30`. |
| Auto-replace fully-typed `:shortcode:` | Out of scope | Interactive menu only; can add later. |

## Architecture (what shipped)

All under `packages/frontend/src/components/composer/` in `desktop/0049`:

- `completion/types.ts` — the contract: `CompletionProvider` (`trigger`,
  `minChars`, `query(term)`), `CompletionItem` (`id`/`label`/`value`/`preview`),
  `ActiveToken`.
- `completion/findActiveToken.ts` — pure caret token detector. Scans left from
  the caret for the trigger, stops at whitespace, enforces the boundary guard.
  Framework-free so it carries the unit check.
- `completion/emojiProvider.ts` — reuses the already-bundled `@emoji-mart/data`
  (no new dependency). Flattens the dataset once, ranks exact id → id-prefix →
  keyword → name → substring, returns the top 30 with the native glyph.
- `completion/CompletionMenu.tsx` — generic presentational list: active-row
  highlight, scroll-into-view, click/hover. Emoji-agnostic.
- `ComposerMessageInput.tsx` — owns the textarea, so it holds the completion
  state and glue: detects the token on change/caret-move, drives the keyboard,
  and inserts via the existing `setCursorPosition` caret-restore path. **While
  the menu is open it consumes Arrow/Enter/Escape**, so the composer's
  `Enter`=send and `ArrowUp`=edit-last never fire. An Escape-dismissed token
  stays closed until its term changes.
- `scss/composer/_completion-menu.scss` (+ `manifest.scss`) — the menu is
  `position: absolute` above `.lower-bar`, which is now `position: relative`.
  The emoji/app pickers are siblings of `.lower-bar`, so they're unaffected.

Providers are tried in order from one array in `ComposerMessageInput`
(`completionProviders = [emojiProvider]`); adding `@mention` means adding a
provider there.

## Edge cases handled

- `:` with <2 chars, or a whitespace/newline inside the term → no menu.
- An already-closed `:shortcode:` (caret after the second colon) → no menu.
- A pure caret move within the same term keeps the highlight; changing the term
  resets it to the top.
- Insertion accounts for multi-code-unit glyphs via the inserted string length.

## Known ceiling (marked `ponytail:` in code)

- The menu is absolutely positioned, so an ancestor with `overflow: hidden`
  could clip a tall list. Fine for today's composer column. Upgrade path: portal
  to `<body>` + fixed at the textarea's `getBoundingClientRect`.
- `emojiProvider.query` linearly scans ~1900 rows per keystroke (trivial at this
  size). Upgrade path: prefix trie or a debounce if the list grows.

## Testing

- `packages/frontend/src/tests/completion.test.ts` (mocha/chai, the frontend's
  runner): the token detector (boundary guard, min-chars, closed-shortcode,
  whitespace) and the provider (prefix ranking, keyword match, glyph insertion).
  Run with `pnpm --filter frontend test`.
- Manual: type `:sm`, arrow-navigate, Enter → the message contains `😄`; confirm
  a real Delta Chat client receives the emoji; confirm `http://` and `12:30`
  don't open the menu.

## Out of scope / next

- `@mention` provider — the reason this is a generic primitive. Adds a provider
  that queries chat members; the menu, detection and keyboard are reused as-is.
  `query` is synchronous today (in-memory emoji scan); if member lookup is
  async, widen it back to `Promise` and add a staleness guard then, not now.
- Auto-replacing a fully-typed `:shortcode:` on space/send.
- Caret-anchored positioning; frequently-used / recent-emoji ranking.
