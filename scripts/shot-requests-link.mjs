// Screenshot + self-check harness for the requests link (desktop/1066,
// core/1025) — runs FULLY OFFLINE like scripts/shot-download-placeholder.mjs:
// an in-process mock madmail server provides three webimap accounts.
//
// Bob has a real conversation with Alice (accepted). Mallory, whom Bob has
// never accepted, then keeps cloning a "Weekend Crew" group and adding Bob.
// Each clone is a contact request, so instead of five lookalike rows Bob's
// chat list shows one "Requests" entry on top carrying the count; clicking it
// opens the Requests view with the clones.
//
// It also drives the side paths: Ctrl+PageDown with no chat open must open
// a real chat, not the link; the unread filter hides requests and the link;
// Accept and Delete in the request bar move one out of Requests and drop the
// count while the view stays open; and accepting the rest leaves the view
// showing its empty note. Shots go to .cache/requests-shots/.
//
// Not covered: notifications. Webimap accounts (what the mock serves) never
// get core's IncomingMsgBunch, which is what flushes queued notifications.
//
// It asserts what the shots show, so it doubles as the runnable check for
// the requests link UI.
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
    hasText: 'Requests',
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
    (await link.getAttribute('aria-label')) === `Requests: ${CLONES}`,
    `link reads "Requests: ${CLONES}"`
  )
  expect(
    (await items.filter({ hasText: 'Weekend Crew' }).count()) === 0,
    'no clone rows in the chat list'
  )
  await shot('01-chat-list')
  const chatName = page.locator('.navbar-chat-name')

  // 1b. Keyboard: "next chat" with nothing open must skip the link (id 8)
  // and open the first real chat; "previous chat" must not go back onto it.
  expect((await chatName.count()) === 0, 'no chat open yet')
  await page.keyboard.press('Control+PageDown')
  await chatName.first().waitFor({ timeout: 30_000 })
  const firstName = (await chatName.first().innerText()).split('\n')[0].trim()
  expect(
    firstName !== '' && !/rsvd|Requests/.test(firstName),
    `Ctrl+PageDown opened a real chat ("${firstName}"), not the link`
  )
  await page.keyboard.press('Control+PageUp')
  await page.waitForTimeout(800)
  expect(
    (await chatName.first().innerText()).split('\n')[0].trim() === firstName,
    'Ctrl+PageUp from the first chat stays put'
  )

  // 1c. The unread filter keeps requests (and the link) out; off brings it back.
  const unreadToggle = page.getByRole('button', { name: 'Unread' })
  await unreadToggle.click()
  await link.waitFor({ state: 'detached', timeout: 30_000 })
  expect(
    (await items.filter({ hasText: 'Weekend Crew' }).count()) === 0,
    'unread filter: no link, no clone rows'
  )
  await unreadToggle.click()
  await link.waitFor({ state: 'visible', timeout: 30_000 })
  expect(true, 'unread filter off: link is back')

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

  // 5. Accept one from the UI: it leaves Requests, the view stays open.
  const clones = items.filter({ hasText: 'Weekend Crew' })
  await link.click()
  await clones.nth(CLONES - 1).waitFor()
  await clones.first().click()
  await page.locator('.contact-request-button.accept').click()
  await until(
    async () => (await clones.count()) === CLONES - 1,
    'the accepted request to leave the list'
  )
  expect(true, `UI accept: ${CLONES - 1} requests left`)
  // In Requests the header has the back button and the link row is gone.
  expect(
    (await page.locator('.backButton').count()) > 0 &&
      (await link.count()) === 0,
    'UI accept: still in the Requests view'
  )

  // 6. Delete one from the UI (groups ask for confirmation).
  await clones.first().click()
  await page.locator('.contact-request-button.delete').click()
  await page.getByTestId('confirm').click()
  await until(
    async () => (await clones.count()) === CLONES - 2,
    'the deleted request to leave the list'
  )
  expect(true, `UI delete: ${CLONES - 2} requests left`)

  // 7. Back in the chats: the count dropped, the accepted clone is a chat.
  await page.locator('.backButton').first().click()
  await until(
    async () =>
      (await link.getAttribute('aria-label').catch(() => null)) ===
      `Requests: ${CLONES - 2}`,
    `the link to read "Requests: ${CLONES - 2}"`
  )
  expect(true, `link reads "Requests: ${CLONES - 2}"`)
  expect(
    (await clones.count()) === 1,
    'the accepted clone is now a normal chat'
  )
  await shot('05-after-accept-and-delete')

  // 8. Accept the rest from inside the Requests view: it says it's empty.
  await link.click()
  await clones.first().waitFor()
  for (const id of await rpc('getChatlistEntries', bobId, 0, 'is:request', null)) {
    await rpc('acceptChat', bobId, id)
  }
  await page
    .getByText('No requests.', { exact: false })
    .waitFor({ timeout: 30_000 })
  expect(true, 'empty Requests view says so')
  await shot('06-requests-empty')

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
