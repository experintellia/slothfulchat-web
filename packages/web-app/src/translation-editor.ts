/**
 * In-app translation editor + element inspector —
 * docs/design/translation-editor-design.md, Phases 1 and 2.
 *
 * Phase 1 (editor): edits the *currently active* locale's UI strings live,
 * persists edits to a per-locale localStorage overlay, and lets you review /
 * export / revert them. Strings come from our own runtime.getLocaleData()
 * (which merges the overlay via applyTxOverlay); a live refresh reuses the
 * app's own language-reload path (runtime.onChooseLanguage) — so this needs no
 * upstream patch and touches no component.
 *
 * Phase 2 (inspector): "Inspect" mode highlights elements under the cursor and
 * shows which translation key produced the text, then jumps the editor to it.
 * It resolves the key from a live registry of tx calls (result text -> keys),
 * built by intercepting assignment to window.static_translate with a property
 * setter — both the global tx and the React-context tx read that global, so one
 * setter instruments every call site with no upstream patch. The React fiber on
 * the hovered node (the DevTools trick) names the owning component to
 * disambiguate identical text.
 *
 * ponytail: edits the active locale only (switch language in the panel to edit
 * another); a commit (blur / Enter) re-runs onChooseLanguage, which re-fetches
 * the locale JSON (cached) and re-renders the whole app. Ceilings: a re-fetch +
 * full re-render per commit (upgrade path: bump I18nContext directly, needs a
 * tiny upstream hook); the inspector only resolves strings rendered through tx
 * (core stock strings and hardcoded text won't match); the design's zero-width
 * exact mode is intentionally not built (YAGNI — the registry + fiber cover the
 * common cases without contaminating the DOM). Opened with Ctrl/Cmd+Shift+L in
 * any build (dev or release); it's inert until opened, so normal users only pay
 * the small bundle import. The panel lives in a separate popup window so the
 * app's modal (top-layer) dialogs never cover it; the inspector's
 * highlight/tooltip stay in the app window.
 */
import { matchKeys, mergeOverlay, toAndroidXml } from './translation-editor.mjs'

type Entry = Record<string, string>
type Overlay = Record<string, Record<string, Entry>>

const OVERLAY_KEY = 'slothfulchat.txOverlay'
const BASE = new URL('.', location.href).pathname

// ---- persistence overlay -------------------------------------------------

function loadOverlay(): Overlay {
  try {
    return JSON.parse(localStorage.getItem(OVERLAY_KEY) || '{}')
  } catch {
    return {}
  }
}

function saveOverlay(overlay: Overlay): void {
  localStorage.setItem(OVERLAY_KEY, JSON.stringify(overlay))
}

/**
 * Merge persisted edits for `locale` onto freshly-fetched messages. Called by
 * runtime.getLocaleData() so edits survive reloads and language switches.
 */
export function applyTxOverlay(
  locale: string,
  messages: Record<string, Entry>
): Record<string, Entry> {
  return mergeOverlay(loadOverlay()[locale], messages)
}

function overlayFor(locale: string): Record<string, Entry> {
  return loadOverlay()[locale] || {}
}

/** Persist an edit; drops the override if it now equals the pristine original. */
function editValue(
  locale: string,
  key: string,
  field: string,
  value: string,
  pristine: Entry
): void {
  const overlay = loadOverlay()
  const forLocale = overlay[locale] || (overlay[locale] = {})
  const entry: Entry = { ...(forLocale[key] || pristine), [field]: value }
  if (JSON.stringify(entry) === JSON.stringify(pristine)) delete forLocale[key]
  else forLocale[key] = entry
  if (!Object.keys(forLocale).length) delete overlay[locale]
  saveOverlay(overlay)
}

function revert(locale: string, key: string): void {
  const overlay = loadOverlay()
  if (overlay[locale]) {
    delete overlay[locale][key]
    if (!Object.keys(overlay[locale]).length) delete overlay[locale]
    saveOverlay(overlay)
  }
}

function revertAll(locale: string): void {
  const overlay = loadOverlay()
  delete overlay[locale]
  saveOverlay(overlay)
}

// ---- live refresh + data loading ----------------------------------------

/** Re-run the app's own language reload so edits render immediately. Uses the
 *  runtime captured at init: the frontend deletes window.r after importing it,
 *  so reading it here would find nothing and the refresh would silently no-op. */
async function refreshApp(locale: string): Promise<void> {
  const runtime = appRuntime || (window as any).r
  if (runtime?.onChooseLanguage) await runtime.onChooseLanguage(locale)
}

async function fetchJson(path: string): Promise<Record<string, Entry>> {
  const res = await fetch(BASE + path)
  if (!res.ok) throw new Error(`fetch ${path}: ${res.status}`)
  return res.json()
}

/** A locale's OWN translation catalogue (en.json for en, <locale>.json else) —
 *  the translatable strings that go to Weblate/Transifex. Does NOT include the
 *  experimental (_untranslated_en) strings; those are loaded separately. */
