// E2E check for the SlothfulChat welcome device message (desktop/0078) and the
// dropped upstream welcome image (core/0029) — runs FULLY OFFLINE. One webimap
// account is created through the real onboarding UI against an in-process mock
// madmail server (trimmed from scripts/test-sidebar-resize-e2e.mjs) — that path
// enters the main screen without going through selectAccount(), which is what
// used to hold the message back until the next app start; then the device chat
// is read back over rpc.
//
// Requires packages/core-wasm built and packages/web-app assembled+built.
// Run:  node scripts/test-welcome-message-e2e.mjs
// (CHROMIUM_BIN=/path/to/chrome overrides the playwright-managed browser.)
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'
import { chromium } from 'playwright'

const script = (p) => fileURLToPath(new URL(p, import.meta.url))
const APP_PORT = Number(process.env.APP_PORT ?? 8679)

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
const appServer = spawn('node', [script('../packages/web-app/serve.mjs')], {
  env: { ...process.env, PORT: String(APP_PORT) },
  stdio: 'inherit',
})
const cleanup = () => appServer.kill()
process.on('exit', cleanup)
const watchdog = setTimeout(() => {
  console.error('FAIL: watchdog (5 min)')
  cleanup()
  process.exit(1)
}, 300_000)
await new Promise((r) => setTimeout(r, 700))

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

// the device chat is not reachable via getChatIdByContactId in this core
// (ContactId::DEVICE has no chats_contacts row), so pick it off the chatlist
const deviceChatMessages = async (accountId) => {
  let chatId = null
  for (const id of await rpc('getChatlistEntries', accountId, 0, null, null)) {
    const info = await rpc('getBasicChatInfo', accountId, id)
    if (info.isDeviceChat) chatId = id
  }
  if (!chatId) throw new Error('FAIL: no device chat')
  const items = await rpc('getMessageListItems', accountId, chatId, false, false)
  const msgs = []
  for (const item of items) {
    // MessageListItem keeps snake_case on the wire
    if (item.kind === 'message') {
      msgs.push(await rpc('getMessage', accountId, item.msg_id))
    }
  }
  return msgs
}

let failed = false
try {
  await page.goto(`http://localhost:${APP_PORT}/main.html`)
  await page.waitForFunction(() => window.__coreSystemInfo, null, { timeout: 120_000 })

  // Real onboarding, through the UI — an rpc shortcut plus a reload would go
  // in through selectAccount() at boot and hide the case that matters: instant
  // onboarding jumps to the main screen on its own, and the message has to be
  // there in that same session, not after a restart.
  await page
    .getByRole('button', { name: /madmail server/ })
    .click({ timeout: 60_000 })
  await page.locator('#webimapHost').fill(`127.0.0.1:${mock.address().port}`)
  await page.getByRole('button', { name: 'Use this server' }).click()
  await page.locator('#displayName').fill('Alice')
  await page.getByTestId('login-button').click()
  await page.locator('#new-chat-button').waitFor({ state: 'visible', timeout: 120_000 })
  const aliceId = await page.evaluate(() => window.__selectedAccountId)
  if (!aliceId) throw new Error('FAIL: no account after onboarding')
  console.log(`OK: onboarded account ${aliceId} through the UI`)

  const msgs = await deviceChatMessages(aliceId)
  const welcomeIndex = msgs.findIndex((m) =>
    (m.text || '').includes('runs entirely in your web browser')
  )
  if (welcomeIndex === -1) {
    throw new Error(
      `FAIL: no SlothfulChat welcome message in the device chat (${msgs.length} message(s): ` +
        msgs.map((m) => `${m.viewType}:${(m.text || '').slice(0, 40)}`).join(' | ') +
        ')'
    )
  }
  console.log('OK: welcome message present')

  // it has to sit *after* core's own welcome message, which core adds during
  // configure() — ours is deliberately not added at account-creation time
  if (welcomeIndex === 0) {
    throw new Error("FAIL: welcome message came before core's welcome message")
  }
  console.log(`OK: added after core's welcome message (index ${welcomeIndex})`)

  // core/0029: the Delta Chat branded welcome image is gone
  const image = msgs.find((m) => m.viewType === 'Image')
  if (image) {
    throw new Error(`FAIL: device chat still carries an image message (${image.fileName})`)
  }
  console.log('OK: no upstream welcome image')

  // the label makes re-adding a no-op — a second app start (which enters the
  // main screen again) must not append the message twice
  await page.reload()
  await page.waitForFunction(() => window.__coreSystemInfo, null, { timeout: 120_000 })
  await page.locator('#new-chat-button').waitFor({ state: 'visible', timeout: 60_000 })
  const again = await deviceChatMessages(aliceId)
  if (again.length !== msgs.length) {
    throw new Error(
      `FAIL: device chat grew on restart (${msgs.length} -> ${again.length})`
    )
  }
  console.log('OK: a restart does not add it twice')

  console.log('OK: welcome device message verified')
} catch (err) {
  console.error(err.message)
  failed = true
} finally {
  clearTimeout(watchdog)
  await browser.close()
  cleanup()
  mock.close()
}
process.exit(failed ? 1 : 0)
