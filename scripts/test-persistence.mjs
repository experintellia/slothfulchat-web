// M5 persistence e2e: login via the real UI, send a marker to the self-chat,
// reload the page and assert — WITHOUT re-login — that the account and the
// marker message survived (sqlite via opfs-sahpool + memfs OPFS mirror).
//
// Playwright keeps OPFS + localStorage within the same browser context across
// page.reload(); the context is intentionally NOT closed between the steps.
//
// Modeled on scripts/test-web-app-e2e.mjs (servers, eval fix, login flow).
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const script = p => fileURLToPath(new URL(p, import.meta.url))
const PROXY_PORT = Number(process.env.PROXY_PORT ?? 8641)
const APP_PORT = Number(process.env.APP_PORT ?? 8642)
const CHATMAIL_NEW = process.env.CHATMAIL_NEW ?? 'https://nine.testrun.org/new'

// -- throwaway account (node side; in-wasm HTTP is stubbed) --
const resp = await fetch(CHATMAIL_NEW, { method: 'POST' })
if (!resp.ok) throw new Error(`account creation failed: ${resp.status}`)
const alice = await resp.json() // { email, password }
console.log(`created account ${alice.email}`)

// -- servers --
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
await new Promise(r => setTimeout(r, 500)) // let servers bind

// -- browser --
const browser = await chromium.launch()
const page = await browser.newPage()
const consoleTail = []
page.on('console', m => {
  const t = m.text()
  consoleTail.push(t.slice(0, 500))
  if (/panicked at/.test(t)) console.error('[page PANIC]', t)
})
page.on('pageerror', e => console.error('[pageerror]', e.message))
// upstream's avoid-eval.js breaks page.evaluate; freeze the real eval
await page.addInitScript(() => {
  Object.defineProperty(window, 'eval', { value: window.eval, writable: false })
})

const rpc = (method, ...args) =>
  page.evaluate(([m, a]) => window.exp.rpc[m](...a), [method, args])

let failed = false
try {
  await page.goto(
    `http://localhost:${APP_PORT}/main.html?proxy=ws://localhost:${PROXY_PORT}`
  )
  await page.waitForFunction(() => window.__coreSystemInfo, null, {
    timeout: 120_000,
  })
  console.log('OK: wasm core booted (persist on)')

  // 1. UI login (selectors from test-web-app-e2e.mjs)
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
  const accountId = await page.evaluate(() => window.__selectedAccountId)
  if (!accountId) throw new Error('no selected account after login')
  console.log(`OK: UI login ${alice.email} -> account ${accountId}`)

  // 2. marker into the self-chat (RPC; UI send is covered by the other e2e)
  const marker = 'persist-e2e-' + Math.random().toString(36).slice(2)
  const selfChatId = await rpc('createChatByContactId', accountId, 1) // 1 = ContactId::SELF
  await rpc('miscSendTextMessage', accountId, selfChatId, marker)
  console.log(`OK: sent "${marker}" to the self-chat`)

  // 3. give the OPFS write-through queue a moment to flush
  await new Promise(r => setTimeout(r, 5_000))

  // 4. reload — same browser context, so OPFS survives
  await page.reload()
  await page.waitForFunction(() => window.__coreSystemInfo, null, {
    timeout: 120_000,
  })
  console.log('OK: page reloaded, core rebooted')

  // 5. assert WITHOUT re-login: main screen (not onboarding), account present
  await page
    .locator('#new-chat-button')
    .waitFor({ state: 'visible', timeout: 120_000 })
  const ids = await rpc('getAllAccountIds')
  if (!ids.includes(accountId)) {
    throw new Error(`account ${accountId} missing after reload (got ${ids})`)
  }
  const info = await rpc('getAccountInfo', accountId)
  if (info.kind !== 'Configured' || info.addr !== alice.email) {
    throw new Error(`account not configured after reload: ${JSON.stringify(info)}`)
  }
  console.log(`OK: account ${accountId} (${info.addr}) survived the reload`)

  // 6. self-chat still shows the marker: chat list summary carries the last
  // message text; click it and read the message from the DOM
  const chat = page
    .locator('.chat-list .chat-list-item')
    .filter({ hasText: marker })
    .first()
  await chat.waitFor({ state: 'visible', timeout: 60_000 })
  await chat.click()
  await page
    .locator('.message')
    .filter({ hasText: marker })
    .first()
    .waitFor({ state: 'visible', timeout: 60_000 })
  console.log(`OK: self-chat shows "${marker}" after reload`)

  console.log('OK: account + message survived reload')
} catch (err) {
  console.error('FAIL:', err.message)
  console.error('--- last page console lines ---')
  console.error(consoleTail.slice(-80).join('\n'))
  failed = true
} finally {
  clearTimeout(watchdog)
  await browser.close()
  cleanup()
}
process.exit(failed ? 1 : 0)
