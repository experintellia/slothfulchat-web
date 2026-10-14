// Security check for the webxdc ORIGIN side (WEBXDC.md): the bootstrap page +
// service worker every <slug>.webxdc.<app-host> serves (packages/web-app
// src/webxdc-host.ts, src/webxdc-sw.ts). Fully offline, no core boot: the
// parent is a stand-in page on the app origin that drives the bootstrap page
// with the same two commands the app's src/webxdc.ts sends — so this pins the
// contract on the origin side and attacks it from inside the app:
//
//   1. open: the posted files are served by the SW, at odd paths too
//   2. every response — 404s, and entries the APP wrote into the cache
//      without headers — carries the app CSP (Electron audit XDC-01-002 class)
//   3. that CSP keeps fetch() off every other origin, and nested frames on
//      this one
//   4. two slugs are two origins: storage of one is invisible to the other
//   5. top-level navigation to an app page is refused; the bootstrap page
//      opened top-level does nothing
//   6. a foreign page cannot frame the bootstrap page (frame-ancestors)
//   7. wipe empties localStorage, IndexedDB, the Cache API and the SW
//
// The webxdc origins are http://<slug>.webxdc.localhost:<port>, which
// serve.mjs answers itself (no Caddy needed).
// Requires packages/web-app assembled+built.
// Run:  node scripts/test-webxdc-host.mjs
import { chromium } from 'playwright'
import { startServers } from './harness.mjs'

const PORT = Number(process.env.APP_PORT ?? 8683)
const APP = `http://localhost:${PORT}`
const xdc = slug => `http://${slug}.webxdc.localhost:${PORT}`

const { cleanup, watchdog } = await startServers({ app: PORT, settleMs: 500, watchdogMs: 120_000 })

// The stand-in parent: what src/webxdc.ts does, minus the chat. Injected into
// a plain page of the app origin (serve.mjs's 404 page: no CSP of its own).
// Not a context.route()-fulfilled document — Playwright then stalls the
// cross-origin subframe's requests.
const PARENT = `
const wait = (frame, origin, type) => new Promise((ok, ko) => {
  const t = setTimeout(() => ko(new Error('timeout waiting for ' + type)), 15000)
  addEventListener('message', function on(e) {
    if (e.source !== frame.contentWindow || e.origin !== origin) return
    if (e.data?.type === type) { clearTimeout(t); removeEventListener('message', on); ok() }
    if (e.data?.type === 'error') { clearTimeout(t); ko(new Error(e.data.message)) }
  })
})
const frameOf = (origin, id) => {
  const f = document.createElement('iframe')
  f.id = id
  f.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms')
  f.src = origin + '/webxdc-host.html'
  document.body.append(f)
  return f
}
window.openApp = async (origin, files, entry) => {
  const f = frameOf(origin, 'app-' + new URL(origin).hostname.split('.')[0])
  await wait(f, origin, 'hello')
  const loaded = new Promise(r => f.addEventListener('load', r, { once: true }))
  const enc = new TextEncoder()
  const list = Object.entries(files).map(([n, t]) => [n, enc.encode(t).buffer])
  f.contentWindow.postMessage({ type: 'open', files: list, entry }, origin, list.map(x => x[1]))
  await loaded
}
window.wipeApp = async origin => {
  const f = frameOf(origin, 'wipe')
  await wait(f, origin, 'hello')
  const done = wait(f, origin, 'wiped')
  f.contentWindow.postMessage({ type: 'wipe' }, origin)
  await done
  f.remove()
}
`

const launchOpts = {
  args: ['--host-resolver-rules=MAP *.localhost 127.0.0.1'],
  ...(process.env.CHROMIUM_BIN ? { executablePath: process.env.CHROMIUM_BIN } : {}),
}
const browser = await chromium.launch(launchOpts)
const context = await browser.newContext()
const page = await context.newPage()
page.on('pageerror', e => console.error('[pageerror]', e.message))

let failed = 0
const check = (ok, name) => {
  console.log(`${ok ? 'ok' : 'FAIL'} - ${name}`)
  if (!ok) failed++
}
const frameFor = slug => page.frames().find(f => f.url().startsWith(xdc(slug)))

