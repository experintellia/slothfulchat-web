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

Press **`Ctrl+Shift+L`** (Linux/Windows) or **`Cmd+Shift+L`** (macOS) — this
toggles the editor open/closed, in any build.

The editor opens in a **separate popup window** so the app's modal dialogs can
never cover it. If your browser blocks the popup, allow popups for the site and
press the shortcut again.

Press `Esc` to close it (or to leave inspect mode / close the language menu
first).

## What you can do

- **Edit the active language.** The panel lists your changes; type in a key's
  field to change its text. Under a non-English language each field shows the
  English source for context.
- **Editing.** Each value is an auto-growing textarea (so multi-line strings
  edit in full and grammar add-ons like LanguageTool attach to it). **Enter
  saves**; **Shift+Enter** inserts a newline.
- **Switch languages** with the **language chooser** (top-right). Each language
  shows its **completion** (% of English keys translated, experimental strings
  excluded), its **text direction** (`ltr`/`rtl`), and a badge with how many
  keys you've edited in it. The list also includes languages **too incomplete to
  be offered in the app** (tagged `hidden`). Editing or creating a language
  renders it **live** in the app — for keys you haven't translated yet it shows
  the English source, so even a brand-new language previews immediately.
- **Create a language on the fly** from the chooser's bottom row: type a code
  (e.g. `pt-BR`), pick its direction with the **LTR/RTL** toggle, and press
  **Add**. You can then translate and export it like any other. Created
  languages are **persisted** (like your edits) and listed at the **end** of the
  chooser, in creation order.
- **Filter** the list with the toggles under the search box —
  **untranslated** (no translation in this language yet), **experimental**, and
  **stockstrings** (strings that come from the core library). Combine with the
  search box to narrow further.
- **Per-key badges** tell you where a key stands for the current language:
  - **`untranslated`** — no translation yet in this language; the editor shows
    the English source, which is what the app currently renders.
  - **`experimental`** — an English-only app string (from
    `_untranslated_en.json`) that isn't part of the translatable catalogue. It
    renders in English in every language and is **excluded from the normal
    export** (see below).
- **Live refresh.** Every edit (and language switch) immediately re-renders the
  app in the current window, so you see the result without reloading.
- **Persistence.** Edits are saved per-language in `localStorage` and merged
  back on every reload, so they survive refreshes and language switches. They
  are local to your browser only — nothing is uploaded.
- **Revert.** Revert one key (`↺`) or all edits for the language.
- **Export** (buttons are disabled when there's nothing to export):
  - **Export XML** — a *partial* Android `strings.xml` of the translatable keys
    you changed, ready for a merge-by-key upload to Weblate / Transifex.
    Experimental keys are left out.
  - **Export JSON** — the same translatable changeset as raw JSON.
  - **Export experimental** — only the experimental keys you changed, as JSON.
    These don't belong in the translation catalogue, so they get their own file.

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
