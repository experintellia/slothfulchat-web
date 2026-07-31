/**
 * html-email.ts — logic for static/html-email.html, the HTML email viewer
 * wrapper (browser edition of desktop's windows/html_email.ts).
 *
 * runtime.ts (openMessageHTML) hosts this page in a fullscreen <dialog>
 * iframe and, being same-origin, calls window.__initHtmlEmail() directly with
 * the message and callbacks once the page has loaded.
 *
 * The email body is rendered with three independent layers between it and
 * everything else (any one alone would already stop script execution):
 *
 *   1. iframe sandbox WITHOUT allow-scripts / allow-same-origin: the content
 *      document has an opaque origin and can never execute JS, whatever the
 *      markup says. allow-popups + allow-popups-to-escape-sandbox let a
 *      rewritten target=_blank link open normally in a new tab.
 *   2. an authored <meta> CSP inside the content document: default-src
 *      'none', script-src implied 'none', and img/media/font limited to data:
 *      until the user opts into remote content. A leftover <meta> CSP from
 *      the mail could only tighten this further, never loosen it (CSPs
 *      combine restrictively) — and DOMPurify strips <meta> anyway.
 *   3. DOMPurify sanitization: scripts, event handlers, javascript: URLs,
 *      <meta>/<base>/<link> and form controls removed; every link forced to
 *      target=_blank rel=noopener noreferrer (clicking is the only way to
 *      navigate — there is no JS — so in-frame navigation can't happen).
 *
 * Remote content ("Load Remote Images", desktop parity): never / once /
 * always. Blocking is done by the authored CSP (layer 2) — the browser then
 * never issues the requests. "always" persists via the
 * HTMLEmailAlwaysLoadRemoteContent desktop setting through a callback; for
 * contact requests "always" is not offered and the initial state is always
 * blocked, exactly like desktop. When allowed, images load as ordinary
 * no-cors <img> fetches (missing CORS headers don't matter), with
 * referrer suppressed via <meta name=referrer> + rel=noreferrer.
 */
import DOMPurify from 'dompurify'

export type HtmlEmailInit = {
  subject: string
  from: string
  sentTime: string
  /** raw HTML from core's getMessageHtml (cid: images already inlined as data: URIs) */
  content: string
  isContactRequest: boolean
  alwaysLoadRemote: boolean
  labels: {
    loadRemoteImages: string
    ask: string
    never: string
    once: string
    always: string
    close: string
  }
  onClose: () => void
  onSetAlwaysLoad: (value: boolean) => void
}

// mirrors desktop's CSP_DENY / CSP_ALLOW (windows/html_email.ts): remote
// opt-in adds http(s) to img/media/font only — remote stylesheets never load
const contentCsp = (remote: boolean): string => {
  const net = remote ? ' http: https:' : ''
  return (
    `default-src 'none'; img-src data: blob:${net}; media-src data:${net}; ` +
    `font-src data:${net}; style-src 'unsafe-inline' data:; ` +
    `form-action 'none'; frame-src 'none'`
  )
}

DOMPurify.addHook('afterSanitizeAttributes', node => {
  // every link opens outside the sandbox (rewriting is safe because with no
  // JS a user click is the only possible navigation); noreferrer keeps the
  // instance URL out of the target's logs, matching the content doc's
  // <meta name=referrer>. toUpperCase: SVG anchors report a lowercase 'a' —
  // an unrewritten one would navigate the content frame itself on click,
  // loading a remote page without the opt-in
  const tag = node.tagName.toUpperCase()
  if (tag === 'A' || tag === 'AREA') {
    node.setAttribute('target', '_blank')
    node.setAttribute('rel', 'noopener noreferrer')
  }
})

/** Sanitize once, returning the email as a mutable document (head + body kept
 * so <head><style> from real-world mail survives). */