async function loadCatalogue(locale: string): Promise<Record<string, Entry>> {
  return fetchJson(locale === 'en' ? 'locales/en.json' : `locales/${locale}.json`)
}

async function loadLanguages(): Promise<Array<{ code: string; name: string }>> {
  const raw = (await fetchJson('locales/_languages.json')) as unknown as Record<
    string,
    string | { name: string }
  >
  return Object.entries(raw).map(([code, v]) => ({
    code,
    name: typeof v === 'string' ? v : v.name,
  }))
}

function download(filename: string, text: string, type: string): void {
  const url = URL.createObjectURL(new Blob([text], { type }))
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

// ---- tiny DOM helper (el() in runtime.ts isn't exported) ------------------

type H = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props?: Record<string, any>,
  ...children: (Node | string)[]
) => HTMLElementTagNameMap[K]

/** An h() bound to a specific document. The panel is built in the popup
 *  window's document; the inspector overlay stays in the app document. */
function makeH(doc: Document): H {
  const h: H = (tag, props = {}, ...children) => {
    const node = doc.createElement(tag)
    for (const [k, v] of Object.entries(props)) {
      if (k === 'style') Object.assign(node.style, v)
      else if (k.startsWith('on') && typeof v === 'function')
        (node as any)[k.toLowerCase()] = v
      else if (k in node) (node as any)[k] = v
      else node.setAttribute(k, String(v))
    }
    for (const c of children) node.append(c)
    return node
  }
  return h
}

// Rebound to the popup document in open(); the inspector always uses hApp.
let h: H = makeH(document)
const hApp: H = makeH(document)

// ---- panel ----------------------------------------------------------------

let panel: HTMLElement | null = null
let win: Window | null = null
// The app runtime, captured at init before the frontend deletes window.r.
let appRuntime: any = null
let currentLocale = 'en'
let sourceEn: Record<string, Entry> = {} // en.json catalogue (English)
let localeOwn: Record<string, Entry> = {} // current locale's own catalogue
let experimental: Record<string, Entry> = {} // _untranslated_en.json (English-only)
let experimentalKeys = new Set<string>()
// 'shown'  — in the app's _languages.json
// 'hidden' — has a locale file but is too incomplete to be offered in the app
// 'new'    — created here on the fly; no locale file yet
type Lang = { code: string; name: string; status: 'shown' | 'hidden' | 'new' }
let languages: Lang[] = []
let catalogue: Record<string, number> = {} // per-locale key counts (build manifest)
let stockKeys = new Set<string>() // core stock-string keys (build manifest)
let filters = { untranslated: false, experimental: false, stock: false }
let search = ''
let listEl: HTMLElement | null = null
let countEl: HTMLElement | null = null
let searchInputEl: HTMLInputElement | null = null
let inspectBtn: HTMLButtonElement | null = null
let xmlBtn: HTMLButtonElement | null = null
let jsonBtn: HTMLButtonElement | null = null
let expBtn: HTMLButtonElement | null = null
let revertBtn: HTMLButtonElement | null = null
let langBtn: HTMLButtonElement | null = null
let langMenu: HTMLElement | null = null

const muted = { color: '#9aa', fontSize: '11px' }

// ---- key classification (experimental / English fallback) -----------------

/** The base (un-overlaid) value shown/edited for a key: the locale's own
 *  translation if any, else the experimental string, else the English source. */
function pristineFor(key: string): Entry {
  return localeOwn[key] || experimental[key] || sourceEn[key] || { message: '' }
}

/** How a key relates to the current locale, for its badge and export bucket.
 *  'experimental' — English-only app string, excluded from the normal export.
 *  'en'           — no translation for this locale yet; shows the English text. */
function classify(key: string): 'experimental' | 'en' | null {
  if (experimentalKeys.has(key)) return 'experimental'
  if (currentLocale !== 'en' && !(key in localeOwn)) return 'en'
  return null
}

/** Every editable key: the English catalogue plus the experimental strings. */
function allKeys(): string[] {
  return [...new Set([...Object.keys(sourceEn), ...experimentalKeys])]
}

// ---- inspector (Phase 2) --------------------------------------------------

/**
 * Intercept assignment to window.static_translate so every tx call records its
 * (result -> key) mapping. Both the global tx and the React-context tx read
 * this global, so one setter instruments all call sites. Installed at startup,
 * before the app first assigns static_translate. Returns the live registry.
 */
function installRegistry(): Map<string, Set<string>> {
  const w = window as any
  if (w.__txRegistry) return w.__txRegistry
  const registry: Map<string, Set<string>> = new Map()
  w.__txRegistry = registry
  const wrap = (fn: any) => {
    if (!fn || fn.__txWrapped) return fn
    const wrapped = (key: string, subs?: unknown, opts?: unknown) => {
      const result = fn(key, subs, opts)
      if (typeof result === 'string' && result) {
        let set = registry.get(result)
        if (!set) registry.set(result, (set = new Set()))
        set.add(key)
      }
      return result
    }
    wrapped.__txWrapped = true
    return wrapped
  }
  let current = wrap(w.static_translate)
  Object.defineProperty(window, 'static_translate', {
    configurable: true,
    get: () => current,
    set: (fn: any) => {
      current = wrap(fn)
    },
  })
  return registry
}

