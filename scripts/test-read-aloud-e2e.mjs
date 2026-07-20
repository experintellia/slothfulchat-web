// E2E check for the read-aloud message action (browser TTS, experimental).
// One account; a message in Saved Messages; window.speechSynthesis is replaced
// with a spy before the app loads (headless chromium has no real voices).
// Asserts: no menu item while the setting is off; after enabling it via the
// settings UI, "Read aloud" speaks the message text, and "Stop reading aloud"
// appears only while speaking and cancels.
//
// Modeled on scripts/test-read-time-e2e.mjs (servers, eval fix, login flow).
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const script = p => fileURLToPath(new URL(p, import.meta.url))
const PROXY_PORT = Number(process.env.PROXY_PORT ?? 8661)
const APP_PORT = Number(process.env.APP_PORT ?? 8662)
const CHATMAIL_NEW = process.env.CHATMAIL_NEW ?? 'https://nine.testrun.org/new'

const resp = await fetch(CHATMAIL_NEW, { method: 'POST' })
if (!resp.ok) throw new Error(`account creation failed: ${resp.status}`)
const alice = await resp.json()
console.log(`created account alice=${alice.email}`)

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
  console.error('FAIL: global watchdog (6 min) — test hung')
  cleanup()
  process.exit(1)
}, 360_000)
await new Promise(r => setTimeout(r, 500))

const browser = await chromium.launch()
const page = await browser.newPage()
const consoleTail = []
page.on('console', m => consoleTail.push(m.text().slice(0, 500)))
page.on('pageerror', e => console.error('[pageerror]', e.message))
await page.addInitScript(() => {
  Object.defineProperty(window, 'eval', { value: window.eval, writable: false })
  // speechSynthesis spy: records spoken texts/cancels, controllable .speaking
  const spy = {
    spoken: [],
    cancels: 0,
    speaking: false,
    speak(u) {
      this.spoken.push(u.text)
    },
    cancel() {
      this.cancels++
      this.speaking = false
    },
  }
  Object.defineProperty(window, 'speechSynthesis', { value: spy })
})

let failed = false
try {
  await page.goto(
    `http://localhost:${APP_PORT}/main.html?proxy=ws://localhost:${PROXY_PORT}`
  )
  await page.waitForFunction(() => window.__coreSystemInfo, null, {
    timeout: 120_000,
  })
  console.log('OK: wasm core booted')

  // login (first account, manual flow — selectors as in test-read-time-e2e)
  const create = page.getByTestId('create-account-button')
  const other = page.getByTestId('other-login-button')
  await create.or(other).first().waitFor({ state: 'visible', timeout: 90_000 })
  if (await create.isVisible()) await create.click()
  await other.click()
  await page.getByTestId('manual-email-login').click()
  await page.locator('#addr').fill(alice.email)
  await page.locator('#password').fill(alice.password)
  await page.getByTestId('login-with-credentials').click()
  await page
    .locator('#new-chat-button')
    .waitFor({ state: 'visible', timeout: 150_000 })
  console.log('OK: UI login')

  // a message of our own in Saved Messages
  const marker = 'read me aloud please ' + Math.random().toString(36).slice(2)
  const savedChat = page
    .locator('.chat-list .chat-list-item')
    .filter({ hasText: 'Saved Messages' })
    .first()
  await savedChat.click()
  const composer = page.locator('textarea.create-or-edit-message-input')
  await composer.waitFor({ state: 'visible', timeout: 30_000 })
  await composer.fill(marker)
  await page.locator('button.send-button').click()
  const msg = page.locator('.message').filter({ hasText: marker }).last()
  await msg.waitFor({ state: 'visible', timeout: 30_000 })
  console.log('OK: message sent to Saved Messages')

  const menuItem = label =>
    page.locator('.dc-context-menu [role=menuitem]').filter({ hasText: label })

  // setting off -> no "Read aloud" in the context menu
  await msg.click({ button: 'right' })
  await page
    .locator('.dc-context-menu [role=menuitem]')
    .first()
    .waitFor({ state: 'visible', timeout: 10_000 })
  if ((await menuItem('Read aloud').count()) !== 0) {
    throw new Error('"Read aloud" visible although setting is off')
  }
  await page.keyboard.press('Escape')
  console.log('OK: no menu item while setting is off')

  // enable via the real settings UI
  await page.getByTestId('open-settings-button').click()
  await page.getByTestId('open-advanced-settings').click()
  await page.getByText('Read messages aloud', { exact: true }).click()
  await page.keyboard.press('Escape') // Advanced -> settings root
  await page.keyboard.press('Escape') // close dialog
  await page
    .getByTestId('settings-dialog')
    .waitFor({ state: 'hidden', timeout: 10_000 })
  console.log('OK: experimental setting enabled via settings UI')

  // "Read aloud" speaks the message text
  await msg.click({ button: 'right' })
  const readAloud = menuItem('Read aloud').first()
  await readAloud.waitFor({ state: 'visible', timeout: 10_000 })
  await page.screenshot({ path: '/tmp/read-aloud-menu.png' })
  await readAloud.click()
  const spoken = await page.evaluate(() => window.speechSynthesis.spoken)
  if (spoken.length !== 1 || spoken[0] !== marker) {
    throw new Error(`expected [${marker}] spoken, got ${JSON.stringify(spoken)}`)
  }
  console.log('OK: "Read aloud" spoke the message text')

  // while speaking -> "Stop reading aloud" appears and cancels
  await page.evaluate(() => (window.speechSynthesis.speaking = true))
  await msg.click({ button: 'right' })
  const stop = menuItem('Stop reading aloud').first()
  await stop.waitFor({ state: 'visible', timeout: 10_000 })
  const cancelsBefore = await page.evaluate(() => window.speechSynthesis.cancels)
  await stop.click()
  const cancelsAfter = await page.evaluate(() => window.speechSynthesis.cancels)
  if (cancelsAfter !== cancelsBefore + 1) {
    throw new Error('"Stop reading aloud" did not cancel')
  }
  console.log('OK: "Stop reading aloud" shown while speaking, cancels')

  console.log('OK: read-aloud e2e passed (screenshot /tmp/read-aloud-menu.png)')
} catch (err) {
  console.error('FAIL:', err.message)
  await page.screenshot({ path: '/tmp/read-aloud-fail.png' }).catch(() => {})
  console.error('--- last page console lines ---')
  console.error(consoleTail.slice(-60).join('\n'))
  failed = true
} finally {
  clearTimeout(watchdog)
  await browser.close()
  cleanup()
}
process.exit(failed ? 1 : 0)
