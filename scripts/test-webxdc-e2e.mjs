// webxdc end to end (issue #2, WEBXDC.md) — fully offline: real wasm core, two
// accounts in one tab talking through the mock madmail server, the app served
// by serve.mjs, which also answers the webxdc origins
// http://<slug>.webxdc.localhost:<port>. Alice sends Bob two apps; Bob runs
// them in the UI:
//
//   1. "Start" asks first (risk dialog), once for every new app
//   2. on a desktop the app opens in a window of its own (a popup here, an app
//      window in an installed PWA), on its own origin, with webxdc.js:
//      selfName, icon and title come through
//   3. updates flow both ways — Bob's sendUpdate reaches Alice's core over
//      mail, Alice's reaches Bob's OPEN app live
//   4. close + reopen replays every update (serial replay), storage survives,
//      no second risk dialog for that app
//   5. two apps: a second risk dialog, two windows, two origins, neither sees
//      the other's storage
//   6. sendToChat opens the frontend's chat picker
//   7. attacks from inside the app: the chat app's DOM, fetch, top navigation,
//      popups, and navigating its own frame to a foreign server with data in
//      the URL — that last one is the parent's frame-src (webxdc.ts), so it is
//      checked against a real server that must see no request
//   8. deleting the message closes the app and wipes its origin's storage;
//      the other app keeps its own
//   9. a host that does not serve webxdc origins gets the explanation dialog
//  10. with the warning switched off in Settings › Chats, a new app opens
//      without asking; an archive declaring more than the unpack cap fails
//      with a message instead of inflating on the chat app's thread (zip bomb)
//  11. on a phone the app floats in the page, full screen, and the back
//      gesture closes it
//
// CADDY=1 runs it all behind a real Caddy instead: the shipped routes.caddy and
// Caddyfile.example with only the operator's edits, `tls internal`, on a
// same-site https domain (chat.slothful.test, mapped to loopback) — the
// production routing and headers, and cookies as production sees them (on
// localhost the webxdc origins are cross-site, so cookies stay unset there).
// Then also: the response headers, Caddy's 404 on a webxdc origin, and what
// the wipe does to cookies. Needs caddy (CADDY_BIN, else PATH).
//
// Screenshots land in .cache/webxdc-shots/ (SHOTS=0 to skip).
// Requires packages/core-wasm built and packages/web-app assembled+built.
// Run:  node scripts/test-webxdc-e2e.mjs
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { crc32 } from 'node:zlib'
import { chromium } from 'playwright'
import { script, startServers } from './harness.mjs'
import { startMockMadmail } from './mock-madmail.mjs'

const PORT = Number(process.env.APP_PORT ?? 8684)
const CADDY = process.env.CADDY === '1'
const HOST = CADDY ? `chat.slothful.test:${PORT}` : `localhost:${PORT}`
const APP = `${CADDY ? 'https' : 'http'}://${HOST}`
/** any webxdc origin of this host */
const XDC = new RegExp(`^${CADDY ? 'https' : 'http'}://[a-z0-9]+m\\d+\\.webxdc\\.${HOST.replaceAll('.', '\\.')}`)
const SHOTS = process.env.SHOTS === '0' ? null : script('../.cache/webxdc-shots/')
const sleep = ms => new Promise(r => setTimeout(r, ms))

// ponytail: hand-rolled stored zip (as test-context-menu-e2e.mjs), no zip dep.
// `lie` names an entry whose central-directory size claims `lieSize` bytes —
// what a zip bomb declares; core never reads that entry, so it still accepts
// the archive as a webxdc.
function storedZip(files, { lie, lieSize } = {}) {
  const locals = []
  const centrals = []
  let offset = 0
  for (const [name, content] of Object.entries(files)) {
    const nameBuf = Buffer.from(name)
    const data = Buffer.from(content)
    const crc = crc32(data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(data.length, 20)
    central.writeUInt32LE(name === lie ? lieSize : data.length, 24)
    central.writeUInt16LE(nameBuf.length, 28)
    central.writeUInt32LE(offset, 42)
    locals.push(local, nameBuf, data)
    centrals.push(central, nameBuf)
    offset += 30 + nameBuf.length + data.length
  }
  const cd = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(Object.keys(files).length, 8)
  end.writeUInt16LE(Object.keys(files).length, 10)
  end.writeUInt32LE(cd.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, cd, end])
}

