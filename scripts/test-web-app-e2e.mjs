// UI end-to-end test for the wasm web-app (upstream deltachat-desktop frontend
// on the wasm core): manual login via the real login form, message send via
// the composer, account switching via the sidebar, receive assertion in the DOM.
//
// UI paths (required): alice login form, bob added as 2nd account via the same
// UI flow, composer send, account-switcher sidebar, incoming message in DOM.
// RPC paths (allowed): startIo safety net, vcard key exchange, chat creation.
//
// Modeled on scripts/smoke-web-app.mjs (servers, eval fix) and
// scripts/test-networking.mjs (account creation, marker roundtrip, watchdog).
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const script = p => fileURLToPath(new URL(p, import.meta.url))
const PROXY_PORT = Number(process.env.PROXY_PORT ?? 8641)
const APP_PORT = Number(process.env.APP_PORT ?? 8642)
const CHATMAIL_NEW = process.env.CHATMAIL_NEW ?? 'https://nine.testrun.org/new'

// -- throwaway accounts (node side; in-wasm HTTP is stubbed) --
async function newAccount() {
  const resp = await fetch(CHATMAIL_NEW, { method: 'POST' })
  if (!resp.ok) throw new Error(`account creation failed: ${resp.status}`)
  return resp.json() // { email, password }
}
const [alice, bob] = await Promise.all([newAccount(), newAccount()])
console.log(`created accounts alice=${alice.email} bob=${bob.email}`)

// -- servers --
// proxy stdout is piped so we can watch for the ":143 with zero accounts" mystery
const proxyLines = []
let loginStarted = false
const proxy = spawn('node', [script('../packages/ws-tcp-proxy/ws-tcp-proxy.mjs')], {
  env: { ...process.env, PORT: String(PROXY_PORT) },
  stdio: ['ignore', 'pipe', 'pipe'],
})
for (const stream of [proxy.stdout, proxy.stderr]) {
  stream.setEncoding('utf8')
  stream.on('data', chunk => {
    for (const line of chunk.split('\n')) {
      if (!line.trim()) continue
      proxyLines.push({ line, preLogin: !loginStarted })
      console.log('[proxy]', line)
    }
  })
}
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
// upstream's avoid-eval.js breaks page.evaluate; freeze the real eval (same as smoke)
await page.addInitScript(() => {
  Object.defineProperty(window, 'eval', { value: window.eval, writable: false })
})

// rpc bridge onto the wasm core the app itself runs on. window.r is deleted
// by the frontend after pickup; window.exp.rpc is upstream's devmode escape
// hatch (our runtime sets rc_config.devmode = true).
const rpc = (method, ...args) =>
  page.evaluate(([m, a]) => window.exp.rpc[m](...a), [method, args])

// UI: manual/classic login flow (selectors from upstream frontend source:
// OnboardingScreen -> InstantOnboardingScreen -> UseOtherServerDialog -> AccountSetupScreen)
async function loginViaUI({ email, password }, { firstAccount }) {
  if (!firstAccount) {
    const add = page.getByTestId('add-account-button')
    await add.hover()
    await add.click()
  }
  // The welcome screen shows OnboardingScreen (create-account-button) on a
  // fresh start, but jumps straight to InstantOnboardingScreen
  // (other-login-button) when the instant-onboarding flag is still set from a
  // previous account's flow. Handle both.
  const create = page.getByTestId('create-account-button')
  const other = page.getByTestId('other-login-button')
  await create.or(other).first().waitFor({ state: 'visible', timeout: 90_000 })
  if (await create.isVisible()) await create.click()
  await other.click()
  await page.getByTestId('manual-email-login').click()
  await page.locator('#addr').fill(email)
  await page.locator('#password').fill(password)
  loginStarted = true
  await page.getByTestId('login-with-credentials').click()
  // configure over IMAP/SMTP takes ~10-30s; main screen = chat list visible
  await page
    .locator('#new-chat-button')
    .waitFor({ state: 'visible', timeout: 150_000 })
  const id = await page.evaluate(() => window.__selectedAccountId)
  if (!id) throw new Error(`no selected account after login of ${email}`)
  console.log(`OK: UI login ${email} -> account ${id}`)
  return id
}

