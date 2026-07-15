# Composer completion menu — `:emoji:` (first consumer), mentions later

A scrollable, keyboard-navigable selection menu that pops up over the composer
and offers completions for what you're typing. First use: `:colon-emoji:`
completion. Built as a **reusable primitive** so a future `@mention` menu is just
another provider.

## Decisions (locked)

| Decision | Choice |
|---|---|
| Inserted value | **Unicode emoji glyph** (`😄`), not `:shortcode:` text — DeltaChat sends plain text and other clients don't decode shortcodes. |
| Positioning | **Float above the composer**, left-aligned (Slack/Discord style). No per-caret pixel math. |
| Generality | **Reusable completion primitive now** (trigger char + async item provider + renderer + keyboard/scroll behavior); emoji is the first consumer. |
| Trigger + matching | Menu appears after `:` **+ ≥2 chars**; match shortcode **+ name + keywords**, exact/prefix ranked first. |
| Selection key | **Enter only** selects (swallowed while open, so Enter does not send). Arrows navigate (swallowed, so ArrowUp does not edit-last). Escape closes the menu only. |
| Trigger guard | Only trigger when `:` is at input start or **preceded by whitespace** — no firing inside `http://` or `12:30`. |
| Auto-replace full `:shortcode:` | **Out of scope** for now (interactive menu only). |

## Data source — reuse, no new dependency

The desktop frontend already depends on **`@emoji-mart/data` v1.2.1** and ships the
`EmojiMart` emoji font. That dataset is keyed by shortcode; each entry has a
`name`, a `keywords[]` array, and the native Unicode emoji (`skins[].native`).

- Query via emoji-mart's `SearchIndex.search(query)` (init the index once from
  `@emoji-mart/data`), or a small hand-rolled filter over the same data if we want
  full control of ranking. Prefer `SearchIndex` first; fall back to a custom filter
  only if ranking/perf needs it.
- No new dependency, no new dataset shipped.

## Where it lives

The composer is upstream `deltachat-desktop` code, so this lands as a **new patch to
`vendor/deltachat-desktop`** (`patches/desktop/NNNN-*.patch`), reused later for
mentions. Relevant upstream files:

- `packages/frontend/src/components/composer/Composer.tsx` — mounts overlays
  (emoji/sticker picker, app picker) with outside-click handling; existing keydown
  for Enter=send, ArrowUp-when-empty=edit-last, Escape=close pickers. Follow this
  overlay pattern for mounting/dismissal.
- `packages/frontend/src/components/composer/ComposerMessageInput.tsx` — the
  `<textarea>`. Class component; text is in `this.props.text` (updated via
  `this.props.onChange`), keydown handler `onKeyDown`, `this.textareaRef`, and
  imperative helpers `insertStringAtCursorPosition()`, `setCursorPosition`, `focus()`.

## Architecture — the reusable primitive

### `CompletionMenu` (presentational + keyboard/scroll)
A generic overlay component. Knows nothing about emoji.

```
type CompletionItem = {
  id: string
  label: string            // e.g. ":smile:"
  preview: ReactNode       // e.g. the 😄 glyph
}

type CompletionProvider = {
  trigger: string                        // ":" now, "@" later
  minChars: number                       // 2 for emoji
  // return null → no menu; [] → menu with "no matches"
  query(term: string): Promise<CompletionItem[]> | CompletionItem[]
  boundaryBefore?: boolean               // require start-or-whitespace before trigger
}
```

Responsibilities:
- Render a floating, **scrollable** list above the composer, capped height
  (~8 rows visible), each row = `preview` + `label`, highlight the active row.
- Keyboard: ArrowUp/ArrowDown move selection **with wrap-around** and keep the
  active row scrolled into view; Enter selects; Escape closes. Mouse hover
  highlights, click selects. (Touch: tap = select.)
- Emits `onSelect(item)` and `onDismiss()`.

### `useCompletion(textareaRef, text, providers)` (token detection glue)
A hook that, on text/selection change, finds the active token under the caret and
drives the menu:

1. On `onChange` and on caret moves (`onKeyUp`/`onSelect`/click), read
   `textareaRef.current.selectionStart` and `text`.
2. Scan left from the caret for a provider's `trigger` char, stopping at
   whitespace/newline. Enforce `boundaryBefore` (char before trigger is
   start-of-input or whitespace). Extract `term` = chars between trigger and caret.
3. If `term.length >= minChars` and no whitespace inside → call `provider.query(term)`,
   open the menu with results, and remember the token range `[start, end]`.
   Otherwise close the menu.
