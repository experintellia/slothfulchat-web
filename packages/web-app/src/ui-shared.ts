/**
 * Tiny DOM helpers and the one stylesheet shared by our own overlays — the
 * fatal-start, bridge, throwaway and webxdc dialogs, the bridge toast, the
 * consent info dialog and the diagnostics panel. These are plain DOM, not
 * React, mounted by runtime.ts, so they need no upstream frontend patch.
 *
 * Styling is self-contained (a <style> we inject, not a file the app fetches
 * and not the theme's own) for two reasons: these overlays must look the same
 * whichever theme is loaded, and the fatal-start dialog has to render when
 * nothing else in the app works — the stylesheet ships inside the same bundle
 * as the code that opens it, so there is no second request to fail.
 */
import { trackLink } from './analytics'

// self-hosting guide, for the "run your own private instance" link in the notice
export const SELFHOSTING_URL =
  'https://github.com/experintellia/slothfulchat-web/blob/main/SELFHOSTING.md'

/**
 * Minimal createElement: tag, class name or inline style, text/children.
 *
 * A string is a class name, for anything OVERLAY_CSS below already styles. An
 * object is an inline style, for the one-offs that no rule covers: it is an
 * object rather than a CSS string so tsc checks the property names — a typo in
 * a string ("colour", "margin-botom") is silently dropped by the CSSOM and
 * shows up as a layout bug instead of a compile error.
 */
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  style: Partial<CSSStyleDeclaration> | string = {},
  content?: string | Node | (string | Node)[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (typeof style === 'string') node.className = style
  else Object.assign(node.style, style)
  if (content != null) {
    for (const c of Array.isArray(content) ? content : [content]) {
      node.append(typeof c === 'string' ? document.createTextNode(c) : c)
    }
  }
  return node
}

/**
 * Every overlay we mount ourselves, in one place. Written as classes rather
 * than the inline-style objects this used to be: the five dialogs repeated the
 * same scrim, card, title, body, footer row and button declarations, and the
 * bridge dialog needed a JS restyle pass on every click because inline styles
 * cannot express `:hover` or "the selected card looks different".
 */
const OVERLAY_CSS = `
.sc-ov{position:fixed;inset:0;width:100%;height:100%;max-width:none;max-height:none;
 margin:0;padding:0;border:none;display:flex;align-items:center;justify-content:center;
 background:rgba(0,0,0,.5)}
.sc-card{box-sizing:border-box;width:min(400px,92vw);max-height:90vh;overflow-y:auto;
 padding:20px;border-radius:10px;background:#1e1e1e;color:#eee;
 font:14px/1.5 system-ui,sans-serif;box-shadow:0 8px 40px rgba(0,0,0,.5)}
.sc-card.sc-wide{width:min(460px,92vw)}
.sc-card>h2{margin:0 0 8px;font-size:17px}
.sc-card>p{margin:0 0 10px;color:#bbb}
.sc-card>.sc-note{margin:0;font-size:12px;color:#a8a8a8}
.sc-row{display:flex;flex-wrap:wrap;gap:8px;justify-content:flex-end;margin-top:16px}
.sc-btn{padding:8px 14px;border:none;border-radius:6px;background:#333;color:#fff;
 font-size:13px;cursor:pointer}
.sc-btn.sc-primary{background:#2d7dff}
/* a link wearing the button look (the fatal dialog's "Report this"); scoped to
   a[] so the real <button>s keep their UA text layout */
a.sc-btn{display:inline-flex;align-items:center;text-decoration:none}
.sc-btn-ghost{padding:6px 12px;border:1px solid #444;border-radius:6px;background:transparent;
 color:#ddd;font-size:13px;cursor:pointer}
.sc-report{margin:0 0 8px;padding:8px 10px;border-radius:6px;background:#141414;color:#bbb;
 font:12px/1.45 ui-monospace,monospace;white-space:pre-wrap;word-break:break-word;
 max-height:30vh;overflow-y:auto;user-select:text}
.sc-url{margin:0 0 10px;padding:8px 10px;border-radius:6px;background:#161616;color:#9cdcfe;
 white-space:pre-wrap;word-break:break-all;font-size:12px}
.sc-link{color:#4ea1ff;font-size:13px}
.sc-linkbtn{background:none;border:none;padding:0;font:inherit;color:#6aa9ff;
 text-decoration:underline;cursor:pointer}
.sc-analytics-note{margin:16px 0 0;padding-top:12px;border-top:1px solid #333;color:#888;
 font-size:12px}
.sc-details{margin:0 0 12px;font-size:12px;color:#bbb}
.sc-details summary{cursor:pointer}
.sc-details p{margin:6px 0 0}
.sc-toast,.sc-hint{background:#8a5a00;color:#fff;font:13px/1.4 system-ui,sans-serif;
 border:none;cursor:pointer}
/* inset/margin are set back explicitly: the toast joins the top layer as a
   popover, and the UA's [popover] rules centre it otherwise */
.sc-toast{position:fixed;inset:auto;bottom:16px;right:16px;margin:0;z-index:2147483647;
 max-width:320px;padding:10px 14px;border-radius:8px;box-shadow:0 2px 12px rgba(0,0,0,.35)}
.sc-hint{display:block;width:100%;margin-bottom:8px;padding:10px 14px;border-radius:8px;
 text-align:center}
.sc-opts{display:flex;flex-direction:column;gap:8px}
.sc-opt{display:flex;align-items:flex-start;padding:10px 12px;border:1px solid #3a3a3a;
 border-radius:8px;background:#262626;cursor:pointer;
 transition:border-color .15s,background-color .15s}
.sc-opt:hover{border-color:#5a5a5a}
.sc-opt:has(input:checked){border-color:#2d7dff;background:rgba(45,125,255,.12)}
.sc-opt input[type=radio]{flex-shrink:0;margin:2px 10px 0 0;width:16px;height:16px;
 accent-color:#2d7dff}
.sc-opt-col{flex:1;min-width:0}
.sc-opt-url{font-family:ui-monospace,monospace;font-size:13px;word-break:break-all;
 color:#e8e8e8}
.sc-opt-desc{margin-top:2px;font-size:12px;color:#a8a8a8}
.sc-cmd{display:flex;align-items:center;justify-content:space-between;gap:8px;margin:8px 0 6px;
 padding:6px 6px 6px 10px;border-radius:6px;background:#161616;color:#9cdcfe;
 white-space:pre-wrap;font-size:12px}
.sc-cmd button{flex-shrink:0;padding:3px 8px;border:1px solid #444;border-radius:4px;
 background:#2a2a2a;color:#ccc;font:11px system-ui,sans-serif;cursor:pointer}
.sc-input{box-sizing:border-box;width:100%;margin-top:6px;padding:8px 10px;
 border:1px solid #444;border-radius:6px;background:#161616;color:#eee;font-size:13px}
.sc-input.sc-invalid{border-color:#e33}
`

