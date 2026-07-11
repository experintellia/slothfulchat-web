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
 *     the opt-out toggle and the same "what's collected" disclosure the consent
 *     banner shows. This is the "toggle it later in settings" control.
 *
 * Plain DOM overlay (no React), so it needs no upstream frontend patch beyond
 * the one button that opens it.
 */
import { snapshot, type StartupRecord } from './perf'
import { isConfigured, getConsent, setConsent } from './analytics'
import { el, whatIsCollected, imprintUrl, linkTo } from './ui-shared'

let root: HTMLElement | null = null

/** Register window.__slothfulDiagnostics so the Log-dialog button can open us,
 * and expose a console entry point for local poking. */
export function initDiagnostics(): void {
  ;(window as any).__slothfulDiagnostics = { open, close }
}

export function open(): void {
  if (root) return
  root = buildOverlay()
  document.body.append(root)
}

export function close(): void {
  root?.remove()
  root = null
}

function buildOverlay(): HTMLElement {
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
      'width:min(680px,94vw);max-height:88vh;overflow:auto;',
      'border-radius:10px;box-shadow:0 10px 40px rgba(0,0,0,0.5);',
      'padding:20px 22px;box-sizing:border-box;',
    ].join('')
  )

  const head = el('div', 'display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;')
  head.append(el('h2', 'margin:0;font-size:18px;', 'Diagnostics'))
  const x = el('button', 'background:none;border:none;color:#eef2f0;font-size:22px;cursor:pointer;line-height:1;', '×')
  x.setAttribute('aria-label', 'Close')
  x.addEventListener('click', close)
  head.append(x)
  panel.append(head)

  panel.append(perfSection())
  if (isConfigured()) panel.append(usageSection())

  return backdrop
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

  s.append(whatIsCollected())

  const foot = el('p', 'margin:8px 0 0;font-size:13px;')
  foot.append(document.createTextNode('Full details: '), linkTo(imprintUrl(), 'imprint & privacy notice'))
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
