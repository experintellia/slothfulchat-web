// UI end-to-end test for backup export+import (IMEX) in the wasm web-app:
// login via the real login form, marker message into the self-chat (RPC),
// backup export via settings UI (real browser download through the blobs SW
// /download-backup route), full state wipe via page reload (memfs is
// memory-only), then restore-from-backup via the welcome screen UI feeding
// the downloaded tar back in, and assert the marker survived.
//
// Modeled on scripts/test-web-app-e2e.mjs (servers, eval freeze, login flow).
import { spawn } from 'node:child_process'
import { stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
const proxy = spawn('node', [script('./ws-tcp-proxy.mjs')], {
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

// rpc bridge onto the wasm core (upstream devmode escape hatch)
const rpc = (method, ...args) =>
  page.evaluate(([m, a]) => window.exp.rpc[m](...a), [method, args])

async function waitForBoot() {
  await page.waitForFunction(() => window.__coreSystemInfo, null, {
    timeout: 120_000,
  })
}

// UI: manual/classic login (same selector flow as test-web-app-e2e.mjs)
async function loginViaUI({ email, password }) {
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

let failed = false
try {
  // persist=0: this test needs reload-as-wipe (step 3), so run without OPFS
  await page.goto(
    `http://localhost:${APP_PORT}/main.html?persist=0&proxy=ws://localhost:${PROXY_PORT}`
  )
  await waitForBoot()
  console.log('OK: wasm core booted')

  // 1. login through the real UI, marker message into the self-chat via RPC
  const accountId = await loginViaUI(alice)
  const marker = 'ui-imex-' + Math.random().toString(36).slice(2)
  const selfChat = await rpc('createChatByContactId', accountId, 1)
  await rpc('miscSendTextMessage', accountId, selfChat, marker)
  console.log(`OK: marker "${marker}" placed in self-chat ${selfChat}`)

  // 2. EXPORT via the real settings UI:
  // sidebar settings -> "Chats" -> "Export Backup" -> confirm -> alert "Open"
  // (the Open click window.open()s /download-backup/<file>, which the blobs
  // SW serves as an attachment => a browser download)
  await page.getByTestId('open-settings-button').click()
  await page.getByRole('button', { name: 'Chats' }).click()
  await page.getByRole('button', { name: 'Export Backup' }).click()
  await page.getByTestId('confirm-dialog').getByTestId('confirm').click()
  const openButton = page.getByTestId('alert-ok')
  await openButton.waitFor({ state: 'visible', timeout: 60_000 })
  const downloadPromise = page.waitForEvent('download', { timeout: 30_000 })
  await openButton.click()
  const download = await downloadPromise
  const name = download.suggestedFilename()
  if (!name.includes('delta-chat-backup')) {
    throw new Error(`unexpected download filename: ${name}`)
  }
  const tarPath = join(tmpdir(), `slothfulchat-imex-${Date.now()}-${name}`)
  await download.saveAs(tarPath)
  const { size } = await stat(tarPath)
  if (size < 100 * 1024) throw new Error(`backup too small: ${size} bytes`)
  console.log(`OK: UI export -> download ${name} (${size} bytes)`)

  // 3. wipe: with persist=0 the core is memory-only, a reload loses all
  // accounts and lands on the welcome screen with a fresh unconfigured account
  await page.reload()
  await waitForBoot()
  console.log('OK: reloaded — fresh core, no accounts')

  // 4. IMPORT via the real welcome-screen UI, feeding the downloaded tar into
  // our runtime's showOpenFileDialog file input via playwright's file chooser
  await page
    .getByTestId('have-account-button')
    .waitFor({ state: 'visible', timeout: 90_000 })
  await page.getByTestId('have-account-button').click()
  const fileChooserPromise = page.waitForEvent('filechooser', {
    timeout: 30_000,
  })
  await page.getByTestId('import-backup-button').click()
  const fileChooser = await fileChooserPromise
  await fileChooser.setFiles(tarPath)
  await page
    .locator('#new-chat-button')
    .waitFor({ state: 'visible', timeout: 150_000 })
  console.log('OK: UI import finished, main screen visible')

  // 5. assert the restored account + marker message
  const importedId = await page.evaluate(() => window.__selectedAccountId)
  const addr =
    (await rpc('getConfig', importedId, 'configured_addr')) ??
    (await rpc('getConfig', importedId, 'addr'))
  if (addr !== alice.email) {
    throw new Error(`imported addr mismatch: ${addr} != ${alice.email}`)
  }
  const selfChat2 = await rpc('createChatByContactId', importedId, 1)
  const msgIds = await rpc('getMessageIds', importedId, selfChat2, false, false)
  let found = false
  for (const msgId of msgIds) {
    const msg = await rpc('getMessage', importedId, msgId)
    if (msg.text && msg.text.includes(marker)) found = true
  }
  if (!found) {
    throw new Error(`marker not found after import (${msgIds.length} msgs)`)
  }
  console.log(`OK: restored ${addr}, marker found in self-chat`)

  console.log('OK: UI backup export+import roundtrip')
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
