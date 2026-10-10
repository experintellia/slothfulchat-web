// Screenshot + self-check harness for the requests link (desktop/0091,
// core/0036) — runs FULLY OFFLINE like scripts/shot-download-placeholder.mjs:
// an in-process mock madmail server provides three webimap accounts.
//
// Bob has a real conversation with Alice (accepted). Mallory, whom Bob has
// never accepted, then keeps cloning a "Weekend Crew" group and adding Bob.
// Each clone is a contact request, so instead of five lookalike rows Bob's
// chat list shows one "Request" entry on top carrying the count; clicking it
// opens the Requests view with the clones.
//
// Shots go to .cache/requests-shots/. It also asserts what the shots show, so
// it doubles as the runnable check for the requests link UI.
//
// Requires packages/core-wasm built and packages/web-app assembled+built.
// Run:  node scripts/shot-requests-link.mjs
// (CHROMIUM_BIN=/path/to/chrome overrides the playwright-managed browser.)
import { mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { startServers } from './harness.mjs'
import { startMockMadmail } from './mock-madmail.mjs'

const script = p => fileURLToPath(new URL(p, import.meta.url))
const SHOTS = script('../.cache/requests-shots/')
await mkdir(SHOTS, { recursive: true })
const APP_PORT = 8677
const CLONES = 5

const mock = await startMockMadmail()
console.log(`mock madmail on 127.0.0.1:${mock.port}`)
const QR = `webimapaccount:127.0.0.1:${mock.port}`

const { cleanup, watchdog } = await startServers({
  app: APP_PORT,
  settleMs: 700,
  watchdogMs: 360_000,
})

const browser = await chromium.launch(
  process.env.CHROMIUM_BIN ? { executablePath: process.env.CHROMIUM_BIN } : {}
)
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
page.on('console', m => {
  if (/panicked at/.test(m.text())) console.error('[page PANIC]', m.text())
})
page.on('pageerror', e => console.error('[pageerror]', e.message))
// The app replaces window.eval with a thrower; playwright's page.evaluate
// needs the real one, so pin it before any app script runs.
await page.addInitScript(() => {
  Object.defineProperty(window, 'eval', { value: window.eval, writable: false })
})
const rpc = (method, ...args) =>
  page.evaluate(([m, a]) => window.exp.rpc[m](...a), [method, args])

const until = async (fn, label) => {
  const deadline = Date.now() + 180_000
  while (Date.now() < deadline) {
    if (await fn()) return
    await new Promise(r => setTimeout(r, 600))
  }
  throw new Error(`timeout waiting for ${label}`)
}

let failed = false
try {
  await page.goto(`http://localhost:${APP_PORT}/main.html`)
  await page.waitForFunction(() => window.__coreSystemInfo, null, {
    timeout: 120_000,
  })
  console.log('OK: wasm core booted')

  const setup = async name => {
    const id = await rpc('addAccount')
    await rpc('addTransportFromQr', id, QR)
    await rpc('setConfig', id, 'displayname', name)
    await rpc('startIo', id)
    return id
  }
  const aliceId = await setup('Alice Weber')
  const malloryId = await setup('Mallory')
  const bobId = await setup('Bob Martinez')
  console.log(`OK: accounts alice=${aliceId} mallory=${malloryId} bob=${bobId}`)

  const bobVcard = await rpc('makeVcard', bobId, [1])
  const [bobAtAlice] = await rpc('importVcardContents', aliceId, bobVcard)
  const [bobAtMallory] = await rpc('importVcardContents', malloryId, bobVcard)

  // A real conversation Bob has accepted.
  const dm = await rpc('createChatByContactId', aliceId, bobAtAlice)
  await rpc('miscSendTextMessage', aliceId, dm, 'Saturday at 10 still works?')
  await until(
    async () => (await rpc('getChatlistEntries', bobId, 0, 'is:request', null)).length === 1,
    "Alice's message"
  )
  const [aliceChat] = await rpc('getChatlistEntries', bobId, 0, 'is:request', null)
  await rpc('acceptChat', bobId, aliceChat)
  await rpc('miscSendTextMessage', bobId, aliceChat, 'Yes, see you there!')

  // Mallory clones the group again and again.
  for (let i = 0; i < CLONES; i++) {
    const g = await rpc('createGroupChat', malloryId, 'Weekend Crew', false)
    await rpc('addContactToChat', malloryId, g, bobAtMallory)
    await rpc('miscSendTextMessage', malloryId, g, 'this is the real one 😈')
  }
  await until(
    async () =>
      (await rpc('getChatlistEntries', bobId, 0, 'is:request', null)).length === CLONES,
    `${CLONES} cloned-group requests`
  )
  console.log(`OK: bob has ${CLONES} requests`)

  // The accounts were created through the rpc escape hatch, so the UI is
  // still sitting on the onboarding dialog until a reload.
  await page.reload()
  await page
    .locator('#new-chat-button')
    .waitFor({ state: 'visible', timeout: 120_000 })
  if (!(await page.getByTestId(`selected-account:${bobId}`).count())) {
    const item = page.getByTestId(`account-item-${bobId}`)
    await item.waitFor({ state: 'visible', timeout: 60_000 })
    await item.click()
    await page
      .getByTestId(`selected-account:${bobId}`)
      .waitFor({ state: 'attached', timeout: 30_000 })
  }
  await page.mouse.move(1000, 100)

  const items = page.locator('.chat-list .chat-list-item')
  const link = page.locator('.chat-list .archive-link-item', {
    hasText: 'Request',
  })
  const shot = async name => {
    await page.waitForTimeout(800)
    await page.screenshot({ path: `${SHOTS}/${name}.png` })
    console.log(`shot: ${SHOTS}/${name}.png`)
  }
  const expect = (cond, msg) => {
    if (!cond) throw new Error(msg)
    console.log(`OK: ${msg}`)
  }

  // 1. The chat list: one link instead of five clones.
  await link.waitFor({ state: 'visible', timeout: 60_000 })
  await page.locator('.chat-list-item', { hasText: 'Alice' }).first().waitFor()
  expect(
    (await link.getAttribute('aria-label')) === `Request: ${CLONES}`,
    `link reads "Request: ${CLONES}"`
  )
  expect(
    (await items.filter({ hasText: 'Weekend Crew' }).count()) === 0,
    'no clone rows in the chat list'
  )
  await shot('01-chat-list')

  // 2. The Requests view.
  await link.click()
  await items
    .filter({ hasText: 'Weekend Crew' })
    .nth(CLONES - 1)
    .waitFor({ timeout: 30_000 })
  expect(
    (await items.filter({ hasText: 'Weekend Crew' }).count()) === CLONES,
    `requests view lists ${CLONES} clones`
  )
  await shot('02-requests-view')

  // 3. One request opened: the usual accept/block bar.
  await items.filter({ hasText: 'Weekend Crew' }).first().click()
  await page.mouse.move(1000, 100)
  await shot('03-request-opened')

  // 4. Back to the chats: still calm.
  await page.locator('.backButton').first().click()
  await link.waitFor({ state: 'visible', timeout: 30_000 })
  await shot('04-back-to-chats')

  console.log('PASS: the requests link renders as expected')
} catch (err) {
  failed = true
  console.error('FAIL:', err)
  await page.screenshot({ path: `${SHOTS}/failure.png` }).catch(() => {})
} finally {
  clearTimeout(watchdog)
  await browser.close().catch(() => {})
  mock.close()
  cleanup()
}
process.exit(failed ? 1 : 0)