// On import rather than before each overlay: this module is only ever pulled
// into the page bundle (runtime.ts, consent.ts, diagnostics.ts), the module
// script is deferred so <head> is there, and the fatal-start dialog is then
// styled from the moment runtime.js parses rather than from its first call.
const overlayStyle = el('style', {}, OVERLAY_CSS)
overlayStyle.id = 'sc-overlay-css'
document.head.append(overlayStyle)

/**
 * The shape all of our dialogs share: a native <dialog> scrim covering the
 * viewport with a card centred in it. <dialog> rather than a div because
 * upstream's own dialogs are modal and live in the browser top layer, which
 * paints over any z-index; opening ours last puts it above them.
 *
 * Returns both — the caller fills the card and shows the dialog (showOnTop).
 */
export function overlayCard(
  id: string,
  wide = false
): [HTMLDialogElement, HTMLDivElement] {
  const overlay = el('dialog', 'sc-ov')
  overlay.id = id
  const card = el('div', wide ? 'sc-card sc-wide' : 'sc-card')
  overlay.append(card)
  return [overlay, card]
}

/** Our dialogs that are currently open, oldest first — see showOnTop(). */
const onTop = new Set<HTMLDialogElement>()

/**
 * showModal(), and stay on top.
 *
 * "Opening ours last" only holds if nothing else opens a modal afterwards. The
 * top layer is ordered by showModal() call order and never re-sorts, so one of
 * ours opened while the app is still booting is buried the moment the frontend
 * shows its own modal (the welcome screen; a Dialog.tsx anything) — visible,
 * dimmed and completely inert, with no way to reach its buttons and no Esc
 * either, because Esc goes to the topmost dialog (#247). Whether that happens
 * is a start-up race: it decided the bridge picker's fate by fractions of a
 * second.
 *
 * The platform fires no event for "someone opened a modal", so the hook goes on
 * showModal itself, and ours re-assert their place after any foreign one. They
 * re-raise in the order they were registered, so a later one (the fatal-error
 * dialog) still ends up above an earlier one (the bridge picker).
 *
 * ponytail: re-inserting the element is what actually moves a dialog back to
 * the top of the top layer without side effects — close()+showModal() works too
 * but fires `close`, which our callers use to drop the dialog for good. Node
 * moves keep listeners, radio state and typed input values; only focus needs
 * restoring, since showModal() re-focuses the first focusable child.
 */
export function showOnTop(overlay: HTMLDialogElement): void {
  hookShowModal()
  onTop.add(overlay)
  overlay.addEventListener('close', () => onTop.delete(overlay))
  overlay.showModal()
}

let nativeShowModal: HTMLDialogElement['showModal'] | undefined
function hookShowModal(): void {
  if (nativeShowModal) return
  nativeShowModal = HTMLDialogElement.prototype.showModal
  HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
    // read before the new dialog takes the focus for itself
    const focused = document.activeElement as HTMLElement | null
    nativeShowModal!.call(this)
    if (onTop.has(this)) return // one of ours: it opened last, it is on top
    // Everything below runs inside someone else's showModal() call — the
    // frontend's own dialogs must open even if re-raising ours goes wrong.
    try {
      for (const ov of onTop) {
        const parent = ov.parentNode
        if (!parent || !ov.open) {
          onTop.delete(ov) // dropped from the DOM without close()
          continue
        }
        ov.remove()
        ov.removeAttribute('open') // remove() alone leaves it "open" but hidden
        parent.appendChild(ov)
        nativeShowModal!.call(ov)
        if (focused && ov.contains(focused)) focused.focus() // e.g. mid-typing
      }
    } catch (err) {
      console.error('failed to re-raise our dialog', err)
    }
  }
}

/** A footer button. `primary` is the accented one (at most one per row). */
export const scButton = (text: string, primary = false): HTMLButtonElement =>
  el('button', primary ? 'sc-btn sc-primary' : 'sc-btn', text)

export function linkTo(href: string, text: string): HTMLAnchorElement {
  const a = el('a', { color: '#2c8a68' }, text)
  a.href = href
  a.target = '_blank'
  a.rel = 'noopener'
  // our overlay anchors navigate directly (not via runtime.openLink), so count
  // the tracked ones here too
  a.addEventListener('click', () => trackLink(href))
  return a
}