/** Strings an element might have rendered from tx: its text and label-ish attrs. */
function candidateStrings(el: Element): string[] {
  const out: string[] = []
  const own = Array.from(el.childNodes)
    .filter(n => n.nodeType === Node.TEXT_NODE)
    .map(n => n.textContent || '')
    .join('')
    .trim()
  if (own) out.push(own)
  const full = (el.textContent || '').trim()
  if (full && full !== own) out.push(full)
  for (const attr of ['title', 'aria-label', 'placeholder', 'alt']) {
    const v = el.getAttribute(attr)
    if (v && v.trim()) out.push(v.trim())
  }
  const value = (el as HTMLInputElement).value
  if (typeof value === 'string' && value.trim()) out.push(value.trim())
  return out
}

/** Nearest named React component owning `el`, via the fiber React stashes on the
 *  DOM node (the DevTools trick). Best-effort: minified in production builds. */
function fiberComponentName(el: Element): string {
  const key = Object.keys(el).find(k => k.startsWith('__reactFiber$'))
  let fiber: any = key ? (el as any)[key] : null
  while (fiber) {
    const type = fiber.type
    if (typeof type === 'function') return type.displayName || type.name || ''
    fiber = fiber.return
  }
  return ''
}

let inspecting = false
let hlBox: HTMLElement | null = null
let tip: HTMLElement | null = null

function inThePanel(node: EventTarget | null): boolean {
  return !!panel && node instanceof Node && panel.contains(node)
}

/** Show/hide an overlay node, keeping it in the top layer above app dialogs.
 *  Re-promoting on show puts it above any dialog opened since inspect started;
 *  `display` is the fallback for browsers without the Popover API. */
function raise(el: HTMLElement | null, on: boolean): void {
  if (!el) return
  el.style.display = on ? 'block' : 'none'
  try {
    if (on) {
      if ((el as any).matches?.(':popover-open')) (el as any).hidePopover()
      ;(el as any).showPopover?.()
    } else if ((el as any).matches?.(':popover-open')) {
      ;(el as any).hidePopover()
    }
  } catch {
    /* no Popover API or over-constrained state — display fallback covers it */
  }
}

function onInspectMove(e: MouseEvent): void {
  const target = e.target as Element | null
  if (!target || !hlBox || !tip || inThePanel(target)) {
    raise(hlBox, false)
    raise(tip, false)
    return
  }
  const rect = target.getBoundingClientRect()
  Object.assign(hlBox.style, {
    left: `${rect.left}px`,
    top: `${rect.top}px`,
    width: `${rect.width}px`,
    height: `${rect.height}px`,
  })
  raise(hlBox, true)
  const matches = matchKeys((window as any).__txRegistry || new Map(), candidateStrings(target))
  const comp = fiberComponentName(target)
  tip.replaceChildren()
  if (matches.length) {
    for (const m of matches.slice(0, 3))
      tip.append(hApp('div', { style: { color: '#ffd479' } }, m.keys.join(' / ')))
  } else {
    tip.append(hApp('div', { style: muted }, 'no tx key for this text'))
  }
  if (comp) tip.append(hApp('div', { style: muted }, `<${comp}>`))
  // Raise tip after hlBox so the tooltip sits above the highlight, then measure.
  raise(tip, true)
  tip.style.left = `${Math.min(e.clientX + 14, innerWidth - 340)}px`
  // Flip above the cursor near the bottom edge so the tooltip stays on screen.
  const below = e.clientY + 16
  tip.style.top = `${
    below + tip.offsetHeight > innerHeight - 4
      ? Math.max(4, e.clientY - tip.offsetHeight - 12)
      : below
  }px`
}

function onInspectClick(e: MouseEvent): void {
  if (inThePanel(e.target)) return // let panel buttons (incl. the toggle) work
  e.preventDefault()
  e.stopPropagation()
  const matches = matchKeys(
    (window as any).__txRegistry || new Map(),
    candidateStrings(e.target as Element)
  )
  const key = matches[0]?.keys[0]
  stopInspect()
  if (key) openToKey(key)
}

function startInspect(): void {
  if (inspecting) return
  inspecting = true
  // popover:'manual' promotes these into the top layer, so they draw ABOVE the
  // app's showModal() dialogs (which a plain high z-index can't). inset/margin
  // reset undoes the UA popover centering; we position via left/top ourselves.
  hlBox = hApp('div', {
    popover: 'manual',
    'data-txedit': 'highlight',
    style: {
      display: 'none',
      position: 'fixed',
      inset: 'auto',
      margin: '0',
      pointerEvents: 'none',
      zIndex: '2147483001',
      border: '2px solid #ffd479',
      background: 'rgba(255,212,121,0.15)',
      borderRadius: '2px',
    },
  })
  tip = hApp('div', {
    popover: 'manual',
    style: {
      display: 'none',
      position: 'fixed',
      inset: 'auto',
      margin: '0',
      pointerEvents: 'none',
      zIndex: '2147483002',
      maxWidth: '320px',
      background: '#000',
      color: '#fff',
      font: '12px system-ui, sans-serif',
      padding: '4px 8px',
      borderRadius: '4px',
      boxShadow: '0 2px 8px rgba(0,0,0,0.5)',
    },
  })
  document.body.append(hlBox, tip)
  window.addEventListener('mousemove', onInspectMove, true)
  window.addEventListener('click', onInspectClick, true)
  document.body.style.cursor = 'crosshair'
  updateInspectBtn()
}