const icon = await readFile(script('../packages/web-app/static/images/icon-256.png'))
const STYLE = `<style>
  body{font:15px/1.45 system-ui,sans-serif;margin:0;padding:18px;background:#f4f6fb;color:#1d2433}
  h1{font-size:20px;margin:0 0 4px}.me{color:#5b6475;margin:0 0 14px}
  button{font:inherit;padding:9px 16px;border:0;border-radius:8px;background:#2c8a68;color:#fff}
  ul{list-style:none;padding:0;margin:16px 0 0}li{background:#fff;border-radius:8px;padding:8px 12px;margin:6px 0;box-shadow:0 1px 2px rgba(0,0,0,.08)}
  .count{font-size:42px;font-weight:700;margin:8px 0}</style>`
const COUNTER = storedZip({
  'manifest.toml': 'name = "Shared Counter"\n',
  'icon.png': icon,
  'index.html': `<!doctype html><meta charset=utf-8><title>Shared Counter</title>${STYLE}
    <h1>Shared Counter</h1><p class=me>Hi <b id=me></b> — taps are shared with the chat.</p>
    <div class=count id=count>0</div><button id=inc>+1</button><ul id=log></ul>
    <script src="webxdc.js"></script><script src="app.js"></script>`,
  'app.js': `document.getElementById('me').textContent = webxdc.selfName
    window.received = []
    webxdc.setUpdateListener(u => {
      window.received.push(u.payload)
      document.getElementById('count').textContent = window.received.length
      const li = document.createElement('li')
      li.textContent = u.payload.who + ': ' + u.payload.text
      document.getElementById('log').prepend(li)
    }, 0).then(() => (window.listenerReady = true))
    document.getElementById('inc').onclick = () =>
      webxdc.sendUpdate({ payload: { who: webxdc.selfName, text: 'tapped +1' } }, '')`,
})
const NOTES = storedZip({
  'manifest.toml': 'name = "Notes"\n',
  'icon.png': icon,
  'index.html': `<!doctype html><meta charset=utf-8><title>Notes</title>${STYLE}
    <h1>Notes</h1><p class=me>Private to this app's own origin.</p><p id=note></p>
    <script src="webxdc.js"></script>
    <script>document.getElementById('note').textContent = localStorage.getItem('note') || '(no note yet)'
    // saves on the way out, as editor apps do
    addEventListener('pagehide', () => webxdc.sendUpdate({ payload: { who: 'notes', text: 'saved on close' } }, ''))</script>`,
})

const BOMB = storedZip(
  {
    'manifest.toml': 'name = "Too Big"\n',
    'index.html': '<!doctype html><title>Too Big</title>',
    'big.bin': 'tiny, but it says 300 MB',
  },
  { lie: 'big.bin', lieSize: 300 * 1024 * 1024 }
)

// an app core treats as an integration, which is what grants "internet access"
const NET = storedZip({ 'manifest.toml': 'name = "Net"\n', 'index.html': '<!doctype html><title>Net</title><p>net</p>' })
// a server the app must never reach (attack 7)
/** CADDY: a request straight to Caddy for any of its hosts (Node can't use
 * Chromium's host mapping, and Caddy's CA is ours alone) */
const caddyGet = (host, path) =>
  new Promise((resolve, reject) => {
    import('node:https').then(({ get }) =>
      get(
        { host: '127.0.0.1', port: PORT, path, servername: host.split(':')[0], headers: { host }, rejectUnauthorized: false },
        res => (res.resume(), res.on('end', () => resolve({ status: res.statusCode, headers: res.headers })))
      ).on('error', reject)
    )
  })
const leakHits = []
const leak = createServer((req, res) => (leakHits.push(req.url), res.end('got it')))
let leakConns = 0 // TCP connections, request or not: preconnect never sends one
leak.on('connection', () => leakConns++)
await new Promise(r => leak.listen(0, '127.0.0.1', r))
const LEAK = `http://leak.localhost:${leak.address().port}`

