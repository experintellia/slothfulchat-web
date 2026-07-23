/**
 * Diagnostics panel — an advanced-user overlay reachable in production.
 *
 * Opened from the Log dialog (a small patch adds a "Diagnostics" button there
 * that calls window.__slothfulDiagnostics.open()). Two sections:
 *
 *   • Performance — the local User Timing numbers from perf.ts (cold-start
 *     breakdown, recent-startups list, timed action round-trips) plus a
 *     "copy" button so a user filing a bug can paste them. All local; nothing
 *     is ever sent from here.
 *
 *   • Usage statistics — only when the instance is configured for analytics:
 *     the opt-out toggle plus a one-line summary linking the generated
 *     privacy.html (which renders the exact event catalogue). This is the
 *     "toggle it later" control alongside Settings → Advanced.
 *
 * Plain DOM overlay (no React), so it needs no upstream frontend patch beyond
 * the one button that opens it.
 */
import { snapshot, type StartupRecord } from './perf'
import { isConfigured, getConsent, setConsent } from './analytics'
import { el, linkTo } from './ui-shared'

let root: HTMLDialogElement | null = null

/** Register window.__slothfulDiagnostics so the Log-dialog button can open us,
 * and expose a console entry point for local poking. */
export function initDiagnostics(): void {
  ;(window as any).__slothfulDiagnostics = { open, close }
}

/** Injects the one media query the inline-styled overlay can't express: full
 * screen on phones (inline styles can't hold an @media rule). Idempotent. */
function ensureStyles(): void {
  if (document.getElementById('sc-diag-style')) return
  const st = document.createElement('style')
  st.id = 'sc-diag-style'
  st.textContent =
    '@media (max-width:640px){.sc-diag-panel{width:100vw!important;height:100dvh!important;' +
    'max-height:100dvh!important;border-radius:0!important;padding:16px!important;}}'
  document.head.append(st)
}

export function open(): void {
  if (root) return
  ensureStyles()
  root = buildOverlay()
  document.body.append(root)
  // native <dialog> + showModal: the Log dialog we're opened from is a
  // top-layer modal, so a plain z-index div would render behind it (see
  // consent.ts for the same pattern)
  root.showModal()
}

export function close(): void {
  root?.close()
}

function buildOverlay(): HTMLDialogElement {
  // transparent full-viewport dialog; our own backdrop div inside it
  // (::backdrop can't be styled from inline styles)
  const dlg = el(
    'dialog',
    'position:fixed;inset:0;width:100vw;height:100vh;max-width:none;max-height:none;border:none;padding:0;margin:0;background:transparent;'
  )
  // fires on close() and on Esc — single cleanup path
  dlg.addEventListener('close', () => {
    dlg.remove()
    root = null
  })
  const backdrop = el(
    'div',
    [
      'position:fixed;inset:0;z-index:2147483001;',
      'background:rgba(0,0,0,0.5);',
      'display:flex;align-items:center;justify-content:center;',
      'font:14px/1.5 system-ui,sans-serif;',
    ].join('')
  )
  backdrop.addEventListener('click', e => {
    if (e.target === backdrop) close()
  })

  const panel = el(
    'div',
    [
      'background:#141a18;color:#eef2f0;',
      'width:min(680px,94vw);max-height:88vh;overflow:auto;-webkit-overflow-scrolling:touch;',
      'border-radius:10px;box-shadow:0 10px 40px rgba(0,0,0,0.5);',
      'padding:20px 22px;box-sizing:border-box;',
    ].join('')
  )
  panel.className = 'sc-diag-panel' // hook for the mobile full-screen media query

  // sticky so the title + close stay reachable while the body scrolls (esp.
  // full-screen on mobile); background matches the panel to hide scrolled rows
  const head = el('div', 'display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;position:sticky;top:0;background:#141a18;padding:2px 0 6px;')
  head.append(el('h2', 'margin:0;font-size:18px;', 'Diagnostics'))
  const x = el('button', 'background:none;border:none;color:#eef2f0;font-size:22px;cursor:pointer;line-height:1;', '×')
  x.setAttribute('aria-label', 'Close')
  x.addEventListener('click', close)
  head.append(x)
  panel.append(head)

  panel.append(storageSection())
  panel.append(perfSection())
  if (isConfigured()) panel.append(usageSection())

  backdrop.append(panel)
  dlg.append(backdrop)
  return dlg
}

// --- storage section ----------------------------------------------------

function storageSection(): HTMLElement {
  const s = section(
    'Storage',
    'Your accounts, messages and files live in this browser (OPFS). "Persistent" means the browser will not evict them to reclaim disk space.'
  )
  const table = kvTable('Origin storage', [
    ['Persistent (safe from eviction)', '…'],
    ['Used', '…'],
    ['Quota', '…'],
  ])
  s.append(table)

  const btn = actionButton('Make storage persistent')
  btn.style.display = 'none'
  s.append(btn)

  // StorageManager APIs are async, so fill the cells after the panel is built.
  const valueCell = (row: number) =>
    table.querySelectorAll('tr')[row]?.querySelectorAll('td')[1] ?? null
  const set = (row: number, text: string) => {
    const cell = valueCell(row)
    if (cell) cell.textContent = text
  }
  const mib = (n?: number) => (n === undefined ? '—' : `${(n / 1048576).toFixed(1)} MiB`)

  const refresh = async () => {
    try {
      const persisted = (await navigator.storage?.persisted?.()) ?? false
      set(0, persisted ? 'yes' : 'no — evictable under disk pressure')
      btn.style.display = persisted ? 'none' : ''
      const est = (await navigator.storage?.estimate?.()) ?? {}
      set(1, mib(est.usage))
      set(2, mib(est.quota))
    } catch {
      set(0, 'unavailable')
      set(1, '—')
      set(2, '—')
    }
  }

  btn.addEventListener('click', async () => {
    try {
      const granted = await navigator.storage?.persist?.()
      btn.textContent = granted ? 'Persistent ✓' : 'Browser declined'
      await refresh()
      if (granted) setTimeout(() => btn.remove(), 1500)
    } catch {
      btn.textContent = 'Request failed'
    }
  })

  void refresh()
  return s
}

