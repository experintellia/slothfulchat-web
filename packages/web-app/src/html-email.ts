/**
 * html-email.ts — logic for static/html-email.html, the HTML email viewer
 * wrapper (browser edition of desktop's windows/html_email.ts).
 *
 * runtime.ts (openMessageHTML) hosts this page in a fullscreen <dialog>
 * iframe or a desktop popup window and, being same-origin, calls
 * window.__initHtmlEmail() directly with the message and callbacks. The
 * wrapper is REUSED: init may run again for another message, so all handlers
 * are assigned via on* properties (re-assignment replaces, never stacks).
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
 *      <meta>/<base>/<link> and form controls removed. Links: http(s)/
 *      mailto:/tel: get target=_blank rel=noopener noreferrer (with no JS a
 *      user click is the only possible navigation, and it leaves the
 *      sandbox); pure-#fragment links stay untouched (same-document jumps
 *      are allowed in the sandbox); anything else (relative hrefs would
 *      resolve against the blob: base into dead or weird navigations) loses
 *      its href.
 *
 * Remote content ("Load Remote Images", desktop parity): never / once /
 * always — exposed as a labeled control on desktop widths and inside the ⋮
 * menu on mobile (max-width 500px, the app's $dialog-breakpoint). Blocking is
 * done by the authored CSP (layer 2) — the browser then never issues the
 * requests. "always" persists via the HTMLEmailAlwaysLoadRemoteContent
 * desktop setting through a callback; for contact requests "always" is not
 * offered and the initial state is always blocked, exactly like desktop.
 * When allowed, images load as ordinary no-cors <img> fetches (missing CORS
 * headers don't matter), with referrer suppressed via <meta name=referrer> +
 * rel=noreferrer.
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
  /** account the mail was opened from; tags relayed links so app links run
   * under the originating account, not whatever is selected now (#3) */
  accountId?: number
}

type RemoteState = 'never' | 'once' | 'always'

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

/** Links the app handles itself (desktop's shouldHandleLinkInMainApp set +
 * the dcaccount/dclogin QR schemes): rewritten to open a same-origin relay
 * tab that forwards the URL to the app — see the relay bootstrap below. */
const APP_LINK = /^(mailto:|openpgp4fpr:|dcaccount:|dclogin:|https:\/\/i\.delta\.chat\/)/i
/** This page doubles as the relay target (see the bootstrap at the bottom). */
const RELAY_URL = new URL('./html-email.html', location.href).href

// Account the current mail was opened from; set by init() before sanitizing so
// the module-level rewrite hook can tag every relayed link with it (#3). The
// hook runs synchronously inside sanitize(), so a plain module var is safe.
let currentAccountId: number | undefined
const relayHref = (href: string) =>
  `${RELAY_URL}#open=${encodeURIComponent(href)}` +
  (currentAccountId != null ? `&acct=${currentAccountId}` : '')

// DOMPurify's default ALLOWED_URI_REGEXP would strip the QR schemes before
// the hook below can see them — same regexp with those schemes added
const ALLOWED_URI_REGEXP =
  /^(?:(?:(?:f|ht)tps?|mailto|tel|callto|sms|cid|xmpp|openpgp4fpr|dcaccount|dclogin):|[^a-z]|[a-z+.-]+(?:[^a-z+.\-:]|$))/i

DOMPurify.addHook('afterSanitizeAttributes', node => {
  // toUpperCase: SVG anchors report a lowercase 'a'
  const tag = node.tagName.toUpperCase()
  if (tag !== 'A' && tag !== 'AREA') return
  const href = node.getAttribute('href') ?? node.getAttribute('xlink:href') ?? ''
  if (APP_LINK.test(href) || /^https?:/i.test(href)) {
    // Route through the app via the relay page: the sandboxed content frame
    // has no scripts, so the click escapes as a popup to our relay, which
    // hands the URL (+ originating account) up the opener chain and closes.
    // App schemes (mailto/openpgp4fpr/dcaccount/dclogin/i.delta.chat) reach
    // the invite/mailto flow bound to that account (#3); http(s) links reach
    // the safe-link path so they get tracking-param stripping like a pasted
    // link (#4). Absolute URL: a relative one can't resolve against the
    // content doc's blob: base (the popup strands on about:blank). rel=opener
    // is REQUIRED: browsers imply noopener on target=_blank, and the relay
    // (a same-origin page we control) needs window.opener to find the app.
    node.setAttribute('href', relayHref(href))
    node.removeAttribute('xlink:href')
    node.setAttribute('target', '_blank')
    node.setAttribute('rel', 'opener')
  } else if (/^tel:/i.test(href)) {
    // dialer link: open directly (no tracking/punycode concern, no app flow)
    node.setAttribute('target', '_blank')
    node.setAttribute('rel', 'noopener noreferrer')
  } else if (!href.startsWith('#')) {
    // '#fragment' stays for in-document jumps; everything else would resolve
    // against the blob: base into a dead navigation — drop it, keep the text
    node.removeAttribute('href')
    node.removeAttribute('xlink:href')
  }
})

/** Sanitize once, returning the email as a mutable document (head + body kept
 * so <head><style> from real-world mail survives). */