// UI: account switcher sidebar (selectors from upstream playwright-helper.ts)
async function switchToProfile(accountId) {
  const item = page.getByTestId(`account-item-${accountId}`)
  await item.hover() // upstream: click is not received without hover
  await item.click()
  await page
    .getByTestId(`selected-account:${accountId}`)
    .waitFor({ state: 'attached', timeout: 30_000 })
  // move the mouse off the sidebar — its hover tooltip otherwise lingers and
  // intercepts clicks on chat-list items
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

  // 1+2. both accounts through the real login UI (bob doubles as the
  // "add second account" flow, entered through the sidebar's add button)
  const aliceId = await loginViaUI(alice, { firstAccount: true })
  const bobId = await loginViaUI(bob, { firstAccount: false })

  // 3. RPC: make sure IO runs for both (idempotent), exchange keys via vcard
  // (chatmail mandates E2EE), create alice's chat with bob
  await rpc('startIo', aliceId)
  await rpc('startIo', bobId)
  const vcard = await rpc('makeVcard', bobId, [1]) // 1 = ContactId::SELF
  const [bobContactId] = await rpc('importVcardContents', aliceId, vcard)
  await rpc('createChatByContactId', aliceId, bobContactId)
  console.log('OK: rpc — key exchange + chat created')

  // 4. UI as alice: open the chat with bob, send a marker via the composer
  await switchToProfile(aliceId)
  const marker = 'ui-e2e-' + Math.random().toString(36).slice(2)
  const bobChat = page
    .locator('.chat-list .chat-list-item')
    .filter({ hasText: bob.email })
    .first()
  await bobChat.waitFor({ state: 'visible', timeout: 30_000 })
  await bobChat.click()
  const composer = page.locator('textarea.create-or-edit-message-input')
  await composer.waitFor({ state: 'visible', timeout: 30_000 })
  await composer.fill(marker)
  await page.locator('button.send-button').click()
  const outgoing = page
    .locator('.message.outgoing')
    .last()
    .locator('.msg-body .text')
  await outgoing.waitFor({ state: 'visible', timeout: 30_000 })
  if ((await outgoing.innerText()) !== marker) {
    throw new Error('outgoing message text mismatch')
  }
  console.log(`OK: sent "${marker}" via composer`)

  // 5. UI: switch to bob via the sidebar, wait for delivery, read it from the DOM
  await switchToProfile(bobId)
  const aliceChat = page
    .locator('.chat-list .chat-list-item')
    .filter({ hasText: alice.email })
    .first()
  await aliceChat.waitFor({ state: 'visible', timeout: 150_000 })
  await aliceChat.click()
  const incoming = page
    .locator('.message.incoming')
    .filter({ hasText: marker })
    .first()
  await incoming.waitFor({ state: 'visible', timeout: 60_000 })
  console.log(`OK: bob sees "${marker}" in the message list`)

  console.log('OK: UI e2e — login, send, account-switch, receive all verified')
} catch (err) {
  console.error('FAIL:', err.message)
  console.error('--- last page console lines ---')
  console.error(consoleTail.slice(-80).join('\n'))
  failed = true
} finally {
  const preLogin143 = proxyLines.filter(
    l => l.preLogin && /:143\b/.test(l.line)
  )
  if (preLogin143.length) {
    console.error(
      'NOTE: proxy saw :143 connections BEFORE any login:',
      preLogin143.map(l => l.line).join(' | ')
    )
  }
  clearTimeout(watchdog)
  await browser.close()
  cleanup()
}
process.exit(failed ? 1 : 0)