4. Debounce the query (~50–80ms) so fast typing doesn't thrash.

### Insertion
On select, replace the token range `[triggerIndex, caret]` (the `:query`) with the
chosen value:

```
const before = text.slice(0, triggerIndex)
const after  = text.slice(caret)
const next   = before + emoji + after      // no trailing colon; caret after emoji
props.onChange(next)
// then setCursorPosition(before.length + emoji.length) and refocus
```

(Compute the replacement directly rather than using `insertStringAtCursorPosition`,
because we must first remove the `:query` fragment. Reuse `setCursorPosition`/`focus`.)

### Emoji provider (first consumer)
```
emojiProvider: CompletionProvider = {
  trigger: ':',
  minChars: 2,
  boundaryBefore: true,
  query: term => SearchIndex.search(term).map(e => ({
    id: e.id, label: `:${e.id}:`, preview: <span>{e.skins[0].native}</span>
  })).slice(0, MAX_RESULTS),
}
```

## Keydown interception (the tricky part)

`ComposerMessageInput.onKeyDown` must consult "is the menu open?" **before** its
existing Enter=send / ArrowUp=edit-last logic:

- Menu open + `ArrowUp`/`ArrowDown` → move selection, `preventDefault()` + stop, do
  **not** run edit-last / caret move.
- Menu open + `Enter` → select highlighted item, `preventDefault()` + stop, do
  **not** send.
- Menu open + `Escape` → close menu, `preventDefault()` + stop (don't bubble to the
  composer's own Escape-closes-pickers / cancel-edit).
- Menu closed → all keys behave exactly as today.

Cleanest wiring: the completion state lives in/around `ComposerMessageInput` (it owns
the textarea + keydown), and the early-return checks sit at the very top of
`onKeyDown`.

## Dismissal rules

Close the menu when: Escape; a match is selected; the token is broken (space,
newline, or the trigger char is deleted); caret moves out of the token; the textarea
blurs (outside-click, reuse the existing overlay outside-click helper); or the
provider returns `null`.

## Rendering / styling

- Positioned `absolute` above the `.composer` container, left-aligned to the
  textarea, `z-index` above the message list, below modals. Reuse the picker
  overlay's stacking context.
- Max height with `overflow-y: auto`; each row shows the native glyph (rendered with
  the bundled `EmojiMart` font already loaded) + the `:shortcode:` label; active row
  highlighted. `MAX_RESULTS` ~ 30 fetched, list scrolls.
- Theming: use existing composer/menu CSS variables so it matches light/dark themes.

## Edge cases

- `:` with <2 chars → no menu (avoids lone-colon noise).
- No matches → show a compact "no emoji found" row (or just close — pick one; default:
  show the empty state so the user knows the menu tried).
- Multi-byte / skin-tone emoji: insert `skins[0].native`; caret length uses the
  string length of the glyph (may be a surrogate pair).
- IME composition: don't run token detection while `isComposing` / during
  `compositionstart`…`compositionend`.
- Mobile soft keyboards: arrow keys may not fire; tap-to-select is the primary path
  there. Keyboard nav is best-effort on touch.

## Scope boundaries

**In:** interactive `:emoji:` completion menu; reusable `CompletionMenu` +
`CompletionProvider` primitive; keyboard + mouse + touch selection.

**Out (now):** `@mention` provider (the primitive is built to accept it later);
auto-replacing a fully-typed `:shortcode:` on space/send; caret-anchored positioning;
frequently-used / recent-emoji ranking.

## Verification

- Manual: type `:sm` in the composer → menu floats above, arrow-navigate, Enter
  inserts `😄`, message sends the Unicode glyph; confirm a real Delta Chat client
  receives the emoji. Confirm `http://x` and `12:30` do **not** open the menu.
- Automated: a Playwright test in the web-app e2e style — focus composer, type a
  trigger, assert the menu appears, ArrowDown + Enter, assert the textarea contains
  the expected emoji and the `:query` is gone; assert no menu for `http://` / `12:30`.

## Milestones

1. **Primitive** — `CompletionMenu` (render + keyboard/scroll/wrap, no data) +
   `useCompletion` token detection over the textarea. Storybook/manual harness.
2. **Emoji provider** — wire `@emoji-mart/data` `SearchIndex`, insertion, keydown
   interception in `ComposerMessageInput`, dismissal rules.
3. **Polish + tests** — styling/theming, edge cases (IME, guard, multibyte),
   Playwright test.
4. **Package as patch** — regenerate `patches/desktop/NNNN-*.patch` via
   `scripts/update-patches.sh`.
