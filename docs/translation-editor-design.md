# Translation Editing Sidebar — Design

A developer/translator overlay for editing UI translations live in the running
app, persisting changes locally, reviewing/exporting/reverting them, and
inspecting any on-screen element to find the translation key behind it.

Status: **design / not yet implemented.** This document is the plan agreed
before writing code.

---

## 1. Why this is tractable in this codebase

Every translated string in the app flows through a single point, so we can add
this feature by tapping ~3 central locations instead of touching components:

- `translate(locale, messages)` in
  `vendor/deltachat-desktop/packages/shared/localize.ts` builds one
  `getMessage(key, subs, opts)` closure.
- `packages/frontend/src/App.tsx` (`reloadLocaleData`) assigns that closure to
  **both** `window.static_translate` (the global path, used in hundreds of
  call sites) **and** the `I18nContext` value's `tx` (the React-hook path via
  `useTranslationFunction()`). Both are the *same* function instance.
- `window.localeData = { locale, messages, dir }` holds the entire string table
  in memory as a plain object: `{ [key]: { message?, one?, other?, … } }`.
- **Crucially**, the browser edition loads strings from
  `getLocaleData()` in `packages/web-app/src/runtime.ts` — code *we* own — which
  is a plain `fetch('/locales/<locale>.json')`. There is no native backend to
  work around.

The three levers:

| Lever | Location | Owner |
|---|---|---|
| `window.localeData.messages` (the live table) | set in upstream `App.tsx` | read/write at runtime |
| `translate()` (key → string) | upstream `shared/localize.ts` | small patch (Phase 2 only) |
| `getLocaleData()` (source of strings) | `packages/web-app/src/runtime.ts` | **ours, no patch** |

### String storage format

Locales are authored upstream as Android string-resource XML
(`vendor/deltachat-desktop/_locales/*.xml`) and converted to JSON at build time
by `vendor/deltachat-desktop/bin/build-shared-convert-translations.mjs`. The
browser fetches the JSON. Weblate/Transifex consume the **XML**. Export
(Section 4) reverses the converter to regenerate XML.

Runtime table shape (after JSON conversion):

```jsonc
{
  "ok": { "message": "OK" },
  "n_messages": { "one": "%1$d message", "other": "%1$d messages" }
}
```

Substitutions use Android-style `%1$s` / `%1$d` (and bare `%s`), handled by
`translate()`.

---

## 2. Feature scope