function sanitize(content: string): HTMLElement {
  return DOMPurify.sanitize(content, {
    WHOLE_DOCUMENT: true,
    RETURN_DOM: true,
    // beyond DOMPurify's defaults: no policy/base/fetch tags (layer 2 blocks
    // their effects anyway) and no dead form controls (form-action 'none')
    FORBID_TAGS: ['meta', 'base', 'link', 'form', 'input', 'button', 'select', 'textarea'],
  }) as unknown as HTMLElement // RETURN_DOM + WHOLE_DOCUMENT => <html> element
}

/** Serialize the sanitized email into a full standalone document with our
 * charset + CSP + referrer <meta>s and base style prepended. Clones the
 * sanitized DOM so re-renders (remote toggle) start from a pristine copy. */
function buildContentDoc(sanitizedShared: HTMLElement, remote: boolean): string {
  const sanitized = sanitizedShared.cloneNode(true) as HTMLElement
  const doc = sanitizedShared.ownerDocument
  const head =
    sanitized.querySelector('head') ?? sanitized.insertBefore(doc.createElement('head'), sanitized.firstChild)
  const meta = (attrs: Record<string, string>) => {
    const el = doc.createElement('meta')
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v)
    return el
  }
  head.prepend(
    meta({ charset: 'utf-8' }),
    meta({ 'http-equiv': 'Content-Security-Policy', content: contentCsp(remote) }),
    meta({ name: 'referrer', content: 'no-referrer' })
  )
  // emails assume a white canvas (desktop forces the same via insertCSS)
  const style = doc.createElement('style')
  style.textContent = ':root { color: #000; background-color: #fff; } body { margin: 8px; }'
  head.append(style)
  return '<!doctype html>\n' + sanitized.outerHTML
}

function init(payload: HtmlEmailInit): void {
  const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
  document.title = `${payload.subject} – ${payload.from}`
  $('subject').textContent = payload.subject
  $('from').textContent = payload.from
  $('date').textContent = payload.sentTime
  $('remote-caption').textContent = payload.labels.loadRemoteImages

  const sanitized = sanitize(payload.content)
  const host = $('frame-host')
  let blobUrl: string | undefined
  const render = (remote: boolean) => {
    if (blobUrl) URL.revokeObjectURL(blobUrl)
    blobUrl = URL.createObjectURL(new Blob([buildContentDoc(sanitized, remote)], { type: 'text/html' }))
    const frame = document.createElement('iframe')
    // NO allow-scripts, NO allow-same-origin — see layer 1 in the header
    frame.setAttribute('sandbox', 'allow-popups allow-popups-to-escape-sandbox')
    frame.setAttribute('referrerpolicy', 'no-referrer')
    frame.title = 'email content'
    frame.src = blobUrl
    host.replaceChildren(frame)
  }

  // never / once / always control (desktop's three-state remote-content
  // dialog as a native <select>; contact requests never get "always")
  const select = $<HTMLSelectElement>('remote-select')
  const states: Array<'never' | 'once' | 'always'> = payload.isContactRequest
    ? ['never', 'once']
    : ['never', 'once', 'always']
  select.replaceChildren(
    ...states.map(state => {
      const option = document.createElement('option')
      option.value = state
      option.textContent = payload.labels[state]
      return option
    })
  )
  const initialRemote = payload.alwaysLoadRemote && !payload.isContactRequest
  select.value = initialRemote ? 'always' : 'never'
  $('remote').title = payload.labels.ask
  select.addEventListener('change', () => {
    const state = select.value as (typeof states)[number]
    if (!payload.isContactRequest) payload.onSetAlwaysLoad(state === 'always')
    render(state !== 'never')
  })

  const close = $('close')
  close.setAttribute('aria-label', payload.labels.close)
  close.addEventListener('click', payload.onClose)
  window.addEventListener('keydown', e => {
    if (e.key === 'Escape') payload.onClose()
  })

  render(initialRemote)
}

;(window as any).__initHtmlEmail = init
