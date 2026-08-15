// E2E check for the resizable chat-list sidebar (desktop/0061) — runs FULLY
// OFFLINE. One webimap account against an in-process mock madmail server
// (trimmed from scripts/test-export-chat-html.mjs) gets us to the two-pane
// MainScreen; then the actual feature is exercised: drag the divider and the
// sidebar follows (clamped), the width survives a reload via localStorage,
// ArrowRight on the focused handle grows it, double-click resets to the
// default flex split.
//
// Requires packages/core-wasm built and packages/web-app assembled+built.
// Run:  node scripts/test-sidebar-resize-e2e.mjs
// (CHROMIUM_BIN=/path/to/chrome overrides the playwright-managed browser.)
import { createServer } from 'node:http'
import { randomBytes } from 'node:crypto'
import { chromium } from 'playwright'
import { startServers } from './harness.mjs'

const APP_PORT = Number(process.env.APP_PORT ?? 8676)

// --- mock madmail server (no mail ever arrives; just enough to configure) ---
const users = new Map()
let userSeq = 0
const json = (res, code, obj) => {
  res.statusCode = code
  res.setHeader('content-type', 'application/json')
  res.end(JSON.stringify(obj))
}
const mock = createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Headers', 'X-Email, X-Password, Content-Type')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS')
  if (req.method === 'OPTIONS') {
    res.statusCode = 204
    res.end()
    return
  }
  const url = new URL(req.url, 'http://mock')
  if (req.method === 'POST' && url.pathname === '/new') {
    const email = `u${++userSeq}@webimap.example`
    const password = randomBytes(9).toString('hex')
    users.set(email, password)
    return json(res, 200, { email, password, dclogin_url: '' })
  }
  if (url.pathname.startsWith('/webimap/')) {
    const pw = users.get(req.headers['x-email'])
    if (!pw || pw !== req.headers['x-password']) {
      return json(res, 401, { error: 'bad credentials' })
    }
    if (url.pathname === '/webimap/mailboxes') {
      return json(res, 200, [{ name: 'INBOX', messages: 0, unseen: 0 }])
    }
    if (url.pathname === '/webimap/messages') {
      const wait = Math.min(Number(url.searchParams.get('wait') ?? '0') || 0, 25)
      setTimeout(() => json(res, 200, []), wait * 1000)
      return
    }
  }
  json(res, 404, { error: 'not found' })
})
await new Promise((r) => mock.listen(0, '127.0.0.1', r))
const QR = `webimapaccount:127.0.0.1:${mock.address().port}`

// --- web-app server ---
const { cleanup, watchdog } = await startServers({
  app: APP_PORT,
  settleMs: 700,
  watchdogMs: 300_000,
})

// --- browser ---
const launchOpts = process.env.CHROMIUM_BIN
  ? { executablePath: process.env.CHROMIUM_BIN }
  : {}
const browser = await chromium.launch(launchOpts)
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
page.on('pageerror', (e) => console.error('[pageerror]', e.message))
await page.addInitScript(() => {
  Object.defineProperty(window, 'eval', { value: window.eval, writable: false })
})
const rpc = (method, ...args) =>
  page.evaluate(([m, a]) => window.exp.rpc[m](...a), [method, args])

const handle = () => page.getByTestId('chat-list-resize-handle')
// the sidebar is the handle's previous sibling (CSS-module class, so no
// stable class selector)
const sidebarWidth = () =>
  page.evaluate(() =>
    Math.round(
      document
        .querySelector('[data-testid="chat-list-resize-handle"]')
        .previousElementSibling.getBoundingClientRect().width
    )
  )
const waitForMainScreen = async () => {
  await page.waitForFunction(() => window.__coreSystemInfo, null, { timeout: 120_000 })
  await handle().waitFor({ state: 'visible', timeout: 60_000 })
}
const assertNear = (actual, expected, what, tol = 5) => {
  if (Math.abs(actual - expected) > tol) {
    throw new Error(`FAIL: ${what}: expected ~${expected}, got ${actual}`)
  }
  console.log(`OK: ${what} = ${actual}`)
}

let failed = false
try {
  await page.goto(`http://localhost:${APP_PORT}/main.html`)
  await page.waitForFunction(() => window.__coreSystemInfo, null, { timeout: 120_000 })

  // one configured account; drop the auto-created unconfigured one so the
  // reload below lands on MainScreen instead of the welcome screen
  const aliceId = await rpc('addAccount')
  await rpc('addTransportFromQr', aliceId, QR)
  await rpc('setConfig', aliceId, 'displayname', 'Alice')
  for (const id of await rpc('getAllAccountIds')) {
    if (id !== aliceId) await rpc('removeAccount', id)
  }
  await rpc('selectAccount', aliceId)
  await page.reload()
  await waitForMainScreen()
  const defaultWidth = await sidebarWidth()
  console.log(`OK: MainScreen up, default sidebar width ${defaultWidth}`)

  // the account list sidebar sits left of MainScreen, so mouse x and sidebar
  // width differ by the pane's left edge — measure widths, not coordinates
  const sidebarLeft = await page.evaluate(() =>
    Math.round(
      document
        .querySelector('[data-testid="chat-list-resize-handle"]')
        .previousElementSibling.getBoundingClientRect().left
    )
  )
  const dragTo = async (x) => {
    const box = await handle().boundingBox()
    const y = box.y + 300
    await page.mouse.move(box.x + box.width / 2, y)
    await page.mouse.down()
    await page.mouse.move(x, y, { steps: 5 })
    await page.mouse.up()
  }

  // drag the divider → sidebar follows the pointer
  await dragTo(sidebarLeft + 500)
  assertNear(await sidebarWidth(), 500, 'sidebar width after drag')
  const stored = await page.evaluate(() => Number(localStorage.getItem('chatListWidth')))
  assertNear(stored, 500, 'persisted chatListWidth')

  // dragging far left clamps at the pane's min-width
  await dragTo(50)
  assertNear(await sidebarWidth(), 295, 'sidebar width clamped at min')

  // width survives a reload
  await dragTo(sidebarLeft + 500)
  await page.reload()
  await waitForMainScreen()
  assertNear(await sidebarWidth(), 500, 'sidebar width after reload')

  // keyboard: ArrowRight grows by 16px
  await handle().focus()
  await page.keyboard.press('ArrowRight')
  assertNear(await sidebarWidth(), 516, 'sidebar width after ArrowRight')

  // double-click resets to the default flex split and clears the pref
  await handle().dblclick()
  assertNear(await sidebarWidth(), defaultWidth, 'sidebar width after reset')
  const cleared = await page.evaluate(() => localStorage.getItem('chatListWidth'))
  if (cleared !== null) throw new Error(`FAIL: pref not cleared: ${cleared}`)
  console.log('OK: double-click reset cleared the stored width')

  console.log('PASS: resizable chat-list sidebar e2e')
} catch (e) {
  failed = true
  console.error(e)
} finally {
  clearTimeout(watchdog)
  await browser.close().catch(() => {})
  mock.close()
  cleanup()
}
process.exit(failed ? 1 : 0)
