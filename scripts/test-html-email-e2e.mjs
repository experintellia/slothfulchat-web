// HTML email viewer END-TO-END test (issue: verify the full "Show Full
// Message…" path on the real wasm core, so no manual testing is needed).
//
// Unlike scripts/test-html-email.mjs (which drives the viewer wrapper in
// isolation), this boots the actual web-app on the wasm core, has one account
// send a message carrying crafted, hostile HTML to a second account, then
// drives the receiver's real UI: open the chat, click the message's "Show
// Full Message…" button, and assert the viewer that opens is properly
// isolated and that remote images are blocked until the user opts in.
//
// Fully offline: an in-process mock madmail server (trimmed from
// test-export-chat-html) configures both accounts and relays the encrypted
// message between them — nothing leaves the process.
//
// Two accounts are REQUIRED, not one: the madmail transport ignores
// unencrypted inbound mail ("Fetched unencrypted message, ignoring"), so the
// crafted HTML has to travel as a real end-to-end-encrypted message between
// key-exchanged accounts. An outgoing sendMsg({text, html}) carries a
// text/html part, which is exactly what sets has_html on the receiver — the
// same path a real HTML email hits. (A device message stores HTML but never
// sets has_html, so it would never show the button.)
//
// Asserts:
//   - the received message with an HTML part shows "Show Full Message…"
//     (has_html wired core -> frontend)
//   - clicking it opens the viewer with the mail's visible text
//   - the crafted <script> did NOT run and is absent from the rendered frame
//     (sandbox + CSP + DOMPurify hold end to end, not just in the unit test)
//   - the content frame is cross-origin isolated from the app
//   - the remote tracking image is NOT fetched while blocked (default)
//   - after choosing "Always" in the ⋮ menu, the remote image IS attempted
//   - an app link (invite) clicked in the viewer after switching the main app
//     to the other account still runs under the ORIGINATING account (#3)
//   - opening a file attachment yields a tab with window.opener === null (#2)
import { randomBytes } from 'node:crypto'
import { chromium } from 'playwright'
import { startServers } from './harness.mjs'
import { startMockMadmail } from './mock-madmail.mjs'

const APP_PORT = Number(process.env.APP_PORT ?? 8646)
const sleep = ms => new Promise(r => setTimeout(r, ms))

const REMOTE_IMG = 'https://html-email-e2e-tracker.invalid/pixel.png'
const BODY_TEXT = 'e2ebody' + randomBytes(4).toString('hex')
const FALLBACK_TEXT = 'e2efallback' + randomBytes(4).toString('hex') // plaintext part
const CRAFTED_HTML = `<!doctype html><html><head>
    <meta http-equiv="Content-Security-Policy" content="img-src https: 'unsafe-inline'">
  </head><body>
    <script>window.top.__e2ePwned = true<\/script>
    <img src="broken.png" onerror="window.top.__e2ePwned = true">
    <p id="e2e-body">${BODY_TEXT}</p>
    <img id="e2e-remote" src="${REMOTE_IMG}">
    <a id="e2e-invite" href="https://i.delta.chat/#e2einvite">join</a>
  </body></html>`

// --- mock madmail (shared: scripts/mock-madmail.mjs) ---
const mock = await startMockMadmail()
const QR = `webimapaccount:127.0.0.1:${mock.port}`
console.log(`mock madmail on 127.0.0.1:${mock.port}`)

// --- web-app server ---
const { cleanup: stopServers, watchdog } = await startServers({
  app: APP_PORT,
  settleMs: 700,
  watchdogMs: 360_000,
})
// the mock is ours, not the harness's, so it needs closing alongside
const cleanup = () => (stopServers(), mock.close())
process.on('exit', cleanup)

// --- browser ---
const launchOpts = process.env.CHROMIUM_BIN ? { executablePath: process.env.CHROMIUM_BIN } : {}
const browser = await chromium.launch(launchOpts)
// narrow viewport (< 501px): the viewer opens as the in-app DIALOG (same page,
// easy to assert) rather than a popup window, and also exercises the mobile
// back-button / ⋮-menu header. The desktop popup path shares this same wrapper
// code and is covered by scripts/test-html-email.mjs.
const context = await browser.newContext({ viewport: { width: 460, height: 900 } })
const page = await context.newPage()
page.on('console', m => {
  if (/panicked at/.test(m.text())) console.error('[page PANIC]', m.text())
})
page.on('pageerror', e => console.error('[pageerror]', e.message))
await page.addInitScript(() => {
  Object.defineProperty(window, 'eval', { value: window.eval, writable: false })
})
const rpc = (method, ...args) => page.evaluate(([m, a]) => window.exp.rpc[m](...a), [method, args])

