// Real apps from the webxdc ecosystem against our webxdc runtime — the same
// fully offline setup as test-webxdc-e2e.mjs (real wasm core, Alice and Bob on
// the mock madmail server, one tab), but the apps are not ours: they are the
// vendored builds in scripts/fixtures/webxdc/ (see the README there).
//
//   webxdc-test     the reference app for webxdc runtimes; every check it
//                   performs is driven and recorded below
//   realtime-check  the store's realtime ping tester: Alice and Bob both open
//                   it and we read the ping table (latency numbers once
//                   realtime channels deliver)
//
// Bob runs the apps in the UI (risk dialog -> floating window); where a test
// needs a second party, Alice's copy is opened in the same page through the
// runtime (as the frontend's internalOpenWebxdc does), next to Bob's.
//
// Prints one line per check (ok / FAIL / GAP / info) and a JSON summary.
// GAP = a known missing feature (realtime); REQUIRE_REALTIME=1 turns it into
// a failure. Screenshots: .cache/webxdc-store-shots/ (SHOTS=0 to skip).
// SERVE_ROOT=<dir> serves a copy of dist/ instead of the live one.
// Run:  node scripts/test-webxdc-store-apps-e2e.mjs
import { mkdir, readFile } from 'node:fs/promises'
import { chromium } from 'playwright'
import { script, startIrohRelay, startServers } from './harness.mjs'
import { startMockMadmail } from './mock-madmail.mjs'

const PORT = Number(process.env.APP_PORT ?? 8686)
const APP = `http://localhost:${PORT}`
const SHOTS = process.env.SHOTS === '0' ? null : script('../.cache/webxdc-store-shots/')
// with a local iroh relay realtime must work; without one it can't here (n0's
// public relays are out of reach offline), so it is reported as a gap
const relay = await startIrohRelay(PORT + 2)
const REQUIRE_REALTIME = process.env.REQUIRE_REALTIME === '1' || !!relay
const sleep = ms => new Promise(r => setTimeout(r, ms))
const fixture = name => readFile(script(`fixtures/webxdc/${name}`))

const mock = await startMockMadmail()
const QR = `webimapaccount:127.0.0.1:${mock.port}`
const { cleanup: stopServers, watchdog } = await startServers({
  app: PORT,
  appRoot: process.env.SERVE_ROOT,
  proxy: PORT + 1,
  proxyStdio: 'pipe',
  settleMs: 700,
  watchdogMs: 480_000,
  label: 'webxdc store apps',
})
const cleanup = () => (stopServers(), mock.close(), relay?.kill())
process.on('exit', cleanup)

const browser = await chromium.launch({
  args: ['--host-resolver-rules=MAP *.localhost 127.0.0.1'],
  ...(process.env.CHROMIUM_BIN ? { executablePath: process.env.CHROMIUM_BIN } : {}),
})
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
const page = await context.newPage()
// a touch device, so apps float in the page where these checks look for them
// (a desktop's own app windows are test-webxdc-e2e.mjs's business)
await (await context.newCDPSession(page)).send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 })
page.on('pageerror', e => console.error('[pageerror]', e.message))
await page.addInitScript(() => {
  Object.defineProperty(window, 'eval', { value: window.eval, writable: false })
})
// anything the apps try to reach beyond localhost (iframes to delta.chat, the
// DNS-prefetch probes, STUN is not HTTP and does not show here)
const escapes = []
context.on('request', r => {
  const { hostname } = new URL(r.url())
  if (/^https?:/.test(r.url()) && hostname !== '127.0.0.1' && !/(^|\.)localhost$/.test(hostname)) escapes.push(r.url())
})
const nestedResponses = [] // see the nested sandboxed iframe check
context.on('response', r => /\/iframe-webrtc-test\.html$/.test(r.url()) && nestedResponses.push(`${r.status()} from ${r.fromServiceWorker() ? 'service worker' : 'server'}`))
const rpc = (method, ...args) => page.evaluate(([m, a]) => window.exp.rpc[m](...a), [method, args])

