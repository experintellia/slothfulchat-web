# In-app translation editor + element inspector

A built-in dev/translator tool to edit the UI's translations live, review and
export the changes, and inspect any on-screen element to find which translation
key produced its text.

It ships in **every build — including released/production ones**. It costs
nothing until you open it (just a small bundle import), and it only ever touches
the strings *you* edit, stored locally in your own browser.

Design notes: [`design/translation-editor-design.md`](design/translation-editor-design.md).
Code: `packages/web-app/src/translation-editor.ts` (+ `.mjs` for the pure
helpers).

## How to open it

Two ways, both work in any build:

- **Keyboard:** `Ctrl+Shift+L` (Linux/Windows) or `Cmd+Shift+L` (macOS) — toggles
  the editor open/closed. This is the reliable way.
- **URL flag:** add `?txedit` to the app URL (e.g.
  `https://…/main.html?txedit`). Because browsers block popups that aren't
  opened from a user action, this opens the editor on your **first click**
  anywhere in the app, not instantly on load.

The editor opens in a **separate popup window** so the app's modal dialogs can
never cover it. If your browser blocks the popup, allow popups for the site (or
just use the keyboard shortcut, which counts as a user action).

Press `Esc` to close it (or to leave inspect mode first).

## What you can do

- **Edit the active language.** The panel lists your changes; type in a key's
  field to change its text. Switch languages with the dropdown to edit another —
  under a non-English language each field shows the English source for context.
- **Live refresh.** Every edit (and language switch) immediately re-renders the
  app in the current window, so you see the result without reloading.
- **Persistence.** Edits are saved per-language in `localStorage` and merged
  back on every reload, so they survive refreshes and language switches. They
  are local to your browser only — nothing is uploaded.
- **Revert.** Revert one key (`↺`) or all edits for the language.
- **Export.**
  - **Export XML** — a *partial* Android `strings.xml` containing only the keys
    you changed, ready for a merge-by-key upload to Weblate / Transifex.
  - **Export JSON** — the raw changeset (`{ key: { message } }`).

## Element inspector (🎯)

Click **🎯** in the panel, then hover any element in the app window: a tooltip
shows the translation key(s) that produced its text and the owning React
component. Click the element to jump the editor straight to that key. `Esc`
leaves inspect mode. The highlight and tooltip draw in the browser's top layer,
so they work over the app's modal dialogs too.

It resolves keys from a live registry of `tx()` calls (result text → key), so it
only matches text rendered through the translation system — core "stock strings"
and hard-coded text won't resolve.

## Limitations

- Edits are stored in your browser's `localStorage`; clearing site data removes
  them. Export before you clear.
- The inspector's component name relies on React fiber metadata, which is
  minified in production builds (the key still resolves; the `<Component>` label
  may be terse).
