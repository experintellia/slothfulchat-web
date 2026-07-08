// Catches errors before/while the ES-module bundles boot and replaces the
// blank page with a "browser not supported" screen showing the actual error.
// Loaded first in main.html; must stay conservative ES5 so it parses on
// exactly the browsers whose parsers choke on the esnext bundles.
(function () {
  'use strict'
  // rewritten by instance-config.mjs patchBootError (assemble + customize);
  // config.js may not have loaded yet when these screens render
  var APP_NAME = 'SlothfulChat'
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

  // Renders the error screen shell (once) with the given lead paragraph and
  // sets `pre` for detail lines. Returns false if the app already mounted.
  function show(lead) {
    var root = document.getElementById('root')
    if (!root) return false
    if (pre) return true
    // app already mounted -> not a boot failure, leave the app alone
    if (root.firstElementChild) return false
    root.innerHTML =
      '<div style="font:16px/1.5 system-ui,sans-serif;max-width:40rem;margin:3rem auto;padding:0 1.25rem">' +
      '<h1 style="font-size:1.3rem"></h1>' +
      '<p></p>' +
      '<p>Details for a bug report:</p>' +
      '<pre style="white-space:pre-wrap;word-break:break-word;background:#f4f4f4;padding:0.75rem;border-radius:4px;font-size:12px"></pre>' +
      '<button style="font:inherit;padding:0.4rem 1rem">Copy error details</button>' +
      '</div>'
    // textNodes, not innerHTML: APP_NAME needs no HTML escaping this way
    root.getElementsByTagName('h1')[0].appendChild(
      document.createTextNode(APP_NAME + ' could not start')
    )
    root.getElementsByTagName('p')[0].appendChild(document.createTextNode(lead))
    pre = root.getElementsByTagName('pre')[0]
    var btn = root.getElementsByTagName('button')[0]
    btn.onclick = function () {
      var text = pre.textContent
      function done() {
        btn.textContent = 'Copied'
      }
      function fallback() {
        var range = document.createRange()
        range.selectNodeContents(pre)
        var sel = window.getSelection()
        sel.removeAllRanges()
        sel.addRange(range)
        try {
          if (document.execCommand('copy')) done()
        } catch (e) {}
      }
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(done, fallback)
      } else {
        fallback()
      }
    }
    return true
  }

  function handle(event) {
    if (
      show(
        'Your browser may be too old or not supported (for example older ' +
          'iOS Safari). Please try a recent version of Chrome, Firefox or Safari.'
      )
    ) {
      pre.appendChild(document.createTextNode(describe(event) + '\n\n'))
    }
  }

  // capture phase: window-level errors (module parse/eval failures) AND
  // non-bubbling error events from <script>/<link> elements
  window.addEventListener('error', handle, true)
  window.addEventListener('unhandledrejection', handle)

  // Blocked browser storage (Safari "Block All Cookies", Firefox cookie
  // exceptions) makes any localStorage access throw a SecurityError, and the
  // same setting blocks the OPFS the core needs — the app cannot run. Probe
  // here, before the bundles crash on it, and say what to actually fix
  // instead of "browser too old".
  try {
    void localStorage.length
  } catch (e) {
    show(
      APP_NAME + ' needs to store data in your browser, but your browser ' +
        'is blocking it. Please allow cookies/site data for ' +
        location.hostname +
        ' and reload — on iPhone/iPad, turn off Settings → Safari ' +
        '→ Advanced → Block All Cookies.'
    )
    if (pre) pre.appendChild(document.createTextNode(String(e) + '\n\n'))
  }
})()