// --- performance section ------------------------------------------------

function perfSection(): HTMLElement {
  const s = section('Performance', 'Measured locally on this device. Nothing here is sent anywhere.')
  const snap = snapshot()

  s.append(kvTable('Startup (ms since page load)', [
    ['Worker spawned', fmt(snap.marks['worker-spawn'])],
    ['Core ready (first RPC)', fmt(snap.marks['core-ready'])],
    ['UI ready', fmt(snap.marks['ui-ready'])],
    ['UI fully ready', fmt(snap.marks['ui-fully-ready'])],
    ['First account configured', fmt(snap.marks['first-account'])],
    ['worker → core', fmt(snap.measures['worker→core'])],
    ['core → UI', fmt(snap.measures['core→ui'])],
  ]))

  if (snap.actions.length) {
    const rows = snap.actions.map(a => [a.name, `${a.last} (avg ${a.avg}, ${a.count}×)`] as [string, string])
    s.append(kvTable('Actions (ms)', rows))
  }

  if (snap.startups.length) {
    s.append(startupsList(snap.startups))
  }

  const copy = actionButton('Copy diagnostics')
  copy.addEventListener('click', async () => {
    const text = JSON.stringify(snap, null, 2)
    try {
      await navigator.clipboard.writeText(text)
      copy.textContent = 'Copied ✓'
      setTimeout(() => (copy.textContent = 'Copy diagnostics'), 1200)
    } catch {
      copy.textContent = 'Copy failed'
    }
  })
  s.append(copy)
  return s
}

function startupsList(startups: StartupRecord[]): HTMLElement {
  const box = el('div', 'margin:10px 0;')
  box.append(el('div', 'font-weight:600;margin-bottom:4px;', `Recent startups (last ${startups.length})`))
  const line = startups
    .slice()
    .reverse()
    .map(r => `${Math.round(r.uiReady ?? r.coreReady ?? 0)}${r.mode && r.mode !== 'unknown' ? r.mode[0] : ''}`)
    .join(' · ')
  box.append(
    el(
      'div',
      'font-family:monospace;font-size:12px;opacity:0.85;word-break:break-word;',
      line + ' ms  (c=cold/onboarding, w=warm)'
    )
  )
  return box
}

// --- usage-statistics section ------------------------------------------

function usageSection(): HTMLElement {
  const s = section('Usage statistics', 'Anonymous, aggregated — helps improve the app.')

  const row = el('label', 'display:flex;gap:10px;align-items:center;margin:8px 0;cursor:pointer;')
  const cb = el('input') as HTMLInputElement
  cb.type = 'checkbox'
  cb.checked = getConsent() !== 'denied'
  cb.addEventListener('change', () => setConsent(cb.checked ? 'granted' : 'denied'))
  row.append(cb, el('span', '', 'Send anonymous usage statistics'))
  s.append(row)

  const foot = el('p', 'margin:8px 0 0;font-size:13px;')
  foot.append(
    document.createTextNode(
      'Anonymous, aggregated counts only — never message content, addresses, or free text. Full details, including the exact list of events: '
    ),
    linkTo('privacy.html', 'privacy policy')
  )
  s.append(foot)
  return s
}

// --- little building blocks --------------------------------------------

function section(title: string, subtitle: string): HTMLElement {
  const wrap = el('section', 'margin-top:18px;padding-top:14px;border-top:1px solid #2a332f;')
  wrap.append(el('h3', 'margin:0 0 2px;font-size:15px;', title))
  wrap.append(el('div', 'opacity:0.7;font-size:12px;margin-bottom:6px;', subtitle))
  return wrap
}

function kvTable(caption: string, rows: [string, string][]): HTMLElement {
  const box = el('div', 'margin:10px 0;')
  box.append(el('div', 'font-weight:600;margin-bottom:4px;', caption))
  const table = el('table', 'width:100%;border-collapse:collapse;font-size:13px;')
  for (const [k, v] of rows) {
    const tr = el('tr')
    tr.append(el('td', 'padding:2px 8px 2px 0;opacity:0.85;', k))
    tr.append(el('td', 'padding:2px 0;text-align:right;font-family:monospace;', v))
    table.append(tr)
  }
  box.append(table)
  return box
}

function actionButton(label: string): HTMLButtonElement {
  return el(
    'button',
    'margin-top:12px;font:inherit;cursor:pointer;border-radius:6px;padding:8px 14px;background:#2c8a68;color:#fff;border:none;',
    label
  )
}

const fmt = (n?: number) => (n === undefined ? '—' : String(Math.round(n)))
