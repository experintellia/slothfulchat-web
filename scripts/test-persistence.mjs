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

const appUrl = `http://localhost:${APP_PORT}/main.html?proxy=ws://localhost:${PROXY_PORT}`

let failed = false
try {
  await page.goto(appUrl)
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

  // steps 7+8 corrupt OPFS out from under the app. The worker holds permanent
  // sync-access locks on accounts.toml/.bak, so corruption must be injected
  // from a page that does NOT run the app: navigate to a 404 (same origin, so
  // OPFS is reachable; the SW passes 404s through when the network is up) and
  // retry until the old worker's teardown releases the locks.
  const injectOpfsCorruption = async fn => {
    await page.goto(`http://localhost:${APP_PORT}/__no_app__`)
    const deadline = Date.now() + 15_000
    for (;;) {
      try {
        await page.evaluate(fn)
        return
      } catch (err) {
        if (Date.now() > deadline) throw err
        await new Promise(r => setTimeout(r, 500)) // old worker still tearing down
      }
    }
  }

  // 7. corrupt accounts.toml in OPFS (the iOS incident: mirror returned ~1MB
  // of garbage) → boot again → the wasm self-heal must quarantine it and
  // restore the last-good backup
  await injectOpfsCorruption(async () => {
    const root = await navigator.storage.getDirectory()
    const dir = await (
      await root.getDirectoryHandle('memfs')
    ).getDirectoryHandle('accounts')
    const file = await dir.getFileHandle('accounts.toml')
    const w = await file.createWritable()
    await w.write(new Uint8Array(2 * 1024 * 1024).fill(0xff))
    await w.close()
  })
  console.log('OK: overwrote OPFS accounts.toml with 2 MiB of 0xff')
  await page.goto(appUrl)
  await page.waitForFunction(() => window.__coreSystemInfo, null, {
    timeout: 120_000,
  })
  await page
    .locator('#new-chat-button')
    .waitFor({ state: 'visible', timeout: 120_000 })
  const healedIds = await rpc('getAllAccountIds')
  if (healedIds.length !== 1) {
    throw new Error(`expected 1 healed account, got ${healedIds}`)
  }
  const healedInfo = await rpc('getAccountInfo', healedIds[0])
  if (healedInfo.kind !== 'Configured' || healedInfo.addr !== alice.email) {
    throw new Error(`account not healed: ${JSON.stringify(healedInfo)}`)
  }
  // quarantine file lands in OPFS via the async flusher — poll from node
  // (waitForFunction never awaits async predicates)
  const deadline = Date.now() + 15_000
  let brokenKept = false
  while (!brokenKept && Date.now() < deadline) {
    brokenKept = await page.evaluate(async () => {
      const root = await navigator.storage.getDirectory()
      const dir = await (
        await root.getDirectoryHandle('memfs')
      ).getDirectoryHandle('accounts')
      return dir
        .getFileHandle('accounts.toml.broken')
        .then(() => true)
        .catch(() => false)
    })
    if (!brokenKept) await new Promise(r => setTimeout(r, 500))
  }
  if (!brokenKept) {
    throw new Error('accounts.toml.broken missing in OPFS after self-heal')
  }
  // the dir rebuild would also yield 1 configured account — make sure it was
  // actually the backup stage that healed (it preserves ids/order/selection)
  if (!consoleTail.some(l => l.includes('restored accounts.toml from the last-good backup'))) {
    throw new Error('heal did not restore from the last-good backup')
  }
  console.log('OK: corrupt accounts.toml self-healed from backup, quarantine kept')

  // 8. the CI flake shape: 0-byte accounts.toml AND no account dirs → the
  // heal must skip the (now stale) backup, rebuild a parseable config with
  // `accounts = []` (a rebuild without the key boot-loops on `missing field
  // accounts`) and boot empty
  await injectOpfsCorruption(async () => {
    const root = await navigator.storage.getDirectory()
    const dir = await (
      await root.getDirectoryHandle('memfs')
    ).getDirectoryHandle('accounts')
    // truncate FIRST: createWritable is blocked until the old worker's lock
    // releases, so the destructive dir removal below can't race a still-live
    // worker flushing writes that recreate the dirs
    const file = await dir.getFileHandle('accounts.toml')
    const w = await file.createWritable()
    await w.close() // truncates to 0 bytes
    // collect names before removing: mutating an OPFS directory during
    // async iteration can skip entries
    const names = []
    for await (const [name, handle] of dir.entries()) {
      if (handle.kind === 'directory') names.push(name)
    }
    for (const name of names) {
      await dir.removeEntry(name, { recursive: true })
    }
  })
  console.log('OK: truncated OPFS accounts.toml to 0 bytes, removed account dirs')
  await page.goto(appUrl)
  await page.waitForFunction(() => window.__coreSystemInfo, null, {
    timeout: 120_000,
  })
  const emptyIds = await rpc('getAllAccountIds')
  if (emptyIds.length !== 0) {
    throw new Error(`expected 0 accounts after empty-file heal, got ${emptyIds}`)
  }
  console.log('OK: empty accounts.toml healed to a bootable zero-account config')

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
