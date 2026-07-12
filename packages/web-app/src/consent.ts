/**
 * Usage-statistics info dialog for the demo instance.
 *
 * Opened from a user action — the "Share anonymous usage statistics" checkbox
 * on the welcome screen (desktop patch, via window.__slothfulAnalyticsUi in
 * runtime.ts). Stats are *opt-out*: they are on by default on the demo
 * instance, and the checkbox (also in Settings → Advanced and the diagnostics
 * panel) turns them off. The dialog shows the summary (exact event list on
 * privacy.html) and its "Opt out" / "Accept" buttons record a choice too, so
 * callers re-sync their checkbox from the returned promise. Self-hosted
 * builds never reach this code because analytics is unconfigured there.
 */
import { setConsent } from './analytics'
import { el, linkTo, SELFHOSTING_URL } from './ui-shared'

const APP_NAME = () => (window as any).__slothfulConfig?.instanceName || 'This app'

/** Open the info dialog. Resolves when it closes (button or Esc) — the
 * buttons may have changed consent, so callers re-read it then. */
export function showAnalyticsInfoDialog(): Promise<void> {
  if (typeof document === 'undefined' || !document.body) return Promise.resolve()
  const dlg = buildDialog()
  document.body.append(dlg)
  dlg.showModal()
  return new Promise(resolve => dlg.addEventListener('close', () => resolve()))
}

function buildDialog(): HTMLDialogElement {
  // Native <dialog> + showModal(): the app's own dialogs (upstream Dialog.tsx)
  // also use showModal(), which puts them in the browser *top layer* — no
  // z-index on a plain div can stack above that, so we must join it too. We
  // open from a user action, so ours is the last showModal() and lands on top.
  // The dialog element itself is just a transparent full-viewport container;
  // the dimmed backdrop stays our own div below, because the native ::backdrop
  // pseudo-element can't be styled from inline styles (CSP: no stylesheets).
  const dlg = el(
    'dialog',
    'position:fixed;inset:0;width:100vw;height:100vh;max-width:none;max-height:none;border:none;padding:0;margin:0;background:transparent;'
  )
  // Esc may dismiss it (same as closing without a new choice) — clean up
  dlg.addEventListener('close', () => dlg.remove())

  // full-screen overlay: dimmed backdrop with a centered, scrollable card
  const overlay = el(
    'div',
    [
      'position:fixed;inset:0;z-index:2147483000;',
      'background:rgba(0,0,0,0.55);',
      'display:flex;align-items:center;justify-content:center;',
      'padding:16px;box-sizing:border-box;',
    ].join('')
  )
  const card = el(
    'div',
    [
      'max-width:34rem;max-height:90vh;overflow:auto;',
      'background:#1f2b27;color:#eef2f0;border-radius:12px;',
      'box-shadow:0 8px 32px rgba(0,0,0,0.45);',
      'font:14px/1.5 system-ui,sans-serif;',
      'padding:26px;box-sizing:border-box;',
    ].join('')
  )

  card.append(
    el('h2', 'margin:0 0 10px;font-size:18px;', 'Anonymous usage statistics'),
    el(
      'p',
      'margin:0 0 12px;',
      `${APP_NAME()} is a public demo. To improve it, we collect anonymous, ` +
        `aggregated usage statistics.`
    )
  )

  // compact always-visible summary; the exact event list lives on privacy.html
  const list = el('ul', 'margin:0 0 12px;padding-left:20px;list-style:disc;line-height:1.4;')
  for (const [lead, tail] of [
    ['App opened', ' — and progress through account setup'],
    ['Message kind', ' — text / image / voice / … — never the content'],
    ['Timings & milestones', ' — e.g. how long startup took'],
    [
      'Never:',
      ' any personally identifiable information — no message content, contact or email addresses, free text, or cookies',
    ],
  ]) {
    const item = el('li', 'margin:3px 0;')
    item.append(el('strong', '', lead), document.createTextNode(tail))
    list.append(item)
  }
  card.append(list)

  const selfhost = el('p', 'margin:0 0 12px;')
  selfhost.append(
    document.createTextNode('Want zero analytics? Just opt out — nothing will be sent. '),
    document.createTextNode('Prefer it never even being asked? '),
    linkTo(SELFHOSTING_URL, 'Run your own instance'),
    document.createTextNode(' — self-hosted builds ship without analytics entirely.')
  )
  const policy = el('p', 'margin:0 0 16px;')
  policy.append(linkTo('privacy.html', 'Read the full privacy policy — including the exact list of events'))
  card.append(selfhost, policy)

  const optOut = btn('secondary', 'Opt out')
  optOut.addEventListener('click', () => {
    setConsent('denied')
    dlg.close()
  })
  const accept = btn('primary', 'Accept')
  accept.addEventListener('click', () => {
    setConsent('granted')
    dlg.close()
  })
  card.append(el('div', 'display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap;', [optOut, accept]))

  overlay.append(card)
  dlg.append(overlay)
  return dlg
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