### Phase 1 — Editor + persistence (no upstream patch)
- Sidebar overlay, toggled by a dev shortcut / query flag, outside the React
  tree (own root, so it can't be broken by app re-renders).
- Language switcher (source = `_locales/_languages.json`).
- Key list: search/filter, show source (en) value + current-locale value,
  missing/untranslated indicators.
- Inline editor per key (incl. plural forms), live preview in the running app.
- Persist edits to an **overlay** in IndexedDB, keyed by `locale → key`.
- Change list: every edit as a diff (original vs new), tagged
  `upstream` (translatable) or `fork-local` (rebrand/override — never exported
  to Weblate). Revert one / revert all.
- Export (Section 4).

### Phase 2 — Element inspector (one small upstream patch)
- "Inspect" mode: hover highlights elements; tooltip shows the translation
  key(s) that produced the text under the cursor.
- Click → open the sidebar scrolled to that key, ready to edit.
- "Jump to key" and reverse ("which elements currently use this key").

---

## 3. Live editing mechanism

On edit of `messages[key]`:

1. Write to the IndexedDB overlay (`{locale, key, value, tag, originalValue}`).
2. Apply in memory: `window.localeData.messages[key] = value`.
3. Rebuild the function: `window.static_translate = translate(locale, messages)`.
4. Force a refresh of the React path: bump an `I18nContext` re-render (a tiny
   `version` counter added to the context value, or re-provide `tx`). This is
   the one spot that benefits from a **minimal** upstream touch; alternatively
   we trigger the existing `reloadLocaleData` path so no patch is needed in
   Phase 1.

### Persistence overlay merge (the key Phase-1 change, in our code)

In `packages/web-app/src/runtime.ts` `getLocaleData()`, merge the overlay on top
of fetched strings so edits survive reload and language switches:

```js
const overlay = await loadOverlay(locale)          // IndexedDB, our module
return {
  locale,
  messages: { ...localeMessages, ...untranslated, ...overlay },
  dir,
}
```

`originalValue` is captured on first edit (pre-overlay fetched value) so the
change list can always show a true diff and revert precisely.

### Language switching

The sidebar drives switching itself (the browser edition's `runtime.setLocale`
is a stub). Two options: reuse the boot path by setting the stored desktop
`locale` and re-running `reloadLocaleData`; or, for edit-preview without
changing the whole app chrome, fetch the target locale into a side buffer and
edit against that. Phase 1 uses the former for simplicity.

---

## 4. Export

Primary unit: **partial Android XML** — only the edited `<string>` / `<plurals>`
for one locale. Rationale: both Weblate and Transifex merge uploads by key, so a
partial file updates exactly the edited strings and never reverts others.

- **Transifex**: matches entries by `name`; omitted keys untouched.
- **Weblate**: merges by key for all upload modes **except** "Replace existing
  translation file". The exporter's help text will say: use *Add as
  translation* / *Update existing strings*, never *Replace*, with a partial file.

Exports offered:
1. **Partial XML** per locale (default; regenerates `<string>`/`<plurals>` via
   the reverse of `build-shared-convert-translations.mjs`).
2. **JSON changeset** (only changed keys) — tiny, easy to eyeball/review/share.
3. **Full locale XML** — behind a flag, for the rare full-file case.

`fork-local`-tagged changes are excluded from XML export by default (they are
not upstream translations) and can be exported separately as an override bundle
to bake into the build.

Import (round-trip): a "load changeset JSON" action so edits can move between
machines/sessions before the container is reclaimed.

---

## 5. Element inspector (Phase 2)

**Why React DevTools can't give us the key:** the translation key is a
transient argument to `tx(key)` — turned into a string during render and
discarded. React keeps no reference to it (not in state/props/hooks), so hook
inspection can't surface it.

**What we borrow from DevTools:** React stores a pointer to its fiber on each
DOM node (`__reactFiber$…`). Reading it maps a hovered node → owning component,
props, and (build permitting) name — the DevTools inspector trick.

The inspector triangulates three cheap signals, all from the single chokepoint:

1. **tx call-registry** *(recommended default, safe)* — wrap the `translate()`
   output so each call records `result → {key, args}` in a `Map` plus a recent
   ring buffer. No DOM mutation, no visible change. Hover → read the text node's
   string → look up the key.
2. **Fiber-off-DOM** — the hovered node's component + props, to disambiguate
   when one string maps to multiple keys (e.g. `"OK"`).
3. **Text match** — pin down the exact text node under the cursor.

Coverage ~95% with zero side effects.

**Exact mode (opt-in toggle)** for the stubborn rest (identical text from
different keys, or text assembled from several `tx` calls): `translate()`
prepends the key encoded as **zero-width characters** (ZWSP=0 / ZWNJ=1) to its
return; invisible in the UI, decoded from `textContent` on hover. Cost: those
chars contaminate `.length`, `===`, copy-paste, input `maxlength`, and width
measurement — so it is **only ever active while the toggle is on during an
inspect session**, never the default.

Both modes need the same one-line-ish wrap of `translate()` → a single small
upstream patch (routine here — the project already carries 40+ desktop patches).

### Build caveats to verify when building Phase 2
- The app ships as a **production** esbuild bundle (`NODE_ENV=production`), so
  React `_debugSource` (file:line) is stripped — no source-line jump.
- Component *names* survive only if the frontend bundle is built with
  `--keep-names` (the target-browser runtime is; confirm the frontend bundle).
  Props and text are readable regardless.
- `__reactFiber$` is an undocumented internal; stable in practice (React 19.2)
  and what DevTools itself relies on. Acceptable for a dev-only tool; isolate
  the access behind one helper so a React bump has a single failure point.

---

## 6. Module layout

Self-contained, mostly in the web-app layer:

```
packages/web-app/src/
  translation-editor/
    overlay-store.ts     # IndexedDB: load/save/list/revert, diff vs original
    messages-live.ts     # apply edits to window.localeData + refresh
    export-xml.ts        # reverse of the XML<->JSON converter (partial + full)
    export-json.ts       # changeset + import
    sidebar.ts(x)        # the UI (own root outside the app tree)
    inspector.ts         # Phase 2: registry + fiber walk + zero-width mode
    index.ts             # dev-toggle wiring (shortcut / query flag)
```

- `getLocaleData()` in `runtime.ts` gains the overlay merge (Section 3).
- Phase 2 adds **one** upstream patch under `patches/desktop/` wrapping
  `translate()` for the call-registry + optional zero-width markers.

Gating: the whole feature is behind a dev flag (e.g. `?translate-editor=1` or a
keyboard shortcut) so it never loads for normal users and adds no cost to the
default bundle.

---

## 7. Effort estimate

| Phase | Scope | Rough effort |
|---|---|---|
| 1 | Sidebar, live edit, IndexedDB overlay, change list, revert, partial-XML + JSON export/import | ~1 day |
| 2 | Inspector: registry + fiber triangulation, jump-to-key, zero-width exact mode, 1 upstream patch | ~1–2 days |

Phase 1 touches **no upstream/patched code** and is the highest-value chunk.

---

## 8. Open questions / decisions

- [x] Export format → **partial Android XML** primary, JSON changeset for
      review, full XML behind a flag.
- [ ] Inspector default → registry+fiber (recommended) vs. also ship zero-width
      exact mode in the first cut.
- [ ] Dev-flag mechanism → query param, keyboard shortcut, or reuse the
      existing "experimental features" gate (cf. desktop patch 0040).
- [ ] Should `fork-local` overrides get a build step that bakes them into the
      shipped locales, or stay runtime-only?
- [ ] Where the sidebar mounts on mobile viewports (full-screen sheet vs. side
      panel), given the app already full-screens big dialogs on mobile.