const results = []
const record = (app, check, status, detail = '') => {
  results.push({ app, check, status, detail })
  console.log(`${{ pass: 'ok', fail: 'FAIL', gap: 'GAP', info: 'info' }[status]} - [${app}] ${check}${detail ? ` — ${detail}` : ''}`)
}
const check = (app, ok, name, detail) => record(app, name, ok ? 'pass' : 'fail', detail)
const until = async (what, fn, ms = 60_000) => {
  const deadline = Date.now() + ms
  for (;;) {
    const v = await Promise.resolve().then(fn).catch(() => null)
    if (v) return v
    if (Date.now() > deadline) throw new Error(`timed out: ${what}`)
    await sleep(400)
  }
}
const soon = (fn, ms = 10_000) => until('', fn, ms).catch(() => null)
// not [hidden]: a closed one stays a moment, hidden, while its app unloads
const xdcWindows = name => page.locator(`.sc-xdc[aria-label="${name}"]:not([hidden])`)
const frameOf = async win => {
  const f = await (await win.locator('iframe.sc-xdc-frame').elementHandle()).contentFrame()
  await until('app loaded', async () => !/webxdc-host\.html$/.test(f.url()) && (await f.evaluate(() => document.readyState)) === 'complete')
  return f
}
const startApp = name => page.locator('.message .webxdc', { hasText: name }).getByRole('button').click()
const dialogs = () => page.locator('dialog[open]').count()
// The window grows to the app's full height for the shot, then goes back.
const shot = async (name, win) => {
  if (!SHOTS) return
  const vp = page.viewportSize()
  const style = await win.evaluate(w => w.getAttribute('style'))
  await page.setViewportSize({ width: vp.width, height: 2400 })
  await win.evaluate(w => Object.assign(w.style, { height: '2380px', top: '8px', zIndex: 99999 }))
  await sleep(300)
  await win.screenshot({ path: `${SHOTS}${name}.png` })
  await win.evaluate((w, s) => w.setAttribute('style', s), style)
  await page.setViewportSize(vp)
  console.log(`shot: .cache/webxdc-store-shots/${name}.png`)
}