function stopInspect(): void {
  if (!inspecting) return
  inspecting = false
  hlBox?.remove()
  tip?.remove()
  hlBox = tip = null
  window.removeEventListener('mousemove', onInspectMove, true)
  window.removeEventListener('click', onInspectClick, true)
  document.body.style.cursor = ''
  updateInspectBtn()
}

function updateInspectBtn(): void {
  if (!inspectBtn) return
  inspectBtn.style.background = inspecting ? '#ffd479' : 'transparent'
  inspectBtn.style.color = inspecting ? '#111' : '#ccc'
  inspectBtn.setAttribute('aria-pressed', String(inspecting))
}

/** Open the panel (if needed) and filter it to a single key, ready to edit. */
function openToKey(key: string): void {
  const focus = () => {
    search = key
    if (searchInputEl) searchInputEl.value = key
    renderList()
    win?.focus()
    listEl?.querySelector('textarea')?.focus()
  }
  if (win && !win.closed) focus()
  else void open().then(focus)
}

/** Render the key rows: changed keys when the search box is empty (the change
 *  list), otherwise keys matching the query (capped — see ceiling below). */
function renderList(): void {
  updateFooter()
  updateLangButton() // keep the chooser's current-language count in sync
  if (!listEl || !countEl) return
  const overlay = overlayFor(currentLocale)
  const changedKeys = Object.keys(overlay)
  countEl.textContent = `${changedKeys.length} change${
    changedKeys.length === 1 ? '' : 's'
  }`

  const term = search.trim().toLowerCase()
  const matchesTerm = (k: string): boolean => {
    if (!term) return true
    if (k.toLowerCase().includes(term)) return true
    const cur = overlay[k] || pristineFor(k)
    return Object.values(cur).some(v => v.toLowerCase().includes(term))
  }
  let keys: string[]
  let capped = false
  if (!term && !anyFilter()) {
    keys = changedKeys.sort()
  } else {
    keys = allKeys()
      .sort()
      .filter(k => matchesTerm(k) && matchesFilter(k))
    // ponytail: cap the rendered rows — the catalogue is ~1000 keys and a
    // stray short query would render them all. Narrow the search to see more.
    if (keys.length > 200) {
      keys = keys.slice(0, 200)
      capped = true
    }
  }

  listEl.replaceChildren()
  if (!keys.length) {
    listEl.append(
      h(
        'div',
        { style: { ...muted, padding: '12px' } },
        term || anyFilter() ? 'No matching keys.' : 'No changes yet — search a key to edit.'
      )
    )
    return
  }
  for (const key of keys) listEl.append(row(key, overlay))
  // Size textareas once they're in the DOM (scrollHeight needs layout).
  listEl.querySelectorAll('textarea').forEach(autoGrow)
  if (capped)
    listEl.append(
      h(
        'div',
        { style: { ...muted, padding: '8px 12px' } },
        'Showing first 200 matches — narrow the search to see more.'
      )
    )
}

/** Fit a value textarea to its content (so multi-line strings show in full). */
function autoGrow(el: HTMLTextAreaElement): void {
  el.style.height = 'auto'
  el.style.height = `${el.scrollHeight}px`
}

function badge(kind: 'experimental' | 'en'): HTMLElement {
  const spec =
    kind === 'experimental'
      ? { bg: '#3a2a4a', fg: '#c9a6ff', label: 'experimental',
          title: 'Experimental string (English-only) — excluded from the normal language export; use "Export experimental"' }
      : { bg: '#243244', fg: '#8cf', label: 'untranslated',
          title: 'No translation for this language yet — showing the English source' }
  return h(
    'span',
    {
      title: spec.title,
      style: {
        background: spec.bg,
        color: spec.fg,
        borderRadius: '8px',
        padding: '0 6px',
        fontSize: '10px',
        lineHeight: '15px',
        whiteSpace: 'nowrap',
      },
    },
    spec.label
  )
}

