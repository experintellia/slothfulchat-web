/**
 * One-time usage-statistics notice for the demo instance.
 *
 * Shown once, on startup, only when the instance was built with analytics
 * configured AND the visitor has not made a choice yet. It is an *opt-out*
 * notice: stats are enabled by default on the demo instance, but the visitor is
 * told up front, can see exactly what is collected, and can opt out right here
 * or later in the diagnostics panel. The choice is remembered in localStorage,
 * so this appears only once. Self-hosted builds never reach this code because
 * isConfigured() is false there.
 */
import { isConfigured, getConsent, setConsent } from './analytics'
import { el, whatIsCollected } from './ui-shared'

const APP_NAME = () => (window as any).__slothfulConfig?.instanceName || 'This app'

/** Mount the banner if appropriate. Returns true if it was shown. */
export function maybeShowConsentBanner(): boolean {
  if (!isConfigured() || getConsent() !== 'unset') return false
  if (typeof document === 'undefined' || !document.body) return false
  document.body.append(buildBanner())
  return true
}

function buildBanner(): HTMLElement {
  const bar = el(
    'div',
    [
      'position:fixed;left:0;right:0;bottom:0;z-index:2147483000;',
      'background:#1f2b27;color:#eef2f0;',
      'box-shadow:0 -2px 12px rgba(0,0,0,0.35);',
      'font:14px/1.5 system-ui,sans-serif;',
      'padding:14px 16px;box-sizing:border-box;',
    ].join('')
  )
  const inner = el('div', 'max-width:56rem;margin:0 auto;')

  const msg = el('div', 'display:flex;flex-wrap:wrap;gap:12px;align-items:center;')
  msg.append(
    el(
      'div',
      'flex:1 1 260px;min-width:220px;',
      `${APP_NAME()} is a public demo. To improve it, we collect anonymous, ` +
        `aggregated usage statistics — never your messages or personal data.`
    )
  )

  const details = el('div', 'display:none;margin-top:12px;')
  details.append(whatIsCollected())

  const detailsBtn = btn('secondary', 'What’s collected?')
  detailsBtn.addEventListener('click', () => {
    const open = details.style.display !== 'none'
    details.style.display = open ? 'none' : 'block'
    detailsBtn.textContent = open ? 'What’s collected?' : 'Hide details'
  })

  const allow = btn('primary', 'Allow')
  allow.addEventListener('click', () => {
    setConsent('granted')
    bar.remove()
  })
  const deny = btn('secondary', 'Opt out')
  deny.addEventListener('click', () => {
    setConsent('denied')
    bar.remove()
  })

  const actions = el('div', 'display:flex;gap:8px;flex-wrap:wrap;')
  actions.append(detailsBtn, deny, allow)
  msg.append(actions)

  inner.append(msg, details)
  bar.append(inner)
  return bar
}

function btn(kind: 'primary' | 'secondary', label: string): HTMLButtonElement {
  const base =
    'font:inherit;cursor:pointer;border-radius:6px;padding:8px 14px;border:1px solid transparent;'
  const style =
    kind === 'primary'
      ? base + 'background:#2c8a68;color:#fff;'
      : base + 'background:transparent;color:#eef2f0;border-color:#4a5a54;'
  return el('button', style, label)
}
