// E2E check for PR #117: experimental estimated time-to-read on the unread
// badge. Two accounts; bob sends alice ~450 words unread; alice enables the
// experimental setting via the settings UI and the chat-list item must show
// "~2 min" next to the unread counter.
//
// Modeled on scripts/test-web-app-e2e.mjs (servers, eval fix, login flow).
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const script = p => fileURLToPath(new URL(p, import.meta.url))
const PROXY_PORT = Number(process.env.PROXY_PORT ?? 8651)
const APP_PORT = Number(process.env.APP_PORT ?? 8652)
const CHATMAIL_NEW = process.env.CHATMAIL_NEW ?? 'https://nine.testrun.org/new'

async function newAccount() {
  const resp = await fetch(CHATMAIL_NEW, { method: 'POST' })
  if (!resp.ok) throw new Error(`account creation failed: ${resp.status}`)
  return resp.json()
}
const [alice, bob] = await Promise.all([newAccount(), newAccount()])
console.log(`created accounts alice=${alice.email} bob=${bob.email}`)

const proxy = spawn('node', [script('../packages/ws-tcp-proxy/ws-tcp-proxy.mjs')], {
  env: { ...process.env, PORT: String(PROXY_PORT) },
  stdio: 'inherit',
})
const appServer = spawn('node', [script('../packages/web-app/serve.mjs')], {
  env: { ...process.env, PORT: String(APP_PORT) },
  stdio: 'inherit',
})
const procs = [proxy, appServer]
const cleanup = () => procs.forEach(p => p.kill())
process.on('exit', cleanup)
const watchdog = setTimeout(() => {
  console.error('FAIL: global watchdog (8 min) — test hung')
  cleanup()
  process.exit(1)
}, 480_000)
await new Promise(r => setTimeout(r, 500))

const browser = await chromium.launch()
const page = await browser.newPage()
const consoleTail = []
page.on('console', m => consoleTail.push(m.text().slice(0, 500)))
page.on('pageerror', e => console.error('[pageerror]', e.message))
await page.addInitScript(() => {
  Object.defineProperty(window, 'eval', { value: window.eval, writable: false })
})

const rpc = (method, ...args) =>
  page.evaluate(([m, a]) => window.exp.rpc[m](...a), [method, args])

async function loginViaUI({ email, password }, { firstAccount }) {
  if (!firstAccount) {
    const add = page.getByTestId('add-account-button')
    await add.hover()
    await add.click()
  }
  const create = page.getByTestId('create-account-button')
  const other = page.getByTestId('other-login-button')
  await create.or(other).first().waitFor({ state: 'visible', timeout: 90_000 })
  if (await create.isVisible()) await create.click()
  await other.click()
  await page.getByTestId('manual-email-login').click()
  await page.locator('#addr').fill(email)
  await page.locator('#password').fill(password)
  await page.getByTestId('login-with-credentials').click()
  await page
    .locator('#new-chat-button')
    .waitFor({ state: 'visible', timeout: 150_000 })
  const id = await page.evaluate(() => window.__selectedAccountId)
  if (!id) throw new Error(`no selected account after login of ${email}`)
  console.log(`OK: UI login ${email} -> account ${id}`)
  return id
}

async function switchToProfile(accountId) {
  const item = page.getByTestId(`account-item-${accountId}`)
  await item.hover()
  await item.click()
  await page
    .getByTestId(`selected-account:${accountId}`)
    .waitFor({ state: 'attached', timeout: 30_000 })
  await page.mouse.move(600, 400)
  console.log(`OK: switched to account ${accountId} via sidebar`)
}

let failed = false
try {
  await page.goto(
    `http://localhost:${APP_PORT}/main.html?proxy=ws://localhost:${PROXY_PORT}`
  )
  await page.waitForFunction(() => window.__coreSystemInfo, null, {
    timeout: 120_000,
  })
  console.log('OK: wasm core booted')

  const aliceId = await loginViaUI(alice, { firstAccount: true })
  const bobId = await loginViaUI(bob, { firstAccount: false })

  // key exchange both ways; alice creates + accepts her chat with bob so her
  // chat-list item is not a contact request (the badge is hidden on those)
  await rpc('startIo', aliceId)
  await rpc('startIo', bobId)
  const bobVcard = await rpc('makeVcard', bobId, [1])
  const [bobContactId] = await rpc('importVcardContents', aliceId, bobVcard)
  await rpc('createChatByContactId', aliceId, bobContactId)
  const aliceVcard = await rpc('makeVcard', aliceId, [1])
  const [aliceContactId] = await rpc('importVcardContents', bobId, aliceVcard)
  const bobChatId = await rpc('createChatByContactId', bobId, aliceContactId)
  console.log('OK: rpc — key exchange + chats created')

  // bob -> alice: 3 messages x 150 words = 450 words = 135 s at 200 wpm
  // -> label "~2 min" (rounding-robust, distinguishable from the ~1 min floor)
  const words = Array(150).fill('word').join(' ')
  for (let i = 0; i < 3; i++) {
    await rpc('miscSendTextMessage', bobId, bobChatId, `${i}: ${words}`)
  }
  console.log('OK: bob sent 3x150 words')

  // alice: wait for the unread counter on bob's chat-list item
  await switchToProfile(aliceId)
  const bobChatItem = page
    .locator('.chat-list .chat-list-item')
    .filter({ hasText: bob.email })
    .first()
  await bobChatItem.waitFor({ state: 'visible', timeout: 30_000 })
  await bobChatItem
    .locator('.fresh-message-counter')
    .filter({ hasText: '3' })
    .waitFor({ state: 'visible', timeout: 150_000 })
  console.log('OK: alice sees 3 unread from bob')

  // no badge while the experimental setting is off
  if ((await bobChatItem.locator('.unread-read-time').count()) !== 0) {
    throw new Error('badge visible although setting is off')
  }

  // enable via the real settings UI: sidebar gear -> Advanced -> switch label
  await page.getByTestId('open-settings-button').click()
  await page.getByTestId('open-advanced-settings').click()
  await page.getByText('Estimated read time on unread badge').click()
  await page.keyboard.press('Escape') // close settings dialog
  console.log('OK: experimental setting enabled via settings UI')

  const badge = bobChatItem.locator('.unread-read-time')
  await badge.waitFor({ state: 'visible', timeout: 30_000 })
  const label = (await badge.innerText()).trim()
  console.log(`badge label: "${label}"`)
  if (label !== '~2 min') throw new Error(`expected "~2 min", got "${label}"`)

  await page.screenshot({ path: '/tmp/read-time-badge.png' })
  console.log('OK: read-time badge e2e passed (screenshot /tmp/read-time-badge.png)')
} catch (err) {
  console.error('FAIL:', err.message)
  await page.screenshot({ path: '/tmp/read-time-fail.png' }).catch(() => {})
  console.error('--- last page console lines ---')
  console.error(consoleTail.slice(-60).join('\n'))
  failed = true
} finally {
  clearTimeout(watchdog)
  await browser.close()
  cleanup()
}
process.exit(failed ? 1 : 0)