function row(key: string, overlay: Record<string, Entry>): HTMLElement {
  const base: Entry = pristineFor(key)
  const current: Entry = overlay[key] || base
  const isPlural = typeof base.message !== 'string'
  const fields = isPlural ? Object.keys(base) : ['message']
  const changed = key in overlay
  const kind = classify(key)

  const header = h(
    'div',
    { style: { display: 'flex', alignItems: 'center', gap: '6px' } },
    h(
      'code',
      { style: { fontSize: '11px', color: changed ? '#ffd479' : '#8cf' } },
      key
    ),
    ...(kind ? [badge(kind)] : []),
    h('span', { style: { flex: '1' } }),
    changed
      ? h(
          'button',
          {
            title: 'Revert this key',
            'aria-label': `Revert ${key}`,
            style: btnStyle,
            onclick: async () => {
              revert(currentLocale, key)
              await refreshApp(currentLocale)
              renderList()
            },
          },
          '↺'
        )
      : ''
  )

  const inputs = fields.map(field => {
    const enSrc = experimental[key] || sourceEn[key] || {}
    const enRef = enSrc[field] ?? enSrc.message
    // A textarea (not <input>): multi-line strings (e.g. the donation text) stay
    // editable, and grammar add-ons like LanguageTool attach to textareas.
    const input = h('textarea', {
      value: current[field] ?? '',
      'aria-label': `${key}${isPlural ? ' ' + field : ''}`,
      rows: 1,
      style: {
        width: '100%',
        boxSizing: 'border-box',
        background: changed ? '#2a2a1a' : '#1c1c1c',
        color: '#eee',
        border: '1px solid #444',
        borderRadius: '3px',
        padding: '3px 5px',
        fontSize: '12px',
        fontFamily: 'inherit',
        lineHeight: '1.3',
        resize: 'vertical',
        overflow: 'hidden',
      },
      oninput: (e: Event) => autoGrow(e.target as HTMLTextAreaElement),
      onchange: async (e: Event) => {
        editValue(
          currentLocale,
          key,
          field,
          (e.target as HTMLTextAreaElement).value,
          base
        )
        await refreshApp(currentLocale)
        renderList()
      },
    })
    const wrap = h('div', { style: { marginTop: '2px' } })
    if (isPlural)
      wrap.append(h('span', { style: { ...muted, marginRight: '4px' } }, field))
    wrap.append(input)
    // Show the English source under a non-English locale for context, unless the
    // value already is that English string (experimental / untranslated keys).
    if (currentLocale !== 'en' && enRef && enRef !== (current[field] ?? ''))
      wrap.append(h('div', { style: muted }, enRef))
    return wrap
  })

  return h(
    'div',
    { style: { padding: '6px 12px', borderBottom: '1px solid #2a2a2a' } },
    header,
    ...inputs
  )
}

const btnStyle = {
  background: 'transparent',
  color: '#ccc',
  border: '1px solid #555',
  borderRadius: '3px',
  cursor: 'pointer',
  fontSize: '12px',
  padding: '1px 6px',
}

// ---- export buckets + footer enable/disable (d) ---------------------------

/** Number of edited keys stored for a locale (across normal + experimental). */
function changeCount(code: string): number {
  return Object.keys(loadOverlay()[code] || {}).length
}

/** Split the current locale's edits: experimental keys export separately from
 *  the normal (translatable) catalogue keys. */
function changeBuckets(): { normal: Record<string, Entry>; experimental: Record<string, Entry> } {
  const normal: Record<string, Entry> = {}
  const exp: Record<string, Entry> = {}
  for (const [k, v] of Object.entries(overlayFor(currentLocale)))
    (experimentalKeys.has(k) ? exp : normal)[k] = v
  return { normal, experimental: exp }
}

function setDisabled(btn: HTMLButtonElement | null, disabled: boolean): void {
  if (!btn) return
  btn.disabled = disabled
  btn.style.opacity = disabled ? '0.4' : '1'
  btn.style.cursor = disabled ? 'default' : 'pointer'
}

/** Enable each export/revert button only when it has something to act on. */
function updateFooter(): void {
  const { normal, experimental: exp } = changeBuckets()
  const nNormal = Object.keys(normal).length
  const nExp = Object.keys(exp).length
  setDisabled(xmlBtn, nNormal === 0)
  setDisabled(jsonBtn, nNormal === 0)
  setDisabled(expBtn, nExp === 0)
  setDisabled(revertBtn, nNormal + nExp === 0)
}

// ---- custom language chooser (e) ------------------------------------------

function countBadge(n: number): HTMLElement {
  return h(
    'span',
    {
      title: `${n} edited key${n === 1 ? '' : 's'}`,
      style: {
        background: '#3a3a2a',
        color: '#ffd479',
        borderRadius: '8px',
        padding: '0 6px',
        fontSize: '10px',
        lineHeight: '15px',
      },
    },
    String(n)
  )
}

const ellipsis = {
  flex: '1',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
}

function langLabel(code: string): string {
  return `${languages.find(l => l.code === code)?.name || code} (${code})`
}

/** Native language name for a bare code (for locales not in _languages.json). */
function displayName(code: string): string {
  try {
    return new Intl.DisplayNames(['en'], { type: 'language' }).of(code.replace('_', '-')) || code
  } catch {
    return code
  }
}

/** Percent of the English keys a locale translates (build manifest), ignoring
 *  experimental strings. null = unknown (e.g. a language created here, no file). */
function completion(code: string): number | null {
  const en = catalogue['en']
  const n = catalogue[code]
  if (!en || n == null) return null
  return Math.min(100, Math.round((n / en) * 100))
}

