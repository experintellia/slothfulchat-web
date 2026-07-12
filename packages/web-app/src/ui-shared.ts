/**
 * Tiny DOM helpers shared by the consent info dialog and diagnostics panel. These
 * are our own overlays (plain DOM, not React) mounted by runtime.ts, so they
 * don't need any upstream frontend patch. Inline styles are used throughout —
 * the CSP allows style-src 'unsafe-inline', and self-contained styling keeps
 * these overlays independent of whichever theme the app is showing.
 */
import { trackLink } from './analytics'

// self-hosting guide, for the "run your own private instance" link in the notice
export const SELFHOSTING_URL =
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
