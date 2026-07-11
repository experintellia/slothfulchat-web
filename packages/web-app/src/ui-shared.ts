/**
 * Tiny DOM helpers shared by the consent banner and diagnostics panel. These
 * are our own overlays (plain DOM, not React) mounted by runtime.ts, so they
 * don't need any upstream frontend patch. Inline styles are used throughout —
 * the CSP allows style-src 'unsafe-inline', and self-contained styling keeps
 * these overlays independent of whichever theme the app is showing.
 */
import { EVENTS, trackLink } from './analytics'

// self-hosting guide, for the "run your own private instance" link in the notice
const SELFHOSTING_URL =
  'https://github.com/experintellia/slothfulchat-web/blob/main/SELFHOSTING.md'

/** Minimal createElement: tag, inline style string, text/children. */
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  style = '',
  content?: string | Node | (string | Node)[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (style) node.setAttribute('style', style)
  if (content != null) {
    for (const c of Array.isArray(content) ? content : [content]) {
      node.append(typeof c === 'string' ? document.createTextNode(c) : c)
    }
  }
  return node
}

/** Instance imprint/privacy URL (imprint.html is always emitted by
 * assemble.mjs, so this link is always valid). */
export function imprintUrl(): string {
  return (window as any).__slothfulConfig?.imprintUrl || 'imprint.html'
}

/** The "what exactly is collected" block, rendered from the single source of
 * truth (analytics.EVENTS) so the disclosure can never drift from the code. */
export function whatIsCollected(): HTMLElement {
  const wrap = el('div', 'font-size:13px;line-height:1.5;')
  wrap.append(
    el(
      'p',
      'margin:0 0 8px;',
      'Anonymous, aggregated counts only. No message content, no contact or ' +
        'email addresses, no account data, and no free text ever leave your ' +
        'device. There are no cookies and no cross-site tracking. Exactly these ' +
        'events, and nothing else, may be sent:'
    )
  )
  const list = el('ul', 'margin:0 0 8px;padding-left:18px;')
  for (const e of EVENTS) {
    const li = el('li', 'margin:2px 0;')
    li.append(el('code', 'font-weight:600;', e.name), document.createTextNode(' — ' + e.what))
    if (e.props) li.append(el('span', 'opacity:0.7;', ' (' + e.props + ')'))
    list.append(li)
  }
  wrap.append(list)
  const foot = el('p', 'margin:0;')
  foot.append(
    document.createTextNode('You can opt out any time, and you can '),
    linkTo(SELFHOSTING_URL, 'run your own private instance'),
    document.createTextNode(' with no analytics at all. See the '),
    linkTo(imprintUrl(), 'imprint & privacy notice'),
    document.createTextNode('.')
  )
  wrap.append(foot)
  return wrap
}

export function linkTo(href: string, text: string): HTMLAnchorElement {
  const a = el('a', 'color:#2c8a68;', text)
  a.href = href
  a.target = '_blank'
  a.rel = 'noopener'
  // our overlay anchors navigate directly (not via runtime.openLink), so count
  // the tracked ones here too
  a.addEventListener('click', () => trackLink(href))
  return a
}