const mock = await startMockMadmail()
const QR = `webimapaccount:127.0.0.1:${mock.port}`
// CADDY: exactly what an operator runs — Caddyfile.example with its "# <- edit"
// values filled in, routes.caddy next to it — plus the global options a test
// needs: our ports, and certs from Caddy's own CA (Chromium ignores the
// untrusted root below)
let caddy = null
if (CADDY) {
  const dir = await mkdtemp(join(tmpdir(), 'webxdc-caddy-'))
  const shipped = script('../packages/web-app/caddy/')
  await writeFile(join(dir, 'routes.caddy'), await readFile(join(shipped, 'routes.caddy')))
  const example = (await readFile(join(shipped, 'Caddyfile.example'), 'utf8'))
    .replaceAll('example.com', HOST)
    .replaceAll('/srv/slothfulchat/dist', script('../packages/web-app/dist'))
  await writeFile(
    join(dir, 'Caddyfile'),
    `{\n\thttps_port ${PORT}\n\thttp_port ${PORT + 1}\n\tlocal_certs\n\tskip_install_trust\n\tadmin off\n}\n${example}`
  )
  caddy = spawn(process.env.CADDY_BIN ?? 'caddy', ['run', '--config', join(dir, 'Caddyfile'), '--adapter', 'caddyfile'], {
    cwd: dir,
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  caddy.on('exit', code => code && console.error(`caddy exited (${code}) — is it installed? (CADDY_BIN)`))
}
// the bridge only so the app doesn't toast "bridge not reachable" over the shots
const { cleanup: stopServers, watchdog } = await startServers({
  app: CADDY ? undefined : PORT,
  proxy: 8641,
  proxyStdio: 'pipe',
  settleMs: CADDY ? 2500 : 700,
  watchdogMs: 480_000,
})
const cleanup = () => (stopServers(), mock.close(), leak.close(), caddy?.kill())
process.on('exit', cleanup)

const browser = await chromium.launch({
  args: [
    '--host-resolver-rules=MAP *.localhost 127.0.0.1, MAP *.slothful.test 127.0.0.1',
    // the test domain must not go to an HTTP(S)_PROXY from the environment
    ...(CADDY ? ['--ignore-certificate-errors', '--no-proxy-server'] : []),
  ],
  ...(process.env.CHROMIUM_BIN ? { executablePath: process.env.CHROMIUM_BIN } : {}),
})
const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 })
const page = await context.newPage()
page.on('pageerror', e => console.error('[pageerror]', e.message))
page.on('console', m => /webxdc/i.test(m.text()) && m.type() === 'error' && console.error('[console]', m.text()))
await page.addInitScript(() => {
  Object.defineProperty(window, 'eval', { value: window.eval, writable: false })
})
const rpc = (method, ...args) => page.evaluate(([m, a]) => window.exp.rpc[m](...a), [method, args])

let failed = 0
const check = (ok, name) => {
  console.log(`${ok ? 'ok' : 'FAIL'} - ${name}`)
  if (!ok) failed++
}
const until = async (what, fn, ms = 60_000) => {
  const deadline = Date.now() + ms
  for (;;) {
    const v = await fn().catch(() => null)
    if (v) return v
    if (Date.now() > deadline) throw new Error(`timed out: ${what}`)
    await sleep(400)
  }
}
const shot = async (name, target = page) => {
  if (!SHOTS) return
  await target.screenshot({ path: `${SHOTS}${name}.png` })
  console.log(`shot: .cache/webxdc-shots/${name}.png`)
}
const appFrame = name =>
  until(`${name} frame`, async () => {
    for (const f of context.pages().flatMap(p => p.frames())) {
      if (XDC.test(f.url()) && (await f.title().catch(() => '')) === name) return f
    }
  })
/** a desktop app's own window: a page of the context, opened by the chat app */
const appWindow = name =>
  until(`${name} window`, async () => {
    for (const p of context.pages()) {
      if (p.url().endsWith('/webxdc-window.html') && (await p.title().catch(() => '')).startsWith(name)) return p
    }
  }, 20_000)
const windowOpen = async name => {
  for (const p of context.pages()) {
    if (p.url().endsWith('/webxdc-window.html') && (await p.title().catch(() => '')).startsWith(name)) return true
  }
  return false
}
/** a floating one, in the page (phones, or where the browser refuses a window) */
// not [hidden]: a closed one stays a moment, hidden, while its app unloads
const xdcWindow = name => page.locator('.sc-xdc:not([hidden])', { has: page.locator('.sc-xdc-title', { hasText: name }) })
const accept = async () => {
  await risk.waitFor({ timeout: 10_000 })
  await risk.getByRole('button', { name: 'I understand the risk — open app' }).click()
}
const risk = page.locator('#sc-webxdc-risk')
const startApp = name => page.locator('.message .webxdc', { hasText: name }).getByRole('button').click()

