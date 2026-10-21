// Screenshot + self-check harness for clickable reactions (desktop/1068) —
// runs FULLY OFFLINE like scripts/shot-requests-link.mjs: an in-process mock
// madmail server provides three webimap accounts.
//
// Alice, Carol and Bob share a group. Bob posts, Alice reacts 👍 and Carol
// reacts ❤️. In Bob's view, clicking Alice's 👍 pill joins it (the path
// test-context-menu-e2e can't reach with one account); clicking it again
// takes Bob's back. "More Info" behind the pills opens Message Info, which
// ends with the count per emoji and who reacted with what, kept live while
// it is open. Shots go to .cache/reaction-shots/.
//
// Requires packages/core-wasm built and packages/web-app assembled+built.
// Run:  node scripts/shot-reactions.mjs
// (CHROMIUM_BIN=/path/to/chrome overrides the playwright-managed browser.)
import { mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { startServers } from './harness.mjs'
import { startMockMadmail } from './mock-madmail.mjs'

const SHOTS = fileURLToPath(new URL('../.cache/reaction-shots/', import.meta.url))
await mkdir(SHOTS, { recursive: true })
const APP_PORT = 8677

const mock = await startMockMadmail()
const QR = `webimapaccount:127.0.0.1:${mock.port}`
const { cleanup, watchdog } = await startServers({
  app: APP_PORT,
  settleMs: 700,
  watchdogMs: 360_000,
})
const browser = await chromium.launch(
  process.env.CHROMIUM_BIN ? { executablePath: process.env.CHROMIUM_BIN } : {}
)
const page = await browser.newPage({ viewport: { width: 1100, height: 760 } })
page.on('pageerror', e => console.error('[pageerror]', e.message))
// The app replaces window.eval with a thrower; playwright's page.evaluate
// needs the real one, so pin it before any app script runs.
await page.addInitScript(() => {
  Object.defineProperty(window, 'eval', { value: window.eval, writable: false })
})
const rpc = (method, ...args) =>
  page.evaluate(([m, a]) => window.exp.rpc[m](...a), [method, args])
const until = async (fn, label) => {
  const deadline = Date.now() + 120_000
  while (Date.now() < deadline) {
    if (await fn()) return
    await new Promise(r => setTimeout(r, 300))
  }
  throw new Error(`timeout waiting for ${label}`)
}
const expect = (cond, msg) => {
  if (!cond) throw new Error(msg)
  console.log(`OK: ${msg}`)
}
const shot = async name => {
  await page.waitForTimeout(600)
  await page.screenshot({ path: `${SHOTS}/${name}.png` })
  console.log(`shot: ${SHOTS}/${name}.png`)
}

let failed = false
try {
  await page.goto(`http://localhost:${APP_PORT}/main.html`)
  await page.waitForFunction(() => window.__coreSystemInfo, null, { timeout: 120_000 })
  const setup = async name => {
    const id = await rpc('addAccount')
    await rpc('addTransportFromQr', id, QR)
    await rpc('setConfig', id, 'displayname', name)
    await rpc('startIo', id)
    return id
  }
  const aliceId = await setup('Alice Weber')
  const carolId = await setup('Carol Nguyen')
  const bobId = await setup('Bob Martinez')

  // Bob's group with Alice and Carol; each accepts it from their side.
  const group = await rpc('createGroupChat', bobId, 'Weekend Crew', false)
  for (const id of [aliceId, carolId]) {
    const [c] = await rpc('importVcardContents', bobId, await rpc('makeVcard', id, [1]))
    await rpc('addContactToChat', bobId, group, c)
  }
  const msg = await rpc('miscSendTextMessage', bobId, group, 'Hike on Saturday, 10am at the station?')
  const react = async (id, emoji) => {
    const requests = () => rpc('getChatlistEntries', id, 0, 'is:request', null)
    await until(async () => (await requests()).length, 'the group request')
    const [chat] = await requests()
    await rpc('acceptChat', id, chat)
    let m
    await until(async () => (m = (await rpc('getMessageIds', id, chat, false, false)).at(-1)), 'message')
    await rpc('sendReaction', id, m, [emoji])
  }
  await react(aliceId, '👍')
  await react(carolId, '❤️')
  const reactionsOf = async () => (await rpc('getMessage', bobId, msg)).reactions?.reactionsByContact ?? {}
  await until(async () => Object.keys(await reactionsOf()).length === 2, 'both reactions at Bob')

  // The accounts were created through rpc; reload so the UI picks them up.
  await page.reload()
  await page.locator('#new-chat-button').waitFor({ state: 'visible', timeout: 120_000 })
  if (!(await page.getByTestId(`selected-account:${bobId}`).count())) {
    await page.getByTestId(`account-item-${bobId}`).click()
    await page.getByTestId(`selected-account:${bobId}`).waitFor({ state: 'attached', timeout: 30_000 })
  }
  await page.locator('.chat-list-item', { hasText: 'Weekend Crew' }).first().click()
  const bubble = page.locator('.message', { hasText: 'Hike on Saturday' })
  // the pill, not its hover wrapper; its text grows a count ("👍2")
  const thumbs = bubble.locator('span', { hasText: '👍' }).last()
  await thumbs.waitFor({ timeout: 30_000 })
  await page.mouse.move(1000, 80)
  await shot('01-reactions')

  const mine = async () => (await reactionsOf())[1]?.[0]

  // A click inside the hover card (who reacted) is not a click on the pill.
  await thumbs.hover()
  await bubble.getByText('Alice Weber').click()
  await page.waitForTimeout(1500)
  expect((await mine()) === undefined, 'clicking a name in the hover card does not react')

  // Clicking someone else's pill joins it; clicking it again takes it back.
  await thumbs.click()
  await until(async () => (await mine()) === '👍', 'Bob joins 👍')
  expect(true, "clicking Alice's 👍 reacts 👍 as Bob")
  await bubble.getByText('2', { exact: true }).waitFor()
  await page.mouse.move(1000, 80)
  await shot('02-joined')
  await thumbs.click()
  await until(async () => (await mine()) === undefined, 'Bob takes 👍 back')
  expect(true, 'clicking it again takes the reaction back')
  expect(!(await page.locator('dialog[open]').count()), 'no dialog opened by pill clicks')

  // "More Info" opens Message Info with the reactions listed at its end.
  await rpc('sendReaction', bobId, msg, ['👍'])
  await bubble.getByText('2', { exact: true }).waitFor()
  await bubble.getByRole('button', { name: 'More Info' }).focus()
  await page.keyboard.press('Enter')
  const info = page.locator('dialog', { hasText: 'Message Info' })
  await info.locator('ul', { hasText: 'Carol Nguyen' }).waitFor({ timeout: 30_000 })
  expect((await info.locator('strong').last().textContent()) === 'Reactions', 'Message Info ends with Reactions')
  for (const name of ['Alice Weber', 'Carol Nguyen', 'Me']) {
    expect(await info.locator('ul').getByText(name).count(), `lists ${name}`)
  }
  // plain rows, not upstream's pills that toggled your reaction
  const counts = async () => (await info.locator('li', { hasText: / reactions?$/ }).allTextContents()).join()
  expect((await counts()) === '👍2 reactions,❤️1 reaction', 'counts per emoji, most used first')
  expect(!(await info.getByRole('menuitemradio').count()), 'no reaction pills in Message Info')
  await shot('03-message-info')

  // It stays live: Bob takes his 👍 back from elsewhere while it is open.
  await rpc('sendReaction', bobId, msg, [])
  // (a tie is ordered by core, not by us)
  await until(async () => (await counts()).split(',').sort().join() === '❤️1 reaction,👍1 reaction', 'the counts to update')
  await until(async () => !(await info.locator('ul').getByText('Me', { exact: true }).count()), 'Me to leave the list')
  expect(true, 'Message Info updates live when a reaction changes')

  console.log('PASS: clickable reactions work as expected')
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