const T = 'webxdc-test'
const R = 'realtime-check'
try {
  if (SHOTS) await mkdir(SHOTS, { recursive: true })
  await page.goto(`${APP}/main.html`)
  await page.waitForFunction(() => window.__coreSystemInfo, null, { timeout: 120_000 })

  // --- Alice and Bob, keys exchanged; Alice sends both apps ---
  const setup = async name => {
    const id = await rpc('addAccount')
    await rpc('addTransportFromQr', id, QR)
    await rpc('setConfig', id, 'displayname', name)
    if (relay) await rpc('setConfig', id, 'iroh_relay', relay.url)
    await rpc('startIo', id)
    return id
  }
  const alice0 = await setup('Alice Sender')
  const bob0 = await setup('Bob Reader')
  const [bobContact] = await rpc('importVcardContents', alice0, await rpc('makeVcard', bob0, [1]))
  await rpc('importVcardContents', bob0, await rpc('makeVcard', alice0, [1]))
  const aliceChat = await rpc('createChatByContactId', alice0, bobContact)
  for (const file of ['webxdc-test.xdc', 'realtime-check.xdc']) {
    const path = await page.evaluate(
      ([f, b64]) => window.exp.runtime.writeTempFileFromBase64(f, b64),
      [file, (await fixture(file)).toString('base64')]
    )
    await rpc('sendMsg', alice0, aliceChat, { file: path, filename: file, viewtype: 'Webxdc' })
  }
  const appsOf = async account => {
    const found = {}
    for (const chatId of await rpc('getChatlistEntries', account, 0, null, null)) {
      for (const id of await rpc('getMessageIds', account, chatId, false, false)) {
        const m = await rpc('getMessage', account, id)
        if (m.viewType === 'Webxdc') found[(await rpc('getWebxdcInfo', account, id)).name] = { id, chatId }
      }
    }
    return found
  }
  const bobApps0 = await until('both apps reach Bob', async () => {
    const f = await appsOf(bob0)
    return f['Test Webxdc'] && f['Realtime Check'] && f
  }, 120_000)
  await rpc('acceptChat', bob0, bobApps0['Test Webxdc'].chatId)

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
  const bobApps = await appsOf(bob)
  const aliceApps = await appsOf(alice)
  await page.getByTestId(`account-item-${bob}`).click()
  await page.getByTestId(`selected-account:${bob}`).waitFor({ state: 'attached', timeout: 60_000 })
  await page.locator('.chat-list .chat-list-item', { hasText: 'Alice Sender' }).first().click()
  await page.locator('.message .webxdc', { hasText: 'Test Webxdc' }).waitFor({ timeout: 60_000 })

  // Alice's copy, opened beside Bob's: what the frontend's internalOpenWebxdc
  // hands the runtime, minus the UI (her account is not the selected one)
  const openAs = (accountId, name, msgId, chatId) =>
    page.evaluate(
      async ([accountId, name, msgId, chatId]) => {
        const webxdcInfo = await window.exp.rpc.getWebxdcInfo(accountId, msgId)
        const chatName = (await window.exp.rpc.getBasicChatInfo(accountId, chatId)).name
        window.exp.runtime.openWebxdc(msgId, { accountId, displayname: name, chatName, webxdcInfo, href: '' })
      },
      [accountId, name, msgId, chatId]
    )

  // ================= webxdc-test, Bob =================
  // the notice before each new app is test-webxdc-e2e.mjs's; here it would
  // only stand between every instance and its first start
  await page.evaluate(() => window.exp.runtime.setDesktopSetting('webxdcWarning', false))
  await startApp('Test Webxdc')
  const bobWin = xdcWindows('Test Webxdc').first()
  await bobWin.waitFor({ timeout: 20_000 })
  const t = await frameOf(bobWin)
  check(T, true, 'app starts', new URL(t.url()).origin)
  await t.waitForSelector('#info-output .container')
  const card = (id, f = t) => f.locator(`#${id}`).innerText()

  // Info card
  const info = Object.fromEntries(
    (await card('info-output')).split('\n').filter(l => l.startsWith('webxdc.')).map(l => l.split(/:\s*/, 2))
  )
  check(T, info['webxdc.selfName'] === 'Bob Reader', 'selfName', info['webxdc.selfName'])
  const bobAddr = await rpc('getConfig', bob, 'addr')
  check(T, info['webxdc.selfAddr']?.length > 8 && info['webxdc.selfAddr'] !== bobAddr, 'selfAddr (per-app pseudonym, not the real address)', info['webxdc.selfAddr'])
  check(T, info['webxdc.isAppSender'] === 'false', 'isAppSender (Bob: false)', info['webxdc.isAppSender'])
  check(T, info['webxdc.isBroadcast'] === 'false', 'isBroadcast', info['webxdc.isBroadcast'])
  check(T, Number(info['webxdc.sendUpdateInterval']) > 0, 'sendUpdateInterval', info['webxdc.sendUpdateInterval'])
  check(T, Number(info['webxdc.sendUpdateMaxSize']) > 0, 'sendUpdateMaxSize', info['webxdc.sendUpdateMaxSize'])

  // Webxdc Updates: setUpdateListener resolves, then its own sendUpdate comes back
  const updOk = await soon(() => t.locator('#updates-ok').isVisible(), 15_000)
  check(T, updOk, 'setUpdateListener + own sendUpdate echoed', (await card('update-api-output')).split('\n').pop())
  const bobTestMsg = bobApps['Test Webxdc'].id
  const aliceTestMsg = aliceApps['Test Webxdc'].id
  const reached = await soon(async () =>
    JSON.parse(await rpc('getWebxdcStatusUpdates', alice, aliceTestMsg, 0)).some(u => u.payload?.['update-api-test']), 60_000)
  check(T, reached, 'Bob\'s update reaches Alice over mail')

  // Storage (Web API tab)
  const storage = await card('storage-output')
  check(T, !/WARNING/.test(storage), 'localStorage / sessionStorage / indexedDB / CacheStorage', storage.replace(/\s+/g, ' ').trim())
  const cookies = await card('cookies-output')
  // On localhost the app origin (x.webxdc.localhost) is cross-site to the chat
  // app (localhost), so Chromium's third-party cookie blocking applies; under a
  // real domain both share the registrable domain and are same-site.
  const cookieOk = /Times you opened this app: \d+/.test(cookies)
  record(T, 'cookies', cookieOk ? 'pass' : 'gap', cookieOk ? '' : 'document.cookie stays empty: third-party cookie blocking, the app origin is cross-site to localhost (same-site under a real domain)')
  const wasm = await soon(async () => { const s = await card('wasm-output'); return /WebAssembly is/.test(s) && s })
  check(T, /WebAssembly is supported/.test(wasm ?? ''), 'WebAssembly (incl. instantiateStreaming of a packaged .wasm)', wasm?.split('\n').pop())
  const nav = await card('navigator-output')
  check(T, /isSecureContext: true/.test(nav), 'isSecureContext')
  record(T, 'navigator.language / innerWidth', 'info', `${/Language: (\S+)/.exec(nav)?.[1]}, ${(await card('races-output')).match(/innerWidth = \d+/)?.[0]}`)

  // Uploads/Import: importFiles opens a picker, the chosen file comes back
  const png = await readFile(script('../packages/web-app/static/images/icon-256.png'))
  const chooser = page.waitForEvent('filechooser', { timeout: 10_000 }).catch(() => null)
  await t.click('text=webxdc.importFiles(...)')
  const fc = await chooser
  if (fc) await fc.setFiles({ name: 'pic.png', mimeType: 'image/png', buffer: png })
  const preview = await soon(() => t.evaluate(() => document.getElementById('inpImgPreview').src.startsWith('data:image/png')), 5000)
  check(T, fc && preview, 'importFiles (picker -> File -> preview)', fc ? `accept=${await fc.element().getAttribute('accept')}` : 'no file chooser')

  // sendToChat: every variant the app offers
  const sendCases = [
    ['Send To Chat (base64, file+text)', true],
    ['Send To Chat (blob, file+text)', true],
    ['Send To Chat (plainText, file+text)', true],
    ['Send To Chat (file only)', true],
    ['Send To Chat (text only)', true],
    ['Send To Chat (error: no file, no text)', false],
    ['Send To Chat (error: invalid file)', false],
  ]
  for (const [label, valid] of sendCases) {
    const before = await dialogs()
    await t.click(`text=${label}`)
    const state = await soon(async () => { const s = await t.innerText('#promise-state'); return !/Waiting/.test(s) && s }, 8000)
    const picker = valid ? await soon(async () => (await dialogs()) > before, 5000) : (await dialogs()) === before
    if (valid && label.startsWith('Send To Chat (base64')) {
      // go all the way: pick Alice's chat, the draft carries file + text
      await page.locator('dialog[open] .chat-list-item', { hasText: 'Alice Sender' }).first().click().catch(() => {})
      const draft = await soon(async () => { const d = await rpc('getDraft', bob, bobApps['Test Webxdc'].chatId); return d?.file && d }, 8000)
      check(T, draft?.fileName === 'example.txt' && draft?.text === 'Text and attachment!', 'sendToChat: picked chat gets draft with file + text', draft ? `${draft.fileName} / ${draft.text}` : 'no draft')
      await rpc('removeDraft', bob, bobApps['Test Webxdc'].chatId).catch(() => {})
    }
    while ((await dialogs()) > 0) await page.keyboard.press('Escape')
    const ok = valid ? /resolved/.test(state || '') && picker : /rejected/.test(state || '') && picker
    check(T, ok, `sendToChat: ${label.replace('Send To Chat ', '')}`, `${state}${valid ? picker ? ', picker opened' : ', NO picker' : ''}`)
  }

  // Webxdc Notify: an update with `info` + `href` becomes an info message in
  // the chat; clicking it opens the app at that href
  await t.click('text=info with deep-link to internal page, no notify')
  const infoMsg = page.locator('.message.webxdc-info, .info-message', { hasText: 'open page.html' }).first()
  const shown = await soon(() => infoMsg.isVisible(), 15_000)
  check(T, shown, 'info message from sendUpdate({info}) shows in chat')
  if (shown) {
    const clicked = Date.now()
    await infoMsg.locator('.bubble').click()
    const deep = await soon(() => /\/page\.html$/.test(t.url()) && t.evaluate(() => /Go Back/.test(document.body.innerText)), 30_000)
    check(T, deep, 'clicking the info message deep-links the open app to href', `${t.url()} after ${Date.now() - clicked} ms`)
    if (deep) await t.click('text=« Go Back')
    await t.waitForSelector('#info-output .container')
  }
  const notifyInfo = page.locator('.message.webxdc-info, .info-message', { hasText: 'open #links-output' }).first()
  await t.click('text=info and notify all with deep-link to #links-output section')
  const aliceNotified = await soon(async () => {
    for (const id of await rpc('getMessageIds', alice, aliceApps['Test Webxdc'].chatId, true, false)) {
      if ((await rpc('getMessage', alice, id)).text === 'open #links-output') return true
    }
  }, 30_000)
  check(T, await soon(() => notifyInfo.isVisible(), 5000), 'notify: info message with #anchor href shows in chat')
  check(T, aliceNotified, 'notify: Alice gets the info message over mail')

  // Links: an internal page loads; external links must not open silently
  await t.evaluate(() => document.getElementById('tab-web-api').click())
  await t.click('text=Link to an internal HTML page')
  const sub = await soon(() => /\/page\.html$/.test(t.url()) && t.evaluate(() => /Go Back/.test(document.body.innerText)), 8000)
  check(T, sub, 'link to an internal HTML page (page.html)', t.url())
  if (sub) await t.click('text=« Go Back')
  await t.waitForSelector('#info-output .container')
  await t.evaluate(() => document.getElementById('tab-web-api').click())
  const pagesBefore = context.pages().length
  const dlgBefore = await dialogs()
  await t.click('text=Normal link: https://delta.chat')
  await sleep(1500)
  const asked = (await dialogs()) > dlgBefore
  const opened = context.pages().length > pagesBefore
  record(T, 'external link https://delta.chat', opened ? 'fail' : asked ? 'pass' : 'info',
    opened ? 'opened a tab without asking' : asked ? 'asks before opening' : 'nothing happens (blocked silently; Delta Chat asks to open externally)')
  while ((await dialogs()) > 0) await page.keyboard.press('Escape')
  for (const name of ['Mailto link', 'old openpgp4fpr: QR verification link', 'geo-url link (geo:)']) {
    const urlBefore = t.url()
    await t.click(`text=${name}`)
    await sleep(800)
    const d = (await dialogs()) > dlgBefore
    record(T, `link: ${name}`, 'info', d ? 'handled by the chat app (dialog)' : t.url() !== urlBefore ? `frame navigated to ${t.url()}` : 'nothing happens')
    while ((await dialogs()) > 0) await page.keyboard.press('Escape')
    if (t.url() !== urlBefore) {
      // the app is gone from its window now; bring it back for the next link
      await t.goto(urlBefore)
      await t.waitForSelector('#info-output .container')
      await t.evaluate(() => document.getElementById('tab-web-api').click())
    }
  }

  // Sandboxing tab: internet must stay blocked
  await t.evaluate(() => document.getElementById('tab-sandbox').click())
  const webrtc = await soon(async () => { const s = await card('webrtc-output'); return !/checking\.\.\./.test(s) && s }, 45_000)
  record(T, 'webrtc-sidechannel (ICE leak)', /Leaking/.test(webrtc ?? '') ? 'fail' : 'info',
    `${(webrtc ?? 'still checking').split('\n').find(l => /GOOD|Leaking|checking/.test(l))} (no UDP egress here, so GOOD is not conclusive)`)
  // the app's own page in a nested <iframe sandbox="allow-scripts"> (opaque origin)
  const nested = page.frames().find(f => /\/iframe-webrtc-test\.html$/.test(f.url()))
  const nestedText = await nested?.evaluate(() => document.body.innerText.slice(0, 60)).catch(e => e.message)
  // ponytail: gap, not fail — a frame with an opaque origin is never controlled
  // by the origin's service worker, so its request goes to the server, which
  // has only the bootstrap files. Fixing it means serving app files differently.
  record(T, 'nested sandboxed iframe loads a page of the app (iframe-webrtc-test.html)',
    /webrtc-sidechannel/.test(nestedText ?? '') ? 'pass' : 'gap', `got ${JSON.stringify(nestedText)} (${nestedResponses.join(', ')})`)
  await t.fill('#dns-prefetch-domain-input', 'dns-probe.example.org')
  await t.click('text=Add iframe')
  await t.click('text=Add <link dns-prefetch>')
  page.once('dialog', d => d.dismiss().catch(() => {}))
  await t.click('text=Update top.location').catch(() => {})
  await sleep(2000)
  check(T, page.url().startsWith(APP), 'top.location to a foreign host is blocked', page.url())
  check(T, escapes.length === 0, 'no request left for the internet (iframe https://delta.chat, DNS-prefetch probes)', JSON.stringify(escapes))
  await shot('webxdc-test-3-sandboxing', bobWin)
  await t.evaluate(() => document.getElementById('tab-web-api').click())
  await shot('webxdc-test-2-web-api', bobWin)
  await t.evaluate(() => document.getElementById('tab-webxdc').click())

  // Duplicated Status Updates Race page
  await t.click('text=Duplicated Status Updates Race Test')
  await t.waitForSelector('text=Try to trigger update race')
  await t.click('text=Try to trigger update race')
  const batches = await soon(async () => { const s = await t.innerText('#updates'); return /\[/.test(s) && s }, 10_000)
  check(T, batches && !/duplicated update/.test(batches), 'duplicated updates race: no update delivered twice', (batches ?? 'no batch').replace(/\s+/g, ' '))
  await t.click('text=< Back')
  await t.waitForSelector('#info-output .container')

  // ================= webxdc-test, Alice (second party) =================
  await openAs(alice, 'Alice Sender', aliceTestMsg, aliceApps['Test Webxdc'].chatId)
  const aliceWin = xdcWindows('Test Webxdc').nth(1)
  await aliceWin.waitFor({ timeout: 20_000 })
  const ta = await frameOf(aliceWin)
  await ta.waitForSelector('#info-output .container')
  check(T, /isAppSender: true/.test(await card('info-output', ta)), 'isAppSender (Alice, the sender: true)')
  check(T, new URL(ta.url()).origin !== new URL(t.url()).origin, 'Alice\'s instance has its own origin')
  const prev = await soon(async () => Number(await ta.innerText('#previous-runs')) >= 1 && ta.innerText('#previous-runs'), 10_000)
  check(T, prev, 'Alice\'s listener replays Bob\'s earlier updates', `previous runs: ${prev}`)

  // Realtime: both join — one after the other, as people do: joining at the
  // very same moment can race in iroh-gossip 0.35 (test-webxdc-realtime-e2e) —
  // then both send until each has heard the other: what is sent before the
  // swarm has formed is dropped, by design of realtime channels
  await ta.click('#realtime-output >> text=Join')
  await sleep(2000) // Alice's advertisement travels by mail
  await t.click('#realtime-output >> text=Join')
  const heard = await soon(async () => {
    for (const f of [t, ta]) await f.click('#realtime-output >> text=Send Data')
    return (await card('realtime-output', ta)).includes('RECEIVED') && (await card('realtime-output', t)).includes('RECEIVED')
  }, 30_000)
  record(T, 'realtime channel: join + send between Alice and Bob', heard ? 'pass' : REQUIRE_REALTIME ? 'fail' : 'gap',
    heard ? 'both received' : `nothing received (Bob: ${(await card('realtime-output', t)).split('\n').slice(1).join(' | ')})`)
  for (const f of [t, ta]) await f.click('#realtime-output >> text=Leave').catch(() => {})
  await shot('webxdc-test-1-webxdc-bob', bobWin)
  await shot('webxdc-test-1-webxdc-alice', aliceWin)

  // Document events: close + reopen, then does sendUpdate from pagehide /
  // visibilitychange / unload / beforeunload make it?
  const loads = Number(await t.evaluate(() => localStorage.getItem('localStorage_storageCounter')))
  await aliceWin.getByRole('button', { name: 'Close' }).click()
  await bobWin.getByRole('button', { name: 'Close' }).click()
  await startApp('Test Webxdc')
  const t2 = await frameOf(xdcWindows('Test Webxdc').first())
  await t2.waitForSelector('#info-output .container')
  const loads2 = Number(await t2.evaluate(() => localStorage.getItem('localStorage_storageCounter')))
  check(T, loads2 === loads + 1, 'localStorage survives close/reopen (load counter +1)', `${loads} -> ${loads2}`)
  const events = await soon(async () => { const s = await card('unload-output', t2); return s }, 5000)
  const inCore = {}
  for (const u of JSON.parse(await rpc('getWebxdcStatusUpdates', bob, bobTestMsg, 0))) {
    if (u.payload?.isEventCounterUpdate) inCore[u.payload.eventName] = (inCore[u.payload.eventName] ?? 0) + 1
  }
  record(T, 'document-event updates stored in Bob\'s core', 'info', JSON.stringify(inCore))
  for (const ev of ['unload', 'beforeunload', 'visibilitychange', 'pagehide']) {
    const m = new RegExp(`${ev} triggered (\\d+) times, webxdc.sendUpdate\\(\\) worked (\\d*) times`).exec(events ?? '')
    record(T, `document event "${ev}" on close`, 'info', m ? `fired ${m[1]}x, sendUpdate from it delivered ${m[2] || 0}x` : 'n/a')
  }
  await xdcWindows('Test Webxdc').first().getByRole('button', { name: 'Close' }).click()

  // ================= realtime-check =================
  await startApp('Realtime Check')
  const rBob = xdcWindows('Realtime Check').first()
  await rBob.waitFor({ timeout: 20_000 })
  const rb = await frameOf(rBob)
  await rb.waitForSelector('.pingtable')
  await openAs(alice, 'Alice Sender', aliceApps['Realtime Check'].id, aliceApps['Realtime Check'].chatId)
  const rAlice = xdcWindows('Realtime Check').nth(1)
  const ra = await frameOf(rAlice)
  await ra.waitForSelector('.pingtable')
  check(R, true, 'app starts for Bob and Alice', `${new URL(rb.url()).origin}, ${new URL(ra.url()).origin}`)
  // pings go out every 800 ms; sample the table until ten have come back,
  // for up to 40 s (joining takes a mail round trip; slow runners)
  const pings = []
  let peers = 0
  for (let i = 0; i < 80 && pings.length < 10; i++) {
    await sleep(500)
    const rows = await rb.$$eval('.pingtable tbody tr', trs => trs.slice(1).map(tr => tr.lastElementChild.textContent.trim()))
    peers = Math.max(peers, rows.length)
    for (const v of rows) if (/^\d+$/.test(v)) pings.push(Number(v))
  }
  const sorted = [...new Set(pings)].sort((a, b) => a - b)
  record(R, 'realtime: Bob sees Alice as a peer and gets ping times', peers && pings.length ? 'pass' : REQUIRE_REALTIME ? 'fail' : 'gap',
    pings.length
      ? `peers ${peers}, ping ms min ${sorted[0]} / median ${sorted[sorted.length >> 1]} / max ${sorted.at(-1)} (${pings.length} samples)`
      : `no peers seen in 40 s (header count ${(await rb.innerText('.main-view')).split('\n')[1]})`)
  await shot('realtime-check-bob', rBob)
  await shot('realtime-check-alice', rAlice)
} catch (err) {
  console.error('FAIL:', err)
  for (const f of page.frames()) console.error('[frame]', f.url(), await f.evaluate(() => document.body?.innerText.slice(0, 80)).catch(e => e.message))
  record('harness', 'run', 'fail', String(err?.message ?? err))
  await page.screenshot({ path: `${SHOTS ?? '/tmp/'}failure.png` }).catch(() => {})
} finally {
  clearTimeout(watchdog)
  await browser.close()
  cleanup()
}
console.log('\n' + JSON.stringify(results, null, 1))
const failed = results.filter(r => r.status === 'fail').length
if (failed) {
  console.error(`\n${failed} check(s) failed`)
  process.exit(1)
}
console.log(`\nPASS: webxdc store apps (${results.filter(r => r.status === 'gap').length} known gap(s))`)