const APP_FILES = {
  'index.html': '<!doctype html><meta charset=utf-8><title>t</title><p id=hi>hello from the app</p>',
  'img dir/a b#c.txt': 'odd path',
  'sub/index.html': 'sub index',
}

try {
  await page.goto(`${APP}/__parent`)
  await page.evaluate(PARENT)

  // 1. open + serve
  await page.evaluate(([o, f]) => window.openApp(o, f, '/index.html'), [xdc('aaa1'), APP_FILES])
  const a = frameFor('aaa1')
  check((await a.textContent('#hi')) === 'hello from the app', 'app index.html is served by the SW')
  const get = (f, path) =>
    f.evaluate(async p => {
      const r = await fetch(p)
      return { status: r.status, csp: r.headers.get('content-security-policy'), type: r.headers.get('content-type'), body: await r.text() }
    }, path)
  const odd = await get(a, '/img%20dir/a%20b%23c.txt')
  check(odd.status === 200 && odd.body === 'odd path', 'a zip name with space and # is reachable')
  // (every page starts with the guard, webxdc-guard.ts)
  const sub = (await get(a, '/sub/')).body
  check(sub.endsWith('sub index') && sub.startsWith('<script>;(function webxdcGuard'), 'a directory URL serves its index.html, the guard first')
  // media in Safari needs byte ranges
  const ranged = await a.evaluate(async () => {
    const r = await fetch('/img%20dir/a%20b%23c.txt', { headers: { range: 'bytes=1-3' } })
    const tail = await fetch('/img%20dir/a%20b%23c.txt', { headers: { range: 'bytes=-4' } })
    return [r.status, r.headers.get('content-range'), await r.text(), await tail.text(), r.headers.get('content-security-policy')]
  })
  check(
    ranged[0] === 206 && ranged[1] === 'bytes 1-3/8' && ranged[2] === 'dd ' && ranged[3] === 'path' && /default-src/.test(ranged[4]),
    `a byte range gets 206 with the CSP (${JSON.stringify(ranged.slice(0, 4))})`
  )

  // 1b. no WebRTC (webxdc-guard.ts): not in the page, not in any frame it makes
  const rtc = await a.evaluate(async () => {
    const t = w => {
      try {
        return typeof w.RTCPeerConnection + '/' + typeof w.webkitRTCPeerConnection
      } catch {
        return 'unreachable'
      }
    }
    const frame = () => document.body.appendChild(document.createElement('iframe'))
    const loaded = f => new Promise(r => f.addEventListener('load', r, { once: true }))
    const out = { page: t(window) }
    // inserted, then reached into at once
    const f1 = frame()
    out.inserted = t(window[window.length - 1])
    // the synchronous about:blank load event, the app's own handler
    const f2 = document.createElement('iframe')
    f2.onload = () => (out.onload ??= t(f2.contentWindow && window[window.length - 1]))
    document.body.appendChild(f2)
    // srcdoc: a document of its own, with its own scripts
    out.srcdoc = await new Promise(r => {
      addEventListener('message', e => e.data?.srcdoc && r(e.data.srcdoc), { once: true })
      document.body.insertAdjacentHTML('beforeend', '<iframe srcdoc="<script>parent.postMessage({srcdoc: typeof RTCPeerConnection}, \'*\')</script>"></iframe>')
      setTimeout(() => r('no answer'), 3000)
    })
    // a frame sent elsewhere gets a new window
    f1.src = 'about:blank'
    await loaded(f1)
    out.renavigated = t(window[0])
    // a grandchild, made with the child's own DOM methods
    const c = window[0]
    c.document.body.appendChild(c.document.createElement('iframe'))
    out.grandchild = t(c[0])
    // a file that isn't HTML, shown as a page: refused (a network error)
    const f3 = frame()
    f3.src = '/img%20dir/a%20b%23c.txt'
    await loaded(f3)
    out.textPage = t(window[window.length - 1])
    // our own bootstrap page in a frame
    const f4 = frame()
    f4.src = '/webxdc-host.html'
    await loaded(f4)
    out.bootstrap = t(window[window.length - 1])
    // the race the guard can't win: polling a frame between commit and load
    const f5 = frame()
    let raced = 'lost'
    const poll = setInterval(() => {
      try {
        if (typeof window[window.length - 1].RTCPeerConnection === 'function') raced = 'won'
      } catch {}
    }, 0)
    f5.src = '/sub/?race'
    await loaded(f5)
    await new Promise(r => setTimeout(r, 50))
    clearInterval(poll)
    out.race = raced
    // and a blank page, which no service worker serves and nothing guards from inside
    let racedBlank = 'lost'
    const poll2 = setInterval(() => {
      try {
        if (typeof window[window.length - 1].RTCPeerConnection === 'function') racedBlank = 'won'
      } catch {}
    }, 0)
    f5.src = 'about:blank'
    await loaded(f5)
    await new Promise(r => setTimeout(r, 50))
    clearInterval(poll2)
    out.raceBlank = racedBlank
    return out
  })
  const none = 'undefined/undefined'
  check(rtc.page === none, 'no WebRTC in an app page')
  check(rtc.inserted === none, 'nor in a frame it inserts and reaches into at once')
  check(rtc.onload === none, 'nor in its synchronous load event')
  check(rtc.srcdoc === 'undefined', `nor for a srcdoc frame's own scripts (${rtc.srcdoc})`)
  check(rtc.renavigated === none, 'nor in a frame sent to a new document')
  check(rtc.grandchild === none, 'nor in a frame made with a child frame\'s DOM methods')
  check(rtc.textPage === 'unreachable', `a non-HTML file shown as a page is refused (${rtc.textPage})`)
  // (frame-ancestors admits the chat app only, so an app can't frame it at all)
  check(rtc.bootstrap === none || rtc.bootstrap === 'unreachable', `nor in the bootstrap page in a frame (${rtc.bootstrap})`)
  console.log(`info - polling a frame while it loads a page of the app: ${rtc.race === 'won' ? 'DOES get a pristine RTCPeerConnection' : 'got none'}`)
  console.log(`info - polling a frame while it loads about:blank: ${rtc.raceBlank === 'won' ? 'DOES get a pristine RTCPeerConnection (the known limit)' : 'got none'}`)

  // 2. CSP on everything the origin serves
  const missing = await get(a, '/no/such/file.html')
  check(missing.status === 404 && /default-src 'self'/.test(missing.csp ?? ''), '404 carries the app CSP')
  check(/default-src 'self'/.test(odd.csp ?? '') && /form-action 'none'/.test(odd.csp ?? ''), '200 carries the app CSP')
  const forged = await a.evaluate(async () => {
    const c = await caches.open('webxdc-app')
    await c.put('/__xdc/evil.html', new Response('<script>parent.postMessage("x","*")</script>', {
      headers: { 'content-type': 'text/html' },
    }))
    const r = await fetch('/evil.html')
    return r.headers.get('content-security-policy')
  })
  check(/default-src 'self'/.test(forged ?? ''), 'a header-less entry the app wrote itself still gets the CSP')

  // 3. the CSP holds: no fetch to another origin, no foreign nested frame
  const exfil = await a.evaluate(u => fetch(u).then(() => 'reached', () => 'blocked'), `${APP}/main.html?leak`)
  check(exfil === 'blocked', 'fetch() to another origin is blocked')
  const exfil2 = await a.evaluate(
    u => new Promise(r => {
      document.addEventListener('securitypolicyviolation', e => r(e.violatedDirective), { once: true })
      const f = document.createElement('iframe')
      f.src = u
      document.body.append(f)
      setTimeout(() => r('none'), 3000)
    }),
    'https://example.invalid/?leak'
  )
  check(/frame-src|child-src|default-src/.test(exfil2), `a nested frame to a foreign origin is CSP-blocked (${exfil2})`)
  const img = await a.evaluate(u => new Promise(r => {
    const i = new Image()
    i.onload = () => r('loaded')
    i.onerror = () => r('blocked')
    i.src = u
  }), `${APP}/images/icon-256.png`)
  check(img === 'blocked', 'an image from another origin is blocked')

  // 4. isolation
  await a.evaluate(() => localStorage.setItem('secret', 'from aaa1'))
  await page.evaluate(([o, f]) => window.openApp(o, f, '/index.html'), [xdc('bbb2'), APP_FILES])
  const b = frameFor('bbb2')
  check((await b.evaluate(() => localStorage.getItem('secret'))) === null, 'another slug cannot see the first one\'s localStorage')
  check(
    (await b.evaluate(() => { try { return String(parent.document) } catch { return 'blocked' } })) === 'blocked',
    'the app cannot reach into the chat app (cross-origin parent)'
  )

  // 5. top-level use is refused
  const top = await context.newPage()
  const res = await top.goto(`${xdc('aaa1')}/index.html`)
  check(res?.status() === 403, `an app page opened top-level is refused (${res?.status()})`)
  await top.goto(`${xdc('aaa1')}/webxdc-host.html`)
  check((await top.evaluate(() => document.body?.textContent ?? '')).trim() === '', 'the bootstrap page top-level stays inert')
  await top.close()

  // 6. a foreign page cannot frame the bootstrap page
  const evil = await context.newPage()
  const blocked = new Promise(r => {
    evil.on('console', m => /frame-ancestors/.test(m.text()) && r(true))
    setTimeout(() => r(false), 5000)
  })
  await evil.goto(`http://evil.localhost:${PORT}/__parent`)
  await evil.evaluate(o => {
    const f = document.createElement('iframe')
    f.src = o + '/webxdc-host.html'
    document.body.append(f)
  }, xdc('aaa1'))
  check(await blocked, 'a foreign origin is refused by frame-ancestors')
  await evil.close()

  // 7. wipe
  await a.evaluate(async () => {
    localStorage.setItem('k', 'v')
    await new Promise(r => { const q = indexedDB.open('appdb'); q.onsuccess = () => (q.result.close(), r()) })
    await navigator.storageBuckets.open('hideout')
    document.cookie = 'plain=1; path=/'
    document.cookie = `own=1; path=/; domain=${location.hostname}`
    document.cookie = `shared=1; path=/; domain=${location.hostname.replace(/^[^.]+\./, '')}`
  })
  // (the cookies stay unset here: *.webxdc.localhost is cross-site to
  // localhost, so they are third-party — the same-site case is the Caddy e2e's)
  check((await a.evaluate(() => navigator.storageBuckets.keys())).includes('hideout'), 'the app planted a storage bucket')
  await page.evaluate(() => document.getElementById('app-aaa1').remove()) // closed first, like the app does
  await page.evaluate(o => window.wipeApp(o), xdc('aaa1'))
  // look from a fresh frame of that origin: the bootstrap page is fine for that
  await page.evaluate(o => {
    const f = document.createElement('iframe')
    f.id = 'peek'
    f.src = o + '/webxdc-host.html'
    document.body.append(f)
    return new Promise(r => f.addEventListener('load', r, { once: true }))
  }, xdc('aaa1'))
  const after = await frameFor('aaa1').evaluate(async () => ({
    ls: localStorage.length,
    dbs: (await indexedDB.databases()).length,
    caches: (await caches.keys()).length,
    sws: (await navigator.serviceWorker.getRegistrations()).length,
    buckets: (await navigator.storageBuckets.keys()).length,
    cookies: document.cookie,
  }))
  check(
    after.ls === 0 && after.dbs === 0 && after.caches === 0 && after.sws === 0 && after.buckets === 0 && after.cookies === '',
    `wipe leaves nothing behind (${JSON.stringify(after)})`
  )
  check((await b.evaluate(() => localStorage.getItem('secret'))) === null && (await b.textContent('#hi')) === 'hello from the app',
    'wiping one origin leaves another running')
} catch (err) {
  console.error('FAIL:', err)
  failed++
} finally {
  clearTimeout(watchdog)
  await browser.close()
  cleanup()
}
if (failed) {
  console.error(`\n${failed} check(s) failed`)
  process.exit(1)
}
console.log('\nPASS: webxdc origin host + service worker')
