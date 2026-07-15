# Composer completion menu — working prototype

The scrollable, keyboard-navigable menu that pops up over the composer to offer
completions. First consumer: `:colon-emoji:`. Built as a reusable primitive so a
future `@mention` menu is just another provider.

Design doc: [`docs/emoji-completion-menu.md`](../../docs/emoji-completion-menu.md).

## Status

Real, runnable source — verified standalone (screenshot + test below). **Not yet
wired into the DeltaChat composer**: that step ports these files to `.tsx` and
lands as a patch to `vendor/deltachat-desktop`'s
`components/composer/Composer.tsx` + `ComposerMessageInput.tsx`, which needs the
full frontend build. Kept as `.js`/`.jsx` here so the check runs with plain
`node`, no build step.

## Files

| File | Role |
|---|---|
| `src/findActiveToken.js` | Pure token detector: scans left from the caret for the trigger, enforces the whitespace/start boundary (no firing in `http://`, `12:30`), returns the `:token` range or null. Carries the runnable check. |
| `src/emojiProvider.js` | `{trigger:':', minChars:2, query}` — reuses the already-bundled `@emoji-mart/data` via emoji-mart's `SearchIndex`. No new dependency. |
| `src/CompletionMenu.jsx` | Generic presentational list: highlights the active row, keeps it scrolled into view, reports click/hover. Emoji-agnostic. |
| `src/useCompletion.js` | Glue: token detection → provider query → keyboard nav (↑/↓ wrap, Enter select, Esc close) → insert the Unicode glyph, replacing the `:token`. |
| `src/demo.jsx`, `index.html` | Standalone harness that mounts the above on a real `<textarea>`. |

## Decisions baked in

Unicode-glyph insertion · float-above-composer · reusable primitive · `:`+2-chars
full match (shortcode+name+keywords) · Enter-only select · boundary guard ·
auto-replace of fully-typed `:shortcode:` left out of scope. (See the design doc.)

## Run the check

```sh
node src/findActiveToken.test.mjs        # the ponytail one-runnable check
```

## Run the harness (real render)

```sh
npm install react react-dom @emoji-mart/data emoji-mart esbuild
npx esbuild src/demo.jsx --bundle --format=esm --outfile=bundle.js --loader:.js=jsx --jsx=automatic
npx http-server . -p 8199   # or any static server; file:// is blocked by CORS
# open http://localhost:8199 — type ":sm", arrow-navigate, Enter to insert
```