function sanitize(content: string): HTMLElement {
  return DOMPurify.sanitize(content, {
    WHOLE_DOCUMENT: true,
    RETURN_DOM: true,
    ALLOWED_URI_REGEXP,
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

let currentBlobUrl: string | undefined // survives re-init so the old email's blob is revoked

function init(payload: HtmlEmailInit): void {
  currentAccountId = payload.accountId // tag relayed links before we sanitize (#3)
  const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
  document.title = `${payload.subject} – ${payload.from}`
  $('subject').textContent = payload.subject
  $('from').textContent = payload.from
  $('date').textContent = payload.sentTime
  $('remote-caption').textContent = payload.labels.loadRemoteImages

  const host = $('frame-host')
  host.replaceChildren() // drop previous email / the initial loading hint
  const sanitized = sanitize(payload.content)
  const render = (remote: boolean) => {
    if (currentBlobUrl) URL.revokeObjectURL(currentBlobUrl)
    currentBlobUrl = URL.createObjectURL(
      new Blob([buildContentDoc(sanitized, remote)], { type: 'text/html' })
    )
    const frame = document.createElement('iframe')
    // NO allow-scripts, NO allow-same-origin — see layer 1 in the header
    frame.setAttribute('sandbox', 'allow-popups allow-popups-to-escape-sandbox')
    frame.setAttribute('referrerpolicy', 'no-referrer')
    frame.title = 'email content'
    frame.src = currentBlobUrl
    host.replaceChildren(frame)
  }

  // the never/once/always control exists twice — exposed <select> (desktop
  // widths) and ⋮ popover menu (mobile); one state, both surfaces synced
  const states: RemoteState[] = payload.isContactRequest ? ['never', 'once'] : ['never', 'once', 'always']
  let current: RemoteState = payload.alwaysLoadRemote && !payload.isContactRequest ? 'always' : 'never'
  const select = $<HTMLSelectElement>('remote-select')
  const menu = $('menu')
  const syncControls = () => {
    select.value = current
    for (const b of menu.querySelectorAll('button')) {
      b.textContent = `${(b.dataset.state as RemoteState) === current ? '✓ ' : ' '}${payload.labels[b.dataset.state as RemoteState]}`
    }
  }
  const setState = (state: RemoteState) => {
    current = state
    if (!payload.isContactRequest) payload.onSetAlwaysLoad(state === 'always')
    syncControls()
    render(state !== 'never')
  }
  select.replaceChildren(
    ...states.map(state => {
      const option = document.createElement('option')
      option.value = state
      option.textContent = payload.labels[state]
      return option
    })
  )
  select.onchange = () => setState(select.value as RemoteState)
  $('remote').title = payload.labels.ask
  menu.replaceChildren(
    Object.assign(document.createElement('div'), {
      className: 'caption',
      textContent: payload.labels.loadRemoteImages,
    }),
    ...states.map(state => {
      const b = document.createElement('button')
      b.dataset.state = state
      b.onclick = () => {
        menu.hidePopover?.()
        setState(state)
      }
      return b
    })
  )
  const menuBtn = $<HTMLButtonElement>('menu-btn')
  if (typeof (menu as { togglePopover?: unknown }).togglePopover !== 'function') {
    // pre-popover-API browsers: emulate open/close with the hidden attribute
    menu.setAttribute('hidden', '')
    menuBtn.onclick = () =>
      menu.hasAttribute('hidden') ? menu.removeAttribute('hidden') : menu.setAttribute('hidden', '')
  }

  $('close').setAttribute('aria-label', payload.labels.close)
  $('close').onclick = $('back').onclick = payload.onClose
  window.onkeydown = e => {
    if (e.key === 'Escape') payload.onClose()
  }

  syncControls()
  render(current !== 'never')
}

;(window as any).__initHtmlEmail = init

// App-link plumbing. Two roles for this same page:
//
// Relay tab (`html-email.html#open=<url>`): opened by an app-link click
// inside the sandboxed content frame (which has no scripts, so a popup
// navigation is its only way out — and popups escape the sandbox as normal
// same-origin pages). Hand the URL up the opener chain and close. opener is
// the opaque-origin content frame; `.top` is on the cross-origin-allowed
// property list and resolves to the viewer host (dialog: the app itself,
// popup viewer: the wrapper window, which forwards below).
//
// Forwarder: when this page is the viewer, pass a relayed URL on to whoever
// hosts it — window.opener when it's a popup window, window.parent when it's
// the dialog iframe. The chain terminates at the app window, where runtime.ts
// installs the real handler (which re-validates the URL).
;(window as any).__slothfulOpenAppLink = (url: string, accountId?: number) => {
  const host: any = window.opener ?? (window.parent !== window ? window.parent : undefined)
  host?.__slothfulOpenAppLink?.(url, accountId)
}
// `#open=<enc-url>&acct=<id>` — the encoded URL never contains a raw '&'
// (encodeURIComponent escapes it), so [^&]* captures it whole; acct is the
// originating account (#3), optional for backward safety.
const openMatch = /^#open=([^&]*)(?:&acct=(\d+))?$/.exec(location.hash)
if (openMatch) {
  const acct = openMatch[2] ? Number(openMatch[2]) : undefined
  try {
    ;(window.opener?.top as any)?.__slothfulOpenAppLink?.(decodeURIComponent(openMatch[1]), acct)
  } catch {
    // opener gone or cross-origin (page opened outside the viewer): nothing to do
  }
  window.close()
}
