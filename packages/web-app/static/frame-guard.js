// Clickjacking guard: refuse to render when a FOREIGN origin frames one of our
// pages. Loaded first-ish in <head> — before the stylesheets and before the
// body — so a refusal happens with nothing painted and nothing else fetched.
//
// DEFENCE IN DEPTH, not a substitute for response headers. The real protection
// is `Content-Security-Policy: frame-ancestors` + `X-Frame-Options`, which only
// a server can send: a <meta> CSP cannot express frame-ancestors at all (the
// directive is ignored there by spec). caddy/routes.caddy sends them, so
// self-hosters behind a real webserver are covered by the headers and this
// script never fires. GitHub Pages — which serves the flagship — cannot send
// arbitrary headers, and that deployment has nothing else (see SELFHOSTING.md).
// A page-level check is weaker: it needs script to run, and a browser that
// honours neither the headers nor this is defenceless either way. It costs one
// small file and closes the ordinary case.
//
// Which documents load this: the ones that must never be framed by a stranger
// (main.html/index.html, call-popup.html) AND html-email.html, which the app
// legitimately frames SAME-ORIGIN on phones/PWAs (ensureHtmlEmailDialog in
// src/runtime.ts) — hence the parent-origin test rather than a flat "am I
// framed". Deliberately NOT loaded by webxdc documents: a webxdc app is MEANT
// to be framed by the app (WEBXDC.md), and it runs on its own origin anyway.
;(function () {
  // Testing the PARENT, not window.top, is what makes this correct when the
  // app frames a webxdc app (foreign origin) which then frames one of our
  // pages: top would be us and look fine, the parent is the giveaway. Nothing
  // of ours is ever framed by a same-origin page other than the app itself, so
  // "parent is us" is exactly the legitimate case.
  // Reading a cross-origin location throws — that IS the signal. Anything else
  // going wrong leaves the page alone: a broken guard must not brick the app.
  try {
    if (window.parent.location.origin === window.location.origin) return
  } catch (e) {}
  // Abort the parse and every pending fetch (no stylesheets, no bundle, no
  // wasm), then replace the document with plain text: nothing clickable
  // remains, so there is nothing to trick the user into clicking.
  window.stop()
  document.documentElement.textContent =
    'Refused to load: this page is embedded in another site. Open it directly instead.'
})()