function tagPill(label: string, bg: string, fg: string, title: string): HTMLElement {
  return h(
    'span',
    {
      title,
      style: { background: bg, color: fg, borderRadius: '8px', padding: '0 6px', fontSize: '10px', lineHeight: '15px', whiteSpace: 'nowrap' },
    },
    label
  )
}

/** The "why isn't this in the app" tag for hidden / newly-created languages. */
function statusTag(status: Lang['status']): HTMLElement | null {
  if (status === 'hidden')
    return tagPill('hidden', '#4a2a2a', '#f0a0a0', 'Too incomplete to be offered in the app — you can still edit/export it here')
  if (status === 'new')
    return tagPill('new', '#2a3a2a', '#a0f0a0', 'Created here on the fly — no locale file yet')
  return null
}

/** Chooser entries: the app's shown languages, every locale with a file, and any
 *  locale you've edited or created here — deduped, named, sorted. */
function buildLanguages(shown: Array<{ code: string; name: string }>): Lang[] {
  const shownMap = new Map(shown.map(l => [l.code, l.name]))
  const codes = new Set<string>([
    ...shownMap.keys(),
    ...Object.keys(catalogue),
    ...Object.keys(loadOverlay()),
    currentLocale,
  ])
  return [...codes]
    .map(
      (code): Lang => ({
        code,
        name: shownMap.get(code) || displayName(code),
        status: shownMap.has(code) ? 'shown' : code in catalogue ? 'hidden' : 'new',
      })
    )
    .sort((a, b) => a.name.localeCompare(b.name))
}

function updateLangButton(): void {
  if (!langBtn) return
  langBtn.replaceChildren(h('span', { style: ellipsis }, langLabel(currentLocale)))
  const n = changeCount(currentLocale)
  if (n) langBtn.append(countBadge(n))
  langBtn.append(h('span', { style: { color: '#9aa' } }, '▾'))
}

function closeLangMenu(): void {
  if (langMenu) langMenu.style.display = 'none'
  langBtn?.setAttribute('aria-expanded', 'false')
}

function openLangMenu(): void {
  if (!langMenu) return
  // Rebuild rows each open so per-language counts/completion stay current.
  const rows = languages.map(l => {
    const n = changeCount(l.code)
    const pct = completion(l.code)
    const tag = statusTag(l.status)
    const selected = l.code === currentLocale
    return h(
      'button',
      {
        role: 'option',
        'aria-selected': String(selected),
        style: {
          display: 'flex', alignItems: 'center', gap: '6px', width: '100%',
          textAlign: 'left', background: selected ? '#2a2a1a' : 'transparent',
          color: '#eee', border: '0', borderBottom: '1px solid #222',
          padding: '5px 8px', fontSize: '12px', cursor: 'pointer',
        },
        onclick: () => void selectLocale(l.code),
      },
      h('span', { style: ellipsis }, `${l.name} (${l.code})`),
      ...(pct != null ? [h('span', { style: { ...muted, whiteSpace: 'nowrap' } }, `${pct}%`)] : []),
      ...(tag ? [tag] : []),
      ...(n ? [countBadge(n)] : [])
    )
  })
  const createRow = h(
    'button',
    {
      style: {
        width: '100%', textAlign: 'left', background: 'transparent', color: '#8cf',
        border: '0', padding: '6px 8px', fontSize: '12px', cursor: 'pointer',
      },
      onclick: createLanguage,
    },
    '+ New language…'
  )
  langMenu.replaceChildren(...rows, createRow)
  langMenu.style.display = 'block'
  langBtn?.setAttribute('aria-expanded', 'true')
}

async function selectLocale(code: string): Promise<void> {
  closeLangMenu()
  if (code === currentLocale) return
  currentLocale = code
  await refreshApp(code)
  try {
    localeOwn = code === 'en' ? sourceEn : await loadCatalogue(code)
  } catch {
    localeOwn = {}
  }
  updateLangButton()
  renderList()
}

/** Start translating a language that isn't offered in the app (or a brand-new
 *  one): prompt for a code, add it to the chooser, and switch to it. Its edits
 *  persist in the overlay and can be exported; if it has no locale file the app
 *  can't render it live, so the preview falls back to English. */
function createLanguage(): void {
  const code = ((win || window).prompt('New language code (e.g. sl, pt-BR):') || '').trim()
  if (!code) return
  if (!languages.some(l => l.code === code)) {
    const entry: Lang = { code, name: displayName(code), status: code in catalogue ? 'hidden' : 'new' }
    languages = [...languages, entry].sort((a, b) => a.name.localeCompare(b.name))
  }
  void selectLocale(code)
}

/** Close the language menu when a click lands outside it (popup document). */
function onDocClick(e: MouseEvent): void {
  if (!langMenu || langMenu.style.display === 'none') return
  const t = e.target as Node
  if (langBtn?.contains(t) || langMenu.contains(t)) return
  closeLangMenu()
}

