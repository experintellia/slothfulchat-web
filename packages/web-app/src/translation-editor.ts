/**
 * In-app translation editor + element inspector —
 * docs/translation-editor-design.md, Phases 1 and 2.
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
 * common cases without contaminating the DOM). Opened with Ctrl/Cmd+Shift+L or
 * ?txedit — dev-gated, so it costs normal users nothing but the import.
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

/** Re-run the app's own language reload so edits render immediately. */
async function refreshApp(locale: string): Promise<void> {
  const runtime = (window as any).r
  if (runtime?.onChooseLanguage) await runtime.onChooseLanguage(locale)
}

async function fetchJson(path: string): Promise<Record<string, Entry>> {
  const res = await fetch(BASE + path)
  if (!res.ok) throw new Error(`fetch ${path}: ${res.status}`)
  return res.json()
}

/** The pristine (un-overlaid) messages for a locale, matching getLocaleData. */
async function loadPristine(locale: string): Promise<Record<string, Entry>> {
  const untranslated = await fetchJson('locales/_untranslated_en.json')
  const base = await fetchJson(
    locale === 'en' ? 'locales/en.json' : `locales/${locale}.json`
  )
  return { ...base, ...untranslated }
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

function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Record<string, any> = {},
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
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

// ---- panel ----------------------------------------------------------------

let panel: HTMLElement | null = null
let currentLocale = 'en'
let sourceEn: Record<string, Entry> = {}
let pristine: Record<string, Entry> = {}
let languages: Array<{ code: string; name: string }> = []
let search = ''
let listEl: HTMLElement | null = null
let countEl: HTMLElement | null = null
let searchInputEl: HTMLInputElement | null = null
let inspectBtn: HTMLButtonElement | null = null

const muted = { color: '#9aa', fontSize: '11px' }

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

function onInspectMove(e: MouseEvent): void {
  const target = e.target as Element | null
  if (!target || !hlBox || !tip || inThePanel(target)) {
    if (hlBox) hlBox.style.display = 'none'
    if (tip) tip.style.display = 'none'
    return
  }
  const rect = target.getBoundingClientRect()
  Object.assign(hlBox.style, {
    display: 'block',
    left: `${rect.left}px`,
    top: `${rect.top}px`,
    width: `${rect.width}px`,
    height: `${rect.height}px`,
  })
  const matches = matchKeys((window as any).__txRegistry || new Map(), candidateStrings(target))
  const comp = fiberComponentName(target)
  tip.replaceChildren()
  if (matches.length) {
    for (const m of matches.slice(0, 3))
      tip.append(h('div', { style: { color: '#ffd479' } }, m.keys.join(' / ')))
  } else {
    tip.append(h('div', { style: muted }, 'no tx key for this text'))
  }
  if (comp) tip.append(h('div', { style: muted }, `<${comp}>`))
  tip.style.display = 'block'
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
  hlBox = h('div', {
    style: {
      position: 'fixed',
      pointerEvents: 'none',
      zIndex: '2147483001',
      border: '2px solid #ffd479',
      background: 'rgba(255,212,121,0.15)',
      borderRadius: '2px',
    },
  })
  tip = h('div', {
    style: {
      position: 'fixed',
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
    listEl?.querySelector('input')?.focus()
  }
  if (panel) focus()
  else void open().then(focus)
}

/** Render the key rows: changed keys when the search box is empty (the change
 *  list), otherwise keys matching the query (capped — see ceiling below). */
function renderList(): void {
  if (!listEl || !countEl) return
  const overlay = overlayFor(currentLocale)
  const changedKeys = Object.keys(overlay)
  countEl.textContent = `${changedKeys.length} change${
    changedKeys.length === 1 ? '' : 's'
  }`

  const term = search.trim().toLowerCase()
  let keys: string[]
  let capped = false
  if (!term) {
    keys = changedKeys.sort()
  } else {
    const all = Object.keys(sourceEn).sort()
    keys = all.filter(k => {
      if (k.toLowerCase().includes(term)) return true
      const cur = overlay[k] || pristine[k] || sourceEn[k] || {}
      return Object.values(cur).some(v => v.toLowerCase().includes(term))
    })
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
        term ? 'No matching keys.' : 'No changes yet — search a key to edit.'
      )
    )
    return
  }
  for (const key of keys) listEl.append(row(key, overlay))
  if (capped)
    listEl.append(
      h(
        'div',
        { style: { ...muted, padding: '8px 12px' } },
        'Showing first 200 matches — narrow the search to see more.'
      )
    )
}

function row(key: string, overlay: Record<string, Entry>): HTMLElement {
  const base: Entry = pristine[key] || sourceEn[key] || { message: '' }
  const current: Entry = overlay[key] || base
  const isPlural = typeof base.message !== 'string'
  const fields = isPlural ? Object.keys(base) : ['message']
  const changed = key in overlay

  const header = h(
    'div',
    { style: { display: 'flex', justifyContent: 'space-between', gap: '6px' } },
    h(
      'code',
      { style: { fontSize: '11px', color: changed ? '#ffd479' : '#8cf' } },
      key
    ),
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
      : document.createTextNode('')
  )

  const inputs = fields.map(field => {
    const enRef = (sourceEn[key] || {})[field] ?? (sourceEn[key] || {}).message
    const input = h('input', {
      value: current[field] ?? '',
      'aria-label': `${key}${isPlural ? ' ' + field : ''}`,
      style: {
        width: '100%',
        boxSizing: 'border-box',
        background: changed ? '#2a2a1a' : '#1c1c1c',
        color: '#eee',
        border: '1px solid #444',
        borderRadius: '3px',
        padding: '3px 5px',
        fontSize: '12px',
      },
      onchange: async (e: Event) => {
        editValue(
          currentLocale,
          key,
          field,
          (e.target as HTMLInputElement).value,
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
    // Show the English source under a non-English locale for context.
    if (currentLocale !== 'en' && enRef)
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

function buildPanel(): HTMLElement {
  const select = h(
    'select',
    {
      'aria-label': 'Language',
      style: { ...btnStyle, maxWidth: '160px' },
      onchange: async (e: Event) => {
        currentLocale = (e.target as HTMLSelectElement).value
        await refreshApp(currentLocale)
        try {
          pristine =
            currentLocale === 'en' ? sourceEn : await loadPristine(currentLocale)
        } catch {
          pristine = {}
        }
        renderList()
      },
    },
    ...languages.map(l =>
      h('option', { value: l.code, selected: l.code === currentLocale }, `${l.name} (${l.code})`)
    )
  )

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

  countEl = h('span', { style: muted }, '0 changes')
  listEl = h('div', {
    style: { flex: '1', overflowY: 'auto', borderTop: '1px solid #2a2a2a' },
  })

  const footerBtn = (label: string, title: string, onclick: () => void) =>
    h('button', { style: btnStyle, title, onclick }, label)

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
    footerBtn('Export XML', 'Download changed keys as partial Android XML', () => {
      const entries = overlayFor(currentLocale)
      if (Object.keys(entries).length)
        download(`${currentLocale}.partial.xml`, toAndroidXml(entries), 'application/xml')
    }),
    footerBtn('Export JSON', 'Download changed keys as a JSON changeset', () => {
      const entries = overlayFor(currentLocale)
      if (Object.keys(entries).length)
        download(
          `${currentLocale}.changeset.json`,
          JSON.stringify(entries, null, 2),
          'application/json'
        )
    }),
    footerBtn('Revert all', 'Discard all edits for this language', async () => {
      if (!Object.keys(overlayFor(currentLocale)).length) return
      if (!confirm(`Discard all translation edits for ${currentLocale}?`)) return
      revertAll(currentLocale)
      await refreshApp(currentLocale)
      renderList()
    })
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
    select,
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
    )),
    h(
      'button',
      { style: btnStyle, title: 'Close (Esc)', 'aria-label': 'Close', onclick: close },
      '✕'
    )
  )

  return h(
    'div',
    {
      role: 'dialog',
      'aria-label': 'Translation editor',
      // ponytail: a plain fixed panel, not a native <dialog> — it must stay
      // non-modal so the app underneath updates live while you edit. It sits
      // below any showModal() top-layer dialog, which is fine for a dev tool.
      style: {
        position: 'fixed',
        top: '0',
        right: '0',
        width: 'min(400px, 100vw)',
        height: '100vh',
        zIndex: '2147483000',
        display: 'flex',
        flexDirection: 'column',
        background: '#141414',
        color: '#eee',
        borderLeft: '1px solid #333',
        boxShadow: '-4px 0 16px rgba(0,0,0,0.5)',
        font: '13px system-ui, sans-serif',
      },
    },
    header,
    h('div', { style: { padding: '0 12px' } }, searchInput),
    listEl,
    footer
  )
}

async function open(): Promise<void> {
  if (panel) return
  currentLocale = (window as any).localeData?.locale || 'en'
  try {
    sourceEn = await loadPristine('en')
    pristine = currentLocale === 'en' ? sourceEn : await loadPristine(currentLocale)
    languages = await loadLanguages()
  } catch (err) {
    console.error('[translation-editor] failed to load locale data', err)
    alert('Translation editor: could not load locale data (see console).')
    return
  }
  panel = buildPanel()
  document.body.appendChild(panel)
  renderList()
}

function close(): void {
  stopInspect()
  panel?.remove()
  panel = null
  listEl = countEl = searchInputEl = inspectBtn = null
}

function toggle(): void {
  if (panel) close()
  else void open()
}

/** Install the tx registry and the dev-gated open shortcut. Call once at
 *  startup — before the app first assigns window.static_translate, so every tx
 *  call is captured for the inspector. */
export function initTranslationEditor(): void {
  installRegistry()
  window.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'l') {
      e.preventDefault()
      toggle()
    }
    if (e.key === 'Escape') {
      if (inspecting) stopInspect()
      else if (panel) close()
    }
  })
  if (new URLSearchParams(location.search).has('txedit')) void open()
}
