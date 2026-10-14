/**
 * The first script of every document on a webxdc origin (webxdc-sw.ts
 * inlines it at the top of each HTML page it serves; the bootstrap page runs
 * it too). It takes WebRTC away from the app: peer connections
 * don't go through Fetch, so no CSP directive the browsers implement reaches
 * them (`webrtc 'block'` is sent, and ignored — Chromium 141), and one STUN
 * or TURN request carries whatever the app put in it.
 *
 * The constructors go from the app's window and from every frame the app
 * makes, the moment each one exists: every document a frame loads brings
 * pristine globals (even where Chrome keeps the window object), so the frame's
 * load event (in the capture phase, ahead of any handler the app set on the
 * frame) and every way of inserting or reaching into one (insertion methods,
 * contentWindow/contentDocument) guard it first, recursively.
 *
 * ponytail: a speed bump, not a wall. This runs in the app's own realm, and
 * an app that polls a frame between its new document's commit and its load
 * event (`window[0]` can't be intercepted) can still take a pristine
 * constructor. It stops apps and libraries that use WebRTC the ordinary way;
 * closing it for good needs the browser (WEBXDC.md, "Known gaps").
 *
 * Self-contained: shipped as source text (guardSource). Checked by
 * scripts/test-webxdc-host.mjs.
 */
export function webxdcGuard(top: any): void {
  const MARK = Symbol('webxdc-guard')
  const guard = (w: any) => {
    try {
      // every time: a frame's first document after its initial about:blank
      // keeps the same window object, with the built-ins installed afresh
      for (const k of ['RTCPeerConnection', 'webkitRTCPeerConnection']) delete w[k]
      // and the rest once per realm — whose built-ins are fresh objects
      if (w.Node.prototype[MARK]) return
      w.Node.prototype[MARK] = true
      const sweep = () => {
        for (let i = 0; i < w.length; i++) guard(w[i])
      }
      const after = (proto: any, names: string[]) => {
        for (const n of names) {
          const f = proto?.[n]
          if (typeof f === 'function') {
            proto[n] = function (this: any, ...a: unknown[]) {
              try {
                return f.apply(this, a)
              } finally {
                // document.open() erases the document's listeners, ours too
                if (n === 'open') this.addEventListener('load', sweep, true)
                sweep()
              }
            }
          }
        }
      }
      const accessor = (proto: any, name: string, kind: 'get' | 'set') => {
        const d = proto && Object.getOwnPropertyDescriptor(proto, name)
        if (!d?.[kind]) return
        Object.defineProperty(proto, name, {
          ...d,
          [kind](this: unknown, v?: unknown) {
            if (kind === 'get') return sweep(), d.get!.call(this)
            try {
              d.set!.call(this, v)
            } finally {
              sweep()
            }
          },
        })
      }
      after(w.Node.prototype, ['appendChild', 'insertBefore', 'replaceChild', 'moveBefore'])
      after(w.Element.prototype, [
        'append', 'prepend', 'after', 'before', 'replaceWith', 'replaceChildren',
        'insertAdjacentElement', 'insertAdjacentHTML', 'setHTMLUnsafe',
      ])
      after(w.CharacterData.prototype, ['after', 'before', 'replaceWith'])
      after(w.Document.prototype, ['append', 'prepend', 'replaceChildren', 'write', 'writeln', 'execCommand', 'open'])
      after(w.Range.prototype, ['insertNode', 'surroundContents'])
      after(w.ShadowRoot?.prototype, ['setHTMLUnsafe'])
      accessor(w.Element.prototype, 'innerHTML', 'set')
      accessor(w.Element.prototype, 'outerHTML', 'set')
      accessor(w.ShadowRoot?.prototype, 'innerHTML', 'set')
      for (const c of ['HTMLIFrameElement', 'HTMLFrameElement', 'HTMLObjectElement', 'HTMLEmbedElement']) {
        accessor(w[c]?.prototype, 'contentWindow', 'get')
        accessor(w[c]?.prototype, 'contentDocument', 'get')
      }
      // every frame's load — capture phase, so ahead of the app's handlers;
      // on the document: a load aimed at an element never reaches the window
      w.document.addEventListener('load', sweep, true)
    } catch {}
  }
  guard(top)
}

/** The guard as script text, for webxdc-sw.ts to inline. */
export const guardSource = () => `;(${webxdcGuard.toString()})(window);\n`