function buildLangChooser(): HTMLElement {
  langBtn = h('button', {
    'aria-haspopup': 'listbox',
    'aria-expanded': 'false',
    'aria-label': 'Language',
    style: { ...btnStyle, display: 'flex', alignItems: 'center', gap: '6px', width: '180px' },
    onclick: () =>
      langMenu && langMenu.style.display !== 'none' ? closeLangMenu() : openLangMenu(),
  })
  langMenu = h('div', {
    role: 'listbox',
    style: {
      display: 'none', position: 'absolute', top: '100%', right: '0', marginTop: '2px',
      width: '220px', maxHeight: '320px', overflowY: 'auto', zIndex: '10',
      background: '#1c1c1c', border: '1px solid #444', borderRadius: '4px',
      boxShadow: '0 4px 16px rgba(0,0,0,0.5)',
    },
  })
  updateLangButton()
  return h('div', { style: { position: 'relative' } }, langBtn, langMenu)
}

// ---- category filters under the search bar (g) ----------------------------

function chipStyle(on: boolean): Record<string, string> {
  return { ...btnStyle, fontSize: '11px', background: on ? '#ffd479' : 'transparent', color: on ? '#111' : '#ccc' }
}

function filterChip(label: string, key: keyof typeof filters): HTMLButtonElement {
  const btn = h(
    'button',
    {
      'aria-pressed': String(filters[key]),
      title: `Show only ${label} strings`,
      style: chipStyle(filters[key]),
      onclick: () => {
        filters[key] = !filters[key]
        btn.setAttribute('aria-pressed', String(filters[key]))
        Object.assign(btn.style, chipStyle(filters[key]))
        renderList()
      },
    },
    label
  ) as HTMLButtonElement
  return btn
}

function anyFilter(): boolean {
  return filters.untranslated || filters.experimental || filters.stock
}

/** A key passes when it's in at least one enabled category (untranslated for
 *  this locale / experimental / used by core). No filters → everything passes. */
function matchesFilter(key: string): boolean {
  if (!anyFilter()) return true
  return (
    (filters.untranslated && classify(key) === 'en') ||
    (filters.experimental && experimentalKeys.has(key)) ||
    (filters.stock && stockKeys.has(key))
  )
}

function buildPanel(): HTMLElement {
  const langChooser = buildLangChooser()

  const searchInput = h('input', {
    type: 'search',
    placeholder: 'Search keys / text to edit…',
    'aria-label': 'Search translation keys',
    style: {
      width: '100%',
      boxSizing: 'border-box',
      background: '#1c1c1c',
      color: '#eee',
      border: '1px solid #444',
      borderRadius: '3px',
      padding: '4px 6px',
      margin: '6px 0',
    },
    oninput: (e: Event) => {
      search = (e.target as HTMLInputElement).value
      renderList()
    },
  })
  searchInputEl = searchInput

  const filterRow = h(
    'div',
    { style: { display: 'flex', gap: '6px', alignItems: 'center', padding: '0 12px 6px', flexWrap: 'wrap' } },
    h('span', { style: muted }, 'Filter:'),
    filterChip('untranslated', 'untranslated'),
    filterChip('experimental', 'experimental'),
    filterChip('stockstrings', 'stock')
  )

  countEl = h('span', { style: muted }, '0 changes')
  listEl = h('div', {
    style: { flex: '1', overflowY: 'auto', borderTop: '1px solid #2a2a2a' },
  })

  const footerBtn = (label: string, title: string, onclick: () => void) =>
    h('button', { style: btnStyle, title, onclick }, label) as HTMLButtonElement

  // Normal exports carry only the translatable (non-experimental) edits;
  // experimental strings export on their own button (c).
  xmlBtn = footerBtn('Export XML', 'Download translatable edits as partial Android XML', () => {
    const { normal } = changeBuckets()
    if (Object.keys(normal).length)
      download(`${currentLocale}.partial.xml`, toAndroidXml(normal), 'application/xml')
  })
  jsonBtn = footerBtn('Export JSON', 'Download translatable edits as a JSON changeset', () => {
    const { normal } = changeBuckets()
    if (Object.keys(normal).length)
      download(`${currentLocale}.changeset.json`, JSON.stringify(normal, null, 2), 'application/json')
  })
  expBtn = footerBtn('Export experimental', 'Download edited experimental (English-only) keys as JSON', () => {
    const { experimental: exp } = changeBuckets()
    if (Object.keys(exp).length)
      download(`${currentLocale}.experimental.json`, JSON.stringify(exp, null, 2), 'application/json')
  })
  revertBtn = footerBtn('Revert all', 'Discard all edits for this language', async () => {
    if (!Object.keys(overlayFor(currentLocale)).length) return
    // (a) confirm inside the editor's own window, not the main app window.
    const c = (win || window).confirm.bind(win || window)
    if (!c(`Discard all translation edits for ${currentLocale}?`)) return
    revertAll(currentLocale)
    await refreshApp(currentLocale)
    updateLangButton()
    renderList()
  })

  const footer = h(
    'div',
    {
      style: {
        display: 'flex',
        gap: '6px',
        alignItems: 'center',
        padding: '6px 12px',
        borderTop: '1px solid #2a2a2a',
        flexWrap: 'wrap',
      },
    },
    countEl,
    xmlBtn,
    jsonBtn,
    expBtn,
    revertBtn
  )

  const header = h(
    'div',
    {
      style: {
        display: 'flex',
        gap: '6px',
        alignItems: 'center',
        padding: '8px 12px',
        borderBottom: '1px solid #2a2a2a',
      },
    },
    h('strong', { style: { fontSize: '13px', flex: '1' } }, 'Translations'),
    langChooser,
    (inspectBtn = h(
      'button',
      {
        style: btnStyle,
        title: 'Inspect: click an element to find its translation key',
        'aria-label': 'Inspect element',
        'aria-pressed': 'false',
        onclick: () => (inspecting ? stopInspect() : startInspect()),
      },
      '🎯'
    ))
  )

  return h(
    'div',
    {
      role: 'dialog',
      'aria-label': 'Translation editor',
      // Fills its own popup window (see open()). Lives in a separate window so
      // the app's showModal() top-layer dialogs can never cover it — the reason
      // it isn't an in-page panel.
      style: {
        position: 'absolute',
        inset: '0',
        display: 'flex',
        flexDirection: 'column',
        background: '#141414',
        color: '#eee',
        font: '13px system-ui, sans-serif',
      },
    },
    header,
    h('div', { style: { padding: '0 12px' } }, searchInput),
    filterRow,
    listEl,
    footer
  )
}