try {
  if (SHOTS) await mkdir(SHOTS, { recursive: true })
  await page.goto(`${APP}/main.html`)
  await page.waitForFunction(() => window.__coreSystemInfo, null, { timeout: 120_000 })
  if (CADDY) {
    const main = await caddyGet(HOST, '/main.html')
    check(
      main.headers['content-security-policy']?.includes(`frame-src https://${HOST}/html-email.html https://*.webxdc.${HOST}`),
      'Caddy pins the chat app\'s frame-src in a header too'
    )
    const boot = await caddyGet(`abc1m1.webxdc.${HOST}`, '/webxdc-host.html')
    check(boot.status === 200 && boot.headers['content-security-policy'] === `frame-ancestors https://${HOST}`, 'a webxdc origin serves its bootstrap page, framable by the chat app only')
    check((await caddyGet(`abc1m1.webxdc.${HOST}`, '/main.html')).status === 404, 'and none of the chat app (404)')
  }

  // --- Alice and Bob, keys exchanged; Alice sends both apps ---
  const setup = async name => {
    const id = await rpc('addAccount')
    await rpc('addTransportFromQr', id, QR)
    await rpc('setConfig', id, 'displayname', name)
    await rpc('startIo', id)
    return id
  }
  const alice0 = await setup('Alice Sender')
  const bob0 = await setup('Bob Reader')
  const [bobContact] = await rpc('importVcardContents', alice0, await rpc('makeVcard', bob0, [1]))
  await rpc('importVcardContents', bob0, await rpc('makeVcard', alice0, [1]))
  const aliceChat = await rpc('createChatByContactId', alice0, bobContact)
  for (const [file, zip] of [['counter.xdc', COUNTER], ['notes.xdc', NOTES], ['big.xdc', BOMB]]) {
    const path = await page.evaluate(
      ([f, b64]) => window.exp.runtime.writeTempFileFromBase64(f, b64),
      [file, zip.toString('base64')]
    )
    await rpc('sendMsg', alice0, aliceChat, { file: path, filename: file, viewtype: 'Webxdc' })
  }
  const bobApps = await until('both apps reach Bob', async () => {
    const found = {}
    for (const chatId of await rpc('getChatlistEntries', bob0, 0, null, null)) {
      for (const id of await rpc('getMessageIds', bob0, chatId, false, false)) {
        const m = await rpc('getMessage', bob0, id)
        if (m.viewType === 'Webxdc') found[(await rpc('getWebxdcInfo', bob0, id)).name] = { id, chatId }
      }
    }
    return found['Shared Counter'] && found['Notes'] && found['Too Big'] && found
  }, 120_000)
  await rpc('acceptChat', bob0, bobApps['Notes'].chatId)

  // --- into Bob's UI (ids can be renumbered across the reload: by name) ---
  await rpc('selectAccount', bob0)
  await sleep(3000) // OPFS write-through flush before the worker is torn down
  await page.reload()
  await page.waitForFunction(() => window.__coreSystemInfo, null, { timeout: 120_000 })
  const idByName = async name => {
    for (const id of await rpc('getAllAccountIds')) {
      if ((await rpc('getAccountInfo', id).catch(() => null))?.displayName === name) return id
    }
    throw new Error(`no account ${name}`)
  }
  const bob = await idByName('Bob Reader')
  const alice = await idByName('Alice Sender')
  await rpc('startIo', alice) // the UI only starts the selected account's IO
  await page.getByTestId(`account-item-${bob}`).click()
  await page.getByTestId(`selected-account:${bob}`).waitFor({ state: 'attached', timeout: 60_000 })
  await page.locator('.chat-list .chat-list-item', { hasText: 'Alice Sender' }).first().click()
  await page.locator('.message .webxdc', { hasText: 'Shared Counter' }).waitFor({ timeout: 60_000 })
  check(
    (await page.locator('meta[http-equiv="Content-Security-Policy"]').count()) === 2,
    'the frame-src narrowing policy is in place next to main.html\'s'
  )
  await shot('1-chat-with-apps')

  // 1. risk dialog
  await startApp('Shared Counter')
  await risk.waitFor({ timeout: 10_000 })
  check(await risk.getByText('has not been independently audited').isVisible(), 'risk dialog explains the residual risk')
  check(await risk.getByText('Settings › Chats').isVisible(), 'and says where to switch it off')
  await shot('2-risk-dialog')
  await risk.getByRole('button', { name: 'I understand the risk — open app' }).click()

  // 2. the window and the app
  const counterWin = await appWindow('Shared Counter')
  const counter = await appFrame('Shared Counter')
  check(counter.page() === counterWin, 'on a desktop the app runs in a window of its own')
  const counterOrigin = new URL(counter.url()).origin
  check(XDC.test(counterOrigin) && counterOrigin.endsWith(HOST), `app runs on its own origin (${counterOrigin})`)
  await until('listener ready', () => counter.evaluate(() => window.listenerReady))
  check((await counter.textContent('#me')) === 'Bob Reader', 'webxdc.selfName is Bob')
  check(/Shared Counter – Alice Sender/.test(await counterWin.title()), 'window title is "app – chat"')
  const iconHref = await counterWin.evaluate(() => document.querySelector('link[rel=icon]').href)
  check(
    await page.evaluate(async u => (await fetch(u)).headers.get('content-type')?.startsWith('image/'), iconHref),
    'window shows the app icon'
  )
  check(!(await counterWin.evaluate(() => document.body.classList.contains('sc-xdc-loading'))), 'loading state is cleared')

  // 3. updates both ways
  const aliceMsg = (await rpc('getMessageIds', alice, (await rpc('getChatlistEntries', alice, 0, null, null))[0], false, false))
  const aliceCounter = await until('alice counter msg', async () => {
    for (const id of aliceMsg) if ((await rpc('getWebxdcInfo', alice, id).catch(() => null))?.name === 'Shared Counter') return id
  })
  await counter.click('#inc')
  const bobCounter = bobApps['Shared Counter'].id
  await until('Bob\'s update lands in his core', async () =>
    JSON.parse(await rpc('getWebxdcStatusUpdates', bob, bobCounter, 0)).some(u => u.payload.who === 'Bob Reader'), 10_000)
  check(true, 'the bridge hands Bob\'s sendUpdate to his core')
  await until('Bob\'s update reaches Alice', async () =>
    JSON.parse(await rpc('getWebxdcStatusUpdates', alice, aliceCounter, 0)).some(u => u.payload.who === 'Bob Reader'))
  check(true, 'Bob\'s sendUpdate reaches Alice\'s core over mail')
  await rpc('sendWebxdcStatusUpdate', alice, aliceCounter, JSON.stringify({ payload: { who: 'Alice Sender', text: 'tapped +1' } }), '')
  await until('Alice\'s update shows in Bob\'s open app', () =>
    counter.evaluate(() => window.received.some(p => p.who === 'Alice Sender')))
  check(true, 'Alice\'s update arrives live in Bob\'s open app')
  await shot('3-app-window', counterWin)

  // 4. close + reopen
  await counter.evaluate(() => localStorage.setItem('kept', 'yes'))
  await counterWin.close()
  check(!(await windowOpen('Shared Counter')), 'closing the window closes the app')
  await startApp('Shared Counter')
  const counterWin2 = await appWindow('Shared Counter')
  check(!(await risk.isVisible()), 'no second risk dialog for the same app')
  const counter2 = await appFrame('Shared Counter')
  await until('replay', () => counter2.evaluate(() => window.received.length === 2))
  check(true, 'reopen replays every update from serial 0')
  check((await counter2.evaluate(() => localStorage.getItem('kept'))) === 'yes', 'storage survives close/reopen')
  check(new URL(counter2.url()).origin === counterOrigin, 'reopen lands on the same origin')
  if (CADDY) {
    // production: webxdc origins are same-site with the app host, so cookies
    // work — under the app's own host, and (the known gap) above it
    const apex = HOST.split(':')[0]
    await counter2.evaluate(apex => {
      document.cookie = 'plain=1; path=/'
      document.cookie = `own=1; path=/; domain=${location.hostname}`
      document.cookie = `shared=1; path=/; domain=webxdc.${apex}`
      document.cookie = `tossed=1; path=/; domain=${apex}`
    }, apex)
    const jar = await counter2.evaluate(() => document.cookie)
    check(['plain', 'own', 'shared', 'tossed'].every(c => jar.includes(`${c}=1`)), `an app can set cookies, also for webxdc.<host> and <host> (${jar})`)
    check((await page.evaluate(() => document.cookie)).includes('tossed=1'), 'the one for <host> reaches the chat app too — the known cookie gap')
  }

  // 5. a second app: a new decision, so the dialog again
  await startApp('Notes')
  await accept()
  check(true, 'a new app asks again')
  const notes = await appFrame('Notes')
  const notesOrigin = new URL(notes.url()).origin
  check(notesOrigin !== counterOrigin, 'a second app gets a second origin')
  check((await notes.evaluate(() => localStorage.getItem('kept'))) === null, 'and cannot see the first app\'s storage')
  await notes.evaluate(() => localStorage.setItem('note', 'Buy oat milk'))
  await shot('4-second-window', notes.page())

  // 6. sendToChat
  const dialogs = () => page.locator('dialog[open]').count()
  const before = await dialogs()
  await counter2.evaluate(() => window.webxdc.sendToChat({ text: 'shared from the app' }))
  await until('chat picker', async () => (await dialogs()) > before, 10_000)
  check(true, 'sendToChat opens the frontend\'s chat picker')
  await page.keyboard.press('Escape')

  // 7. attacks from inside the app
  check(await counter2.evaluate(() => { try { return !parent.document } catch { return true } }), 'no access to the chat app\'s DOM')
  check((await counter2.evaluate(u => fetch(u).then(() => 'reached', () => 'blocked'), `${LEAK}/fetch`)) === 'blocked', 'fetch() to the network is blocked')
  check(await counter2.evaluate(() => window.open('https://example.org') === null), 'popups are blocked')
  check(await counter2.evaluate(() => { try { return !opener && !parent.opener.document } catch { return true } }), 'nor to the chat app through its window\'s opener')
  const refused = await counter2.evaluate(
    () =>
      new Promise(resolve => {
        let n = 0
        let errs = 0
        addEventListener('message', e => {
          if (!String(e.data?.id).startsWith('flood')) return
          if (e.data.error) errs++
          if (++n === 200) resolve(errs)
        })
        for (let i = 0; i < 200; i++) parent.postMessage({ webxdc: 'getUpdates', id: `flood${i}`, serial: 0 }, '*')
      })
  )
  check(refused > 0 && refused < 200, `a flood of bridge calls is capped, the rest answered (${refused} of 200 refused)`)
  await counter2.evaluate(u => { try { top.location.href = u } catch {} }, `${LEAK}/top`)
  await sleep(1500)
  check(counter2.page().url().endsWith('/webxdc-window.html') && page.url().startsWith(APP), 'top navigation is blocked')
  // resource hints: Chromium connects nowhere for them under the app CSP
  await counter2.evaluate(u => {
    for (const rel of ['preconnect', 'dns-prefetch', 'prefetch', 'preload']) {
      const l = document.createElement('link')
      Object.assign(l, { rel, href: `${u}/${rel}`, as: 'fetch' })
      document.head.append(l)
    }
  }, LEAK)
  // a blob: worker and a blob: document inherit the app's CSP
  await counter2.evaluate(u => {
    const w = new Worker(URL.createObjectURL(new Blob([`fetch('${u}/worker').catch(() => {})`])))
    setTimeout(() => w.terminate(), 2000)
  }, LEAK)
  await sleep(2000)
  await counter2.evaluate(u => {
    const html = `<img src="${u}/blob-img"><script>fetch('${u}/blob-fetch').catch(() => {})</script>`
    location.href = URL.createObjectURL(new Blob([html], { type: 'text/html' }))
  }, LEAK)
  await sleep(1500)
  // an app window's frame-src has no blob: at all; a floating app's does
  // (main.html), and there the blob: document inherits the app's CSP
  console.log(`info - a blob: document in the app's frame was ${counter2.url().startsWith('blob:') ? 'allowed (and must fetch nothing, below)' : 'refused'}`)
  check(leakConns === 0, `resource hints, blob: workers and documents open no connection (${leakConns})`)
  // and last (the frame is gone after it): its own frame, data in the URL
  await counter2.evaluate(u => { location.href = u }, `${LEAK}/?secret=from-the-app`)
  await sleep(2500)
  check(leakHits.length === 0, `no request reached the foreign server (${JSON.stringify(leakHits)})`)
  // a known gap (WEBXDC.md): Chrome preconnects to a navigation's target before
  // frame-src refuses it — with a real host name, a DNS lookup of a name the
  // app chose. Chrome's "Preload pages" setting, off, stops it.
  console.log(`info - the refused navigation still made Chrome preconnect: ${leakConns} TCP connection(s)`)

  // 8. delete -> close + wipe; the other app keeps its storage
  await rpc('deleteMessages', bob, [bobApps['Shared Counter'].id])
  await until('window closes', async () => !(await windowOpen('Shared Counter')), 20_000)
  check(true, 'deleting the message closes its app')
  await until('record dropped', () =>
    page.evaluate(o => !(o in JSON.parse(localStorage.getItem('slothfulchat.webxdcOrigins') || '{}')), counterOrigin), 20_000)
  const peek = async origin => {
    await page.evaluate(o => {
      const f = document.createElement('iframe')
      f.className = 'peek'
      f.style.display = 'none'
      f.src = o + '/webxdc-host.html'
      document.body.append(f)
    }, origin)
    const f = await until('peek frame', async () => page.frames().find(x => x.url() === `${origin}/webxdc-host.html`))
    await f.waitForLoadState()
    const n = await f.evaluate(
      async () => [localStorage.length + (await caches.keys()).length + (await indexedDB.databases()).length, document.cookie]
    )
    await page.evaluate(() => document.querySelectorAll('iframe.peek').forEach(f => f.remove()))
    return n
  }
  const [left, cookiesLeft] = await peek(counterOrigin)
  check(left === 0, 'its origin\'s storage is wiped')
  if (CADDY) check(cookiesLeft === 'tossed=1', `and its cookies, up to webxdc.<host> — not the one above, which may be someone's login (left: "${cookiesLeft}")`)
  check((await notes.evaluate(() => localStorage.getItem('note'))) === 'Buy oat milk', 'the other app keeps its storage')

  // 9. a host without webxdc origins
  const saves = async () =>
    JSON.parse(await rpc('getWebxdcStatusUpdates', bob, bobApps['Notes'].id, 0)).filter(u => u.payload.text === 'saved on close').length
  await notes.page().close()
  await sleep(1500)
  console.log(`info - closing an app WINDOW kept ${await saves()} save-on-close update(s) (the window may go before it is sent)`)
  const hostPage = new RegExp(`${XDC.source}/webxdc-host\\.html`) // unroute matches by equal pattern
  await context.route(hostPage, r => r.fulfill({ status: 404, body: 'not found' }))
  await startApp('Notes')
  const notServed = page.locator('#sc-webxdc-dialog')
  await notServed.waitFor({ timeout: 30_000 })
  check(await notServed.getByText('Webxdc apps are not available here').isVisible(), 'unsupported host explains itself')
  check(!(await windowOpen('Notes')), 'and leaves no broken window behind')
  await shot('5-not-served')
  await context.unroute(hostPage)
  await page.locator('#sc-webxdc-dialog').getByRole('button', { name: 'Close' }).click()

  // 10. the warning switched off in the settings; the unpack cap
  await page.getByTestId('open-settings-button').click()
  await page.locator('dialog[open]').getByRole('button', { name: 'Chats', exact: true }).click()
  await page.getByText('Warn before opening webxdc apps').waitFor()
  await shot('7-settings')
  await page.getByText('Warn before opening webxdc apps').click()
  await page.keyboard.press('Escape')
  check(
    (await page.evaluate(() => window.exp.runtime.getDesktopSettings())).webxdcWarning === false,
    'Settings › Chats has the switch to turn the warning off'
  )
  await startApp('Too Big')
  const bombWin = await appWindow('Too Big')
  check(!(await risk.isVisible()), 'switched off, a new app opens without asking')
  await bombWin.locator('.sc-xdc-status', { hasText: 'larger than 256 MB' }).waitFor({ timeout: 15_000 })
  check(await bombWin.evaluate(() => document.body.classList.contains('sc-xdc-failed')), 'an archive declaring 300 MB unpacked is refused with a message')
  check(
    await page.evaluate(
      m => !Object.values(JSON.parse(localStorage.getItem('slothfulchat.webxdcOrigins') || '{}')).some(([, id]) => id === m),
      bobApps['Too Big'].id
    ),
    'and it never reached its origin (no storage recorded for it)'
  )
  await bombWin.close()

  // 12. "internet access": core grants it to an app set as a webxdc
  // integration (Electron then lets it online). Here it changes nothing.
  const netFile = await page.evaluate(b64 => window.exp.runtime.writeTempFileFromBase64('net.xdc', b64), NET.toString('base64'))
  await rpc('setWebxdcIntegration', bob, netFile)
  const netMsg = await rpc('initWebxdcIntegration', bob, bobApps['Notes'].chatId)
  const netInfo = await rpc('getWebxdcInfo', bob, netMsg)
  check(netInfo.internetAccess === true, 'core grants an integrated app internet access')
  await page.evaluate(
    ([m, info, acc]) => window.exp.runtime.openWebxdc(m, { accountId: acc, displayname: 'Bob Reader', chatName: 'chat', webxdcInfo: info, href: '' }),
    [netMsg, netInfo, bob]
  )
  const net = await appFrame('Net')
  const hitsBefore = leakHits.length
  check((await net.evaluate(u => fetch(u).then(() => 'reached', () => 'blocked'), `${LEAK}/integration`)) === 'blocked', 'and still it reaches nothing: internet access is never granted')
  check(await net.evaluate(() => typeof RTCPeerConnection === 'undefined' && typeof webkitRTCPeerConnection === 'undefined'), 'no WebRTC in an app (the guard its service worker puts first)')
  await sleep(500)
  check(leakHits.length === hitsBefore, 'no request from it reached the foreign server')
  await page.evaluate(() => window.exp.runtime.closeAllWebxdcInstances())

  // 11. a phone: touch, small screen — the app floats in the page, full screen
  const cdp = await context.newCDPSession(page)
  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 })
  await page.setViewportSize({ width: 390, height: 844 })
  check(await page.evaluate(() => matchMedia('(pointer: coarse)').matches), 'the phone has a coarse pointer')
  await startApp('Notes')
  const phone = xdcWindow('Notes')
  await (await appFrame('Notes')).waitForSelector('#note')
  check(!(await windowOpen('Notes')), 'no app window on a phone')
  const box = await phone.boundingBox()
  check(box && box.x === 0 && box.y === 0 && box.width === 390 && box.height === 844, `on a phone the app is full screen (${JSON.stringify(box)})`)
  await shot('6-phone')
  // iOS: the keyboard covers fixed elements; viewport-keyboard.js publishes
  // the visible height and the full-screen app follows it
  await page.evaluate(() => document.documentElement.style.setProperty('--sc-vvh', '500px'))
  check((await phone.boundingBox())?.height === 500, 'with the iOS keyboard up the app shrinks to the visible area')
  await page.evaluate(() => document.documentElement.style.removeProperty('--sc-vvh'))
  // links: a web link is shown and asked about, an unknown scheme is dropped,
  // and the app stays where it is either way
  const notesPhone = await appFrame('Notes')
  const link = href => notesPhone.evaluate(h => {
    const a = Object.assign(document.createElement('a'), { href: h, textContent: 'link' })
    document.body.append(a)
    a.click()
  }, href)
  await link('https://example.org/?secret=from-the-app')
  const linkDialog = page.locator('#sc-webxdc-link')
  await linkDialog.waitFor({ timeout: 5000 })
  check(await linkDialog.getByText('https://example.org/?secret=from-the-app').isVisible(), 'a web link in an app is shown and asked about first')
  await linkDialog.getByRole('button', { name: 'Cancel' }).click()
  await link('geo:52.5,13.4')
  await sleep(500)
  check(/\/index\.html$/.test(notesPhone.url()) && (await notesPhone.locator('#note').count()) === 1, 'and no link replaces the app with an error page')
  const savedBefore = await saves()
  await page.evaluate(() => history.back())
  await until('back closes the app', async () => (await phone.count()) === 0, 5000)
  check(page.url().startsWith(APP) && (await page.locator('.message .webxdc').count()) > 0, 'the back gesture closes the app, the chat stays')
  await startApp('Notes')
  await (await appFrame('Notes')).waitForSelector('#note') // loaded: it has a pagehide handler to run
  const depth = await page.evaluate(() => history.length)
  await phone.getByRole('button', { name: 'Close' }).click()
  await until('close pops its history entry', async () => (await page.evaluate(() => history.state?.webxdc)) == null, 5000)
  await until('window removed', async () => (await phone.count()) === 0, 5000)
  check(true, `closing it takes its history entry along (history.length ${depth})`)
  // closed twice above, by the back gesture and by its close button
  await until('save on close', async () => (await saves()) >= savedBefore + 2, 10_000).catch(() => null)
  check((await saves()) >= savedBefore + 2, `what a floating app sends as it closes reaches the core (${(await saves()) - savedBefore} of 2 saves)`)

  // an app navigating its frame to any other URL of the chat app's origin:
  // refused before the request (frame-src names the mail viewer's exact path)
  let probes = 0
  context.on('request', r => r.url().includes('nav-probe') && probes++)
  await startApp('Notes')
  const notesLast = await appFrame('Notes')
  await notesLast.evaluate(u => { location.href = u }, `${APP}/main.html?nav-probe=from-the-app`)
  await sleep(1500)
  check(probes === 0, `an app can't send a request to the chat app's origin by navigating its frame (${probes} sent)`)
} catch (err) {
  console.error('FAIL:', err)
  failed++
  await page.screenshot({ path: `${SHOTS ?? '/tmp/'}failure.png` }).catch(() => {})
} finally {
  clearTimeout(watchdog)
  await browser.close()
  cleanup()
}
if (failed) {
  console.error(`\n${failed} check(s) failed`)
  process.exit(1)
}
console.log('\nPASS: webxdc end to end')
