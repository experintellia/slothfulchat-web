// E2E check for right-click menus (desktop/0034) — runs FULLY OFFLINE. One
// webimap account against an in-process mock madmail server (trimmed from
// scripts/test-sidebar-resize-e2e.mjs), one group with a webxdc app in it.
//
// The browser draws its own context menu unless the contextmenu event is
// cancelled before dispatch finishes, so a handler that awaits first (the
// chat list did) or never cancels (the chat-header app icon button did — only
// its <img> did) shows both menus stacked. Electron only draws a native menu
// for selected text, editable fields, images and links, so upstream never
// sees this. Real input, checked from a window listener that runs after
// React's:
//
//   1. right-click a chat-list row → app menu opens, native menu cancelled
//   2. context-menu KEY on a focused app icon → same. A mouse can't tell the
//      fix apart: the <img> fills the button, and it always cancelled. The
//      key targets the button itself, the path that showed both menus.
//   3. right-click a selected profile name → native menu NOT cancelled (its
//      Copy is the only way to copy a group name; an app-wide suppressor
//      would kill it)
//
// Requires packages/core-wasm built and packages/web-app assembled+built.
// Run:  node scripts/test-context-menu-e2e.mjs
// (CHROMIUM_BIN=/path/to/chrome overrides the playwright-managed browser.)
import { createServer } from 'node:http'
import { randomBytes } from 'node:crypto'
import { crc32 } from 'node:zlib'
import { chromium } from 'playwright'
import { startServers } from './harness.mjs'

const APP_PORT = Number(process.env.APP_PORT ?? 8677)

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

// A minimal .xdc: an uncompressed ("stored") zip of index.html + manifest.
// ponytail: hand-rolled stored zip, no zip dependency needed for two tiny files
function storedZip(files) {
  const locals = []
  const centrals = []
  let offset = 0
  for (const [name, text] of Object.entries(files)) {
    const nameBuf = Buffer.from(name)
    const data = Buffer.from(text)
    const crc = crc32(data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4) // version needed
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4) // version made by
    central.writeUInt16LE(20, 6) // version needed
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(data.length, 20)
    central.writeUInt32LE(data.length, 24)
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
const xdcBase64 = storedZip({
  'manifest.toml': 'name = "Poll"\n',
  'index.html': '<!doctype html><title>Poll</title>poll',
}).toString('base64')

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
  // Window bubble phase runs after React's root listener, so this sees what
  // the browser sees when deciding whether to draw its own menu.
  window.__contextmenus = []
  window.addEventListener('contextmenu', (e) => {
    window.__contextmenus.push(e.defaultPrevented)
  })
})
const rpc = (method, ...args) =>
  page.evaluate(([m, a]) => window.exp.rpc[m](...a), [method, args])

const GROUP = 'Design Team'
const appMenu = () => page.locator('[role="menu"]')

// Run `open` (some real input that raises a context menu); return whether
// the native menu was cancelled.
const contextMenuVia = async (open) => {
  await page.evaluate(() => (window.__contextmenus = []))
  await open()
  const seen = await page.evaluate(() => window.__contextmenus)
  if (seen.length !== 1) throw new Error(`expected 1 contextmenu event, got ${seen.length}`)
  return seen[0]
}
const rightClick = (locator) => contextMenuVia(() => locator.click({ button: 'right' }))
const check = (ok, what) => {
  if (!ok) throw new Error(`FAIL: ${what}`)
  console.log(`OK: ${what}`)
}

let failed = false
try {
  await page.goto(`http://localhost:${APP_PORT}/main.html`)
  await page.waitForFunction(() => window.__coreSystemInfo, null, { timeout: 120_000 })

  // one configured account; drop the auto-created unconfigured one so the
  // reload lands on MainScreen
  let aliceId = await rpc('addAccount')
  await rpc('addTransportFromQr', aliceId, QR)
  await rpc('setConfig', aliceId, 'displayname', 'Alice')
  for (const id of await rpc('getAllAccountIds')) {
    if (id !== aliceId) await rpc('removeAccount', id)
  }
  await rpc('selectAccount', aliceId)
  await page.reload()
  await page.waitForFunction(() => window.__coreSystemInfo, null, { timeout: 120_000 })

  // Seed AFTER the reload: core writes reach OPFS through an async flusher,
  // so data written just before a reload can be lost with the old worker.
  // The UI picks these up live from core events instead. The account id can
  // change across the reload; it is the only account, so take it from core.
  ;[aliceId] = await rpc('getAllAccountIds')
  const groupId = await rpc('createGroupChat', aliceId, GROUP, false)
  const xdcPath = await page.evaluate(
    (b64) => window.exp.runtime.writeTempFileFromBase64('poll.xdc', b64),
    xdcBase64
  )
  const xdcMsgId = await rpc('sendMsg', aliceId, groupId, {
    file: xdcPath,
    filename: 'poll.xdc',
    viewtype: 'Webxdc',
  })
  // core silently downgrades an archive it can't read to a plain File
  const { viewType } = await rpc('getMessage', aliceId, xdcMsgId)
  check(viewType === 'Webxdc', `the seeded app is a webxdc (got ${viewType})`)

  // 1. chat-list row: its handler awaits the chat before opening the menu,
  //    so it must cancel the native one synchronously first
  const row = page.locator('.chat-list-item', { hasText: GROUP })
  await row.waitFor({ state: 'visible', timeout: 60_000 })
  check(await rightClick(row), 'chat-list row cancels the native menu')
  await appMenu().waitFor({ state: 'visible', timeout: 10_000 })
  check(true, 'chat-list row opens the app menu')
  await page.keyboard.press('Escape')
  await appMenu().waitFor({ state: 'hidden' })

  // 2. chat-header app icon, via the keyboard's context-menu key (see top)
  await row.click()
  const icon = page.getByTestId('last-used-apps').getByRole('button').first()
  await icon.waitFor({ state: 'visible', timeout: 60_000 })
  await icon.focus()
  check(
    await contextMenuVia(() => page.keyboard.press('ContextMenu')),
    'app icon (context-menu key) cancels the native menu'
  )
  await appMenu().waitFor({ state: 'visible', timeout: 10_000 })
  check(true, 'app icon opens the app menu')
  await page.keyboard.press('Escape')
  await appMenu().waitFor({ state: 'hidden' })

  // 3. selected group name in the profile: no app menu there, so the
  //    browser's menu (with Copy) must survive
  await page.getByTestId('chat-info-button').click()
  const name = page.getByTestId('profile-display-name')
  await name.waitFor({ state: 'visible', timeout: 30_000 })
  await name.selectText()
  check(!(await rightClick(name)), 'selected profile name keeps the native menu')
  check(!(await appMenu().isVisible()), 'no app menu over the profile name')

  console.log('PASS: right-click menus — app menu where the app owns one, native elsewhere')
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