async function open(): Promise<void> {
  if (win && !win.closed) {
    win.focus()
    return
  }
  currentLocale = (window as any).localeData?.locale || 'en'
  let shown: Array<{ code: string; name: string }>
  try {
    sourceEn = await loadCatalogue('en')
    shown = await loadLanguages()
  } catch (err) {
    console.error('[translation-editor] failed to load locale data', err)
    alert('Translation editor: could not load locale data (see console).')
    return
  }
  try {
    experimental = await fetchJson('locales/_untranslated_en.json')
  } catch {
    experimental = {}
  }
  experimentalKeys = new Set(Object.keys(experimental))
  // Build manifests (best-effort — the editor degrades gracefully without them).
  try {
    catalogue = (await fetchJson('locales/_catalogue.json')) as unknown as Record<string, number>
  } catch {
    catalogue = {}
  }
  try {
    stockKeys = new Set((await (await fetch(BASE + 'locales/_stockstrings.json')).json()) as string[])
  } catch {
    stockKeys = new Set()
  }
  try {
    localeOwn = currentLocale === 'en' ? sourceEn : await loadCatalogue(currentLocale)
  } catch {
    localeOwn = {}
  }
  languages = buildLanguages(shown)
  const w = window.open('', 'slothfulchat-tx', 'popup=yes,width=460,height=820')
  if (!w) {
    alert(
      'Translation editor: the popup was blocked. Allow popups for this site, then press Ctrl/Cmd+Shift+L again.'
    )
    return
  }
  win = w
  w.document.title = 'Translation editor'
  Object.assign(w.document.body.style, { margin: '0', background: '#141414' })
  h = makeH(w.document)
  panel = buildPanel()
  w.document.body.appendChild(panel)
  w.addEventListener('keydown', onPopupKeydown)
  w.addEventListener('pagehide', teardown)
  w.document.addEventListener('click', onDocClick, true) // close lang menu on outside click
  renderList()
}

/** Shared cleanup: stop inspecting and drop panel/window references. Does not
 *  close the window itself (called from its own pagehide, and from close()). */
function teardown(): void {
  stopInspect()
  win = null
  panel = null
  listEl = countEl = searchInputEl = inspectBtn = null
  xmlBtn = jsonBtn = expBtn = revertBtn = langBtn = langMenu = null
  filters = { untranslated: false, experimental: false, stock: false }
  h = makeH(document)
}

function close(): void {
  const w = win
  teardown()
  if (w && !w.closed) {
    w.removeEventListener('pagehide', teardown)
    w.close()
  }
}

function onPopupKeydown(e: KeyboardEvent): void {
  if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'l') {
    e.preventDefault()
    close()
  } else if (e.key === 'Escape') {
    if (langMenu && langMenu.style.display !== 'none') closeLangMenu()
    else if (inspecting) stopInspect()
    else close()
  }
}

function toggle(): void {
  if (win && !win.closed) close()
  else void open()
}

/** Install the tx registry and the open shortcut (Ctrl/Cmd+Shift+L). Call once
 *  at startup — before the app first assigns window.static_translate, so every
 *  tx call is captured for the inspector. `runtime` is the app runtime
 *  (window.r), captured here because the frontend deletes window.r right after
 *  importing it. */
export function initTranslationEditor(runtime?: any): void {
  appRuntime = runtime ?? (window as any).r ?? null
  installRegistry()
  window.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'l') {
      e.preventDefault()
      toggle()
    }
    if (e.key === 'Escape' && (win || inspecting)) {
      if (inspecting) stopInspect()
      else close()
    }
  })
  // Close the popup if the app window unloads so it doesn't orphan.
  window.addEventListener('pagehide', () => win?.close())
}