// track remote-image request outcomes: a CSP-blocked load reports errorText
// 'csp' and never reaches the network; an allowed one fails with a real net::
// error (the .invalid domain doesn't resolve). That difference is the signal.
const remote = new Map()
const track = p => {
  p.on('request', r => remote.set(r.url(), 'pending'))
  p.on('requestfailed', r => remote.set(r.url(), r.failure()?.errorText ?? 'failed'))
  p.on('requestfinished', r => remote.set(r.url(), 'finished'))
}
track(page)
const remoteOutcome = () =>
  [...remote].filter(([u]) => u.startsWith('https://html-email-e2e-tracker.invalid')).map(([, o]) => o)

let failed = 0
const check = (ok, name) => {
  console.log(`${ok ? 'ok' : 'FAIL'} - ${name}`)
  if (!ok) failed++
}

try {
  await page.goto(`http://localhost:${APP_PORT}/main.html`)
  await page.waitForFunction(() => window.__coreSystemInfo, null, { timeout: 120_000 })
  console.log('OK: wasm core booted')

  // configure two accounts offline
  const setup = async name => {
    const id = await rpc('addAccount')
    await rpc('addTransportFromQr', id, QR)
    await rpc('setConfig', id, 'displayname', name)
    await rpc('startIo', id)
    return id
  }
  const aliceId = await setup('Alice Sender')
  const bobId = await setup('Bob Reader')

  // key exchange both ways + a chat alice -> bob
  const bobVcard = await rpc('makeVcard', bobId, [1])
  const [bobContact] = await rpc('importVcardContents', aliceId, bobVcard)
  const aliceVcard = await rpc('makeVcard', aliceId, [1])
  await rpc('importVcardContents', bobId, aliceVcard)
  const chat = await rpc('createChatByContactId', aliceId, bobContact)
  console.log(`OK: accounts alice=${aliceId} bob=${bobId}, chat ${chat}`)

  // alice sends the crafted HTML message (text = plaintext fallback, html =
  // the hostile payload); it travels e2e-encrypted and lands with has_html set
  await rpc('sendMsg', aliceId, chat, { text: FALLBACK_TEXT, html: CRAFTED_HTML, viewtype: 'Text' })
  console.log('OK: crafted HTML message sent')

  // bob receives it
  const found = await (async () => {
    const deadline = Date.now() + 120_000
    while (Date.now() < deadline) {
      for (const chatId of await rpc('getChatlistEntries', bobId, 0, null, null)) {
        for (const id of (await rpc('getMessageIds', bobId, chatId, false, false)).slice(-8)) {
          const msg = await rpc('getMessage', bobId, id).catch(() => null)
          if (msg?.text?.includes(FALLBACK_TEXT)) return { chatId, msgId: id, msg }
        }
      }
      await sleep(700)
    }
    throw new Error('crafted message never arrived on bob')
  })()
  console.log(`OK: bob received message ${found.msgId} in chat ${found.chatId}`)
  check(found.msg.hasHtml === true, 'received message reports hasHtml (Show Full Message button will render)')
  const gotHtml = await rpc('getMessageHtml', bobId, found.msgId)
  check(typeof gotHtml === 'string' && gotHtml.includes(BODY_TEXT), 'getMessageHtml returns the crafted HTML')
  await rpc('acceptChat', bobId, found.chatId) // clear the contact-request banner

  // reload so the app lands on a real account (chat list), not welcome; make
  // bob the persisted selection so the UI and our clicks agree
  await rpc('selectAccount', bobId)
  await sleep(3000) // let OPFS write-through flush before the reload tears down the worker
  await page.reload()
  await page.waitForFunction(() => window.__coreSystemInfo, null, { timeout: 120_000 })
  await page
    .locator('[data-testid^="selected-account:"]:not([data-testid="selected-account:undefined"])')
    .waitFor({ state: 'attached', timeout: 120_000 })

  // account ids may be renumbered by the boot self-heal after reload — resolve
  // both by display name
  const idByName = async name => {
    for (const id of await rpc('getAllAccountIds')) {
      const info = await rpc('getAccountInfo', id).catch(() => null)
      if (info?.displayName === name) return id
    }
    throw new Error(`no account named ${name} after reload`)
  }
  const bob = await idByName('Bob Reader')
  const alice = await idByName('Alice Sender')
  const bobItem = page.getByTestId(`account-item-${bob}`)
  await bobItem.waitFor({ state: 'visible', timeout: 60_000 })
  await bobItem.click()
  await page.getByTestId(`selected-account:${bob}`).waitFor({ state: 'attached', timeout: 30_000 })

  // open the chat holding our message (match by its plaintext preview)
  const chatItem = page.locator('.chat-list .chat-list-item').filter({ hasText: FALLBACK_TEXT }).first()
  await chatItem.waitFor({ state: 'visible', timeout: 60_000 })
  await chatItem.click()

  // the received HTML message shows the "Show Full Message…" button
  const showHtml = page.locator('.message .show-html').first()
  await showHtml.waitFor({ state: 'visible', timeout: 30_000 })
  check(true, '"Show Full Message…" button rendered on the received HTML message')

  // click it -> the in-app viewer dialog (narrow viewport) hosts the wrapper
  await showHtml.click()
  const wrapperSel = 'dialog iframe[src*="html-email.html"]'
  await page.locator(wrapperSel).waitFor({ state: 'attached', timeout: 30_000 })
  const wrapper = page.frameLocator(wrapperSel)
  await wrapper.locator('#frame-host iframe').waitFor({ state: 'attached', timeout: 30_000 })
  check(true, 'viewer opened with the sandboxed content frame')

  // reach into the blob: content frame (nested: dialog wrapper -> content)
  const contentFrame = await (async () => {
    const deadline = Date.now() + 30_000
    while (Date.now() < deadline) {
      for (const f of page.frames()) {
        if (f.url().startsWith('blob:')) {
          try {
            if (await f.$('#e2e-body')) return f
          } catch {
            /* frame navigating */
          }
        }
      }
      await sleep(250)
    }
    throw new Error('content blob frame with mail body never appeared')
  })()

  check(
    (await contentFrame.$eval('#e2e-body', e => e.textContent)) === BODY_TEXT,
    'mail body text rendered in the viewer'
  )
  check((await contentFrame.$$('script')).length === 0, 'crafted <script> stripped from the rendered mail')
  check(await page.evaluate(() => window.__e2ePwned === undefined), 'no crafted script executed (top window clean)')
  check(
    (await contentFrame.evaluate(() => {
      try {
        void window.top.location.href
        return 'reachable'
      } catch {
        return 'blocked'
      }
    })) === 'blocked',
    'content frame is cross-origin isolated from the app (opaque sandbox origin)'
  )

  // remote image blocked by default (authored CSP, before any opt-in)
  await sleep(500)
  check(
    remoteOutcome().length > 0 && remoteOutcome().every(o => o === 'csp'),
    `remote tracking image blocked, never reaches the network (saw: ${remoteOutcome().join(',') || 'no request'})`
  )

  // opt in via the ⋮ menu (mobile layout) -> "Always". A single click can race
  // the popover open (the click lands before the option is interactive and is
  // swallowed), so retry open+click until the control's state actually flips to
  // 'always' — that flip is what triggers the remote-allowed re-render.
  const opt = wrapper.locator('#menu button[data-state="always"]')
  const remoteSelect = wrapper.locator('#remote-select')
  let optedIn = false
  for (let i = 0; i < 8 && !optedIn; i++) {
    if (!(await opt.isVisible().catch(() => false))) {
      await wrapper.locator('#menu-btn').click().catch(() => {})
      await opt.waitFor({ state: 'visible', timeout: 3000 }).catch(() => {})
    }
    if (await opt.isVisible().catch(() => false)) await opt.click().catch(() => {})
    await sleep(300)
    optedIn = (await remoteSelect.inputValue().catch(() => '')) === 'always'
  }
  check(optedIn, 'remote-content control switched to "Always" via the ⋮ menu')
  // the re-render now loads with remote allowed; wait for the image request to
  // resolve to a real NETWORK outcome (net error — the .invalid host — or a
  // finished load), not 'csp' and not a transient 'pending' (a CSP-blocked
  // request is briefly 'pending' too, so 'pending' alone wouldn't prove it left
  // the CSP layer)
  const settled = o => o !== 'csp' && o !== 'pending'
  const optInDeadline = Date.now() + 12_000
  while (Date.now() < optInDeadline && !remoteOutcome().some(settled)) await sleep(200)
  check(
    remoteOutcome().some(settled),
    `remote image reached the network after opting in (saw: ${remoteOutcome().join(',')})`
  )

  // #3: an app link clicked inside the viewer must run under the account the
  // mail belongs to (bob), even after the user switches the MAIN app to another
  // account (alice). Spy on checkQr — processQr's first call — to see which
  // account it runs under (window.exp.rpc IS BackendRemote.rpc, what processQr
  // uses).
  await page.evaluate(() => {
    const rpc = window.exp.rpc
    const orig = rpc.checkQr.bind(rpc)
    window.__checkQrAccts = []
    rpc.checkQr = (accountId, ...a) => {
      window.__checkQrAccts.push(accountId)
      return orig(accountId, ...a)
    }
  })
  await page.evaluate(a => window.__selectAccount(a), alice)
  await page.waitForFunction(a => window.__selectedAccountId === a, alice, { timeout: 30_000 })
  // the invite link is in the (re-rendered) content frame — locate it afresh
  const inviteFrame = await (async () => {
    const deadline = Date.now() + 15_000
    while (Date.now() < deadline) {
      for (const f of page.frames()) {
        if (f.url().startsWith('blob:')) {
          try {
            if (await f.$('#e2e-invite')) return f
          } catch {
            /* frame navigating */
          }
        }
      }
      await sleep(200)
    }
    throw new Error('invite-link content frame not found')
  })()
  const [inviteRelay] = await Promise.all([
    context.waitForEvent('page'),
    inviteFrame.click('#e2e-invite'),
  ])
  // delivery is async: openAppLink(url, bob) sees selected=alice≠bob, switches
  // to bob, and the onOpenQrUrl re-bind flushes the pending url to processQr(bob)
  await page
    .waitForFunction(() => (window.__checkQrAccts || []).length > 0, { timeout: 20_000 })
    .catch(() => {})
  const accts = await page.evaluate(() => window.__checkQrAccts || [])
  // the definitive #3 check: processQr ran under bob (the mail's account),
  // NOT alice (the selected one). The main app is NOT force-switched — a bogus
  // invite triggers no selectChat; a valid mailto/invite would switch via its
  // own selectChat, under bob.
  check(
    accts.includes(bob) && !accts.includes(alice),
    `app link processed under originating account bob=${bob}, not selected alice=${alice} (checkQr accts: ${accts.join(',') || 'none'})`
  )
  if (!inviteRelay.isClosed()) await inviteRelay.waitForEvent('close', { timeout: 5000 }).catch(() => {})

  // #2 (regression guard for PR #157, which this branch's revert could silently
  // undo): opening a file attachment must not keep a window.opener handle back
  // onto the messenger tab — openPath opens with 'noopener'. Drive openPath with
  // a real self-chat file blob and assert the opened tab's opener is null.
  const selfChat = await rpc('createChatByContactId', bob, 1) // contact 1 = self
  const filePath = await page.evaluate(
    b64 => window.exp.runtime.writeTempFileFromBase64('note.txt', b64),
    Buffer.from('opener-check').toString('base64')
  )
  const fileMsgId = await rpc('sendMsg', bob, selfChat, {
    file: filePath,
    filename: 'note.txt',
    viewtype: 'File',
  })
  const fileMsg = await rpc('getMessage', bob, fileMsgId)
  const [attachmentTab] = await Promise.all([
    context.waitForEvent('page'),
    page.evaluate(p => window.exp.runtime.openPath(p), fileMsg.file),
  ])
  await attachmentTab.waitForLoadState().catch(() => {})
  check(
    await attachmentTab.evaluate(() => window.opener === null),
    'opened attachment tab has window.opener === null (#2 noopener survived the rebase)'
  )
  await attachmentTab.close().catch(() => {})
} catch (err) {
  console.error('FAIL: exception', err)
  failed++
} finally {
  clearTimeout(watchdog)
  await browser.close().catch(() => {})
  cleanup()
}

if (failed) {
  console.error(`${failed} check(s) FAILED`)
  process.exit(1)
}
console.log('html-email viewer e2e passed')
process.exit(0)
