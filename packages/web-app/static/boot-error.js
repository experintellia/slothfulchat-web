// Catches errors before/while the ES-module bundles boot and replaces the
// blank page with a "browser not supported" screen showing the actual error.
// Loaded first in main.html; must stay conservative ES5 so it parses on
// exactly the browsers whose parsers choke on the esnext bundles.
(function () {
  'use strict'
  var pre = null

  function describe(event) {
    // capture-phase resource load failure (script/css fetch failed):
    // no message, but the target has a src/href
    var t = event.target
    if (!event.message && t && t !== window && (t.src || t.href)) {
      return 'failed to load ' + (t.src || t.href)
    }
    var text = event.message || ''
    if (event.filename) {
      text += '\n  at ' + event.filename + ':' + event.lineno + ':' + event.colno
    }
    var err = event.error || event.reason
    if (err) {
      var stack = String(err.stack || err)
      // skip stacks that add nothing over event.message (e.g. bare SyntaxError)
      if (text.indexOf(stack) === -1) text += '\n' + stack
    }
    return text || 'unknown error'
  }

  function handle(event) {
    var root = document.getElementById('root')
    if (!root) return
    if (!pre) {
      // app already mounted -> not a boot failure, leave the app alone
      if (root.firstElementChild) return
      root.innerHTML =
        '<div style="font:16px/1.5 system-ui,sans-serif;max-width:40rem;margin:3rem auto;padding:0 1.25rem">' +
        '<h1 style="font-size:1.3rem">SlothfulChat could not start</h1>' +
        '<p>Your browser may be too old or not supported (for example older ' +
        'iOS Safari). Please try a recent version of Chrome, Firefox or Safari.</p>' +
        '<p>Details for a bug report:</p>' +
        '<pre style="white-space:pre-wrap;word-break:break-word;background:#f4f4f4;padding:0.75rem;border-radius:4px;font-size:12px"></pre>' +
        '</div>'
      pre = root.getElementsByTagName('pre')[0]
    }
    pre.appendChild(document.createTextNode(describe(event) + '\n\n'))
  }

  // capture phase: window-level errors (module parse/eval failures) AND
  // non-bubbling error events from <script>/<link> elements
  window.addEventListener('error', handle, true)
  window.addEventListener('unhandledrejection', handle)
})()
