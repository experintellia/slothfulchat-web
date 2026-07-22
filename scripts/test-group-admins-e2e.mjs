// UI end-to-end test for admin groups (core/0019 + desktop/0064, ported from
// ArcaneChat): alice creates a group with the "Admin group" checkbox, adds bob,
// and only alice gets the management UI — bob's group dialog has no Add
// Member / QR invite / remove buttons and no Edit menu entry, core rejects a
// rename from bob, and alice can delete bob's message for everyone (it
// disappears on bob's side).
//
// Set SHOT_DIR to also save explanatory screenshots of each surface.
//
// Modeled on scripts/test-web-app-e2e.mjs (servers, login flow, watchdog).
import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const script = p => fileURLToPath(new URL(p, import.meta.url))
const PROXY_PORT = Number(process.env.PROXY_PORT ?? 8641)
const APP_PORT = Number(process.env.APP_PORT ?? 8642)
const CHATMAIL_NEW = process.env.CHATMAIL_NEW ?? 'https://nine.testrun.org/new'
const SHOT_DIR = process.env.SHOT_DIR
if (SHOT_DIR) mkdirSync(SHOT_DIR, { recursive: true })

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

const browser = await chromium.launch(
  process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {}
)
const page = await browser.newPage({ viewport: { width: 1100, height: 800 } })
const consoleTail = []
page.on('console', m => consoleTail.push(m.text().slice(0, 500)))
page.on('pageerror', e => console.error('[pageerror]', e.message))
await page.addInitScript(() => {
  Object.defineProperty(window, 'eval', { value: window.eval, writable: false })
})

const rpc = (method, ...args) =>
  page.evaluate(([m, a]) => window.exp.rpc[m](...a), [method, args])

const shot = async name => {
  if (!SHOT_DIR) return
  await page.screenshot({ path: `${SHOT_DIR}/${name}.png` })
  console.log(`shot: ${name}.png`)
}

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
}

async function openGroupDialog() {
  await page.getByTestId('chat-info-button').click()
  await page
    .getByTestId('view-group-dialog')
    .waitFor({ state: 'visible', timeout: 15_000 })
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

  await rpc('startIo', aliceId)
  await rpc('startIo', bobId)
  // chatmail mandates E2EE: exchange keys via vcard so bob is a key contact
  const vcard = await rpc('makeVcard', bobId, [1]) // 1 = ContactId::SELF
  const [bobContactId] = await rpc('importVcardContents', aliceId, vcard)
  console.log('OK: rpc — key exchange done')

  // 1. alice creates an admin group through the real UI
  await switchToProfile(aliceId)
  await page.locator('#new-chat-button').click()
  await page.getByTestId('newgroup').click()
  await page.getByTestId('group-name-input').fill('Sloth Lounge')
  await page.getByTestId('admin-group-checkbox').check()
  await page.getByTestId('addmember').click()
  await page
    .getByTestId('add-member-dialog')
    .locator('.contact-list-item, button')
    .filter({ hasText: bob.email })
    .first()
    .click()
  await page.getByTestId('ok').click()
  await shot('1-create-admin-group')
  await page.getByTestId('group-create-button').click()

  // promote the group so bob actually receives it
  const composer = page.locator('textarea.create-or-edit-message-input')
  await composer.waitFor({ state: 'visible', timeout: 30_000 })
  await composer.fill('Welcome to the admin group!')
  await page.locator('button.send-button').click()
  await page
    .locator('.message.outgoing')
    .last()
    .waitFor({ state: 'visible', timeout: 30_000 })
  console.log('OK: admin group created via UI, first message sent')

  // 2. alice = admin: management UI is there
  await openGroupDialog()
  for (const id of ['addmember', 'showqrcode']) {
    if (!(await page.getByTestId(id).isVisible())) {
      throw new Error(`admin should see ${id} in the group dialog`)
    }
  }
  await page.getByTestId('view-group-menu').click()
  await page
    .getByTestId('view-group-edit')
    .waitFor({ state: 'visible', timeout: 10_000 })
  await shot('2-admin-view-group')
  await page.keyboard.press('Escape') // menu
  await page.keyboard.press('Escape') // dialog
  console.log('OK: admin sees Add Member / QR invite / Edit')

  // 3. bob = plain member: management UI is gone
  await switchToProfile(bobId)
  const groupChat = page
    .locator('.chat-list .chat-list-item')
    .filter({ hasText: 'Sloth Lounge' })
    .first()
  await groupChat.waitFor({ state: 'visible', timeout: 150_000 })
  await groupChat.click()
  await page
    .locator('.message.incoming')
    .first()
    .waitFor({ state: 'visible', timeout: 60_000 })
  await openGroupDialog()
  for (const id of ['addmember', 'showqrcode']) {
    if (await page.getByTestId(id).isVisible()) {
      throw new Error(`non-admin must not see ${id} in the group dialog`)
    }
  }
  await page.getByTestId('view-group-menu').click()
  await page.getByTestId('encryption-info').waitFor({ state: 'visible' })
  if (await page.getByTestId('view-group-edit').isVisible()) {
    throw new Error('non-admin must not have an Edit menu entry')
  }
  await shot('3-member-view-group')
  await page.keyboard.press('Escape')
  await page.keyboard.press('Escape')
  console.log('OK: non-admin sees no Add Member / QR invite / Edit')

  // core enforcement, not just hidden buttons: rename by bob must fail
  // (catch inside the page — rpc rejections don't survive page.evaluate)
  const rename = await page.evaluate(async bobId => {
    const rpc = window.exp.rpc
    const ids = await rpc.getChatlistEntries(bobId, 0, null, null)
    for (const id of ids) {
      const info = await rpc.getBasicChatInfo(bobId, id)
      if (info.name !== 'Sloth Lounge') continue
      try {
        await rpc.setChatName(bobId, id, 'bob was here')
        return { threw: false }
      } catch (err) {
        return { threw: true, msg: String((err && err.message) || err) }
      }
    }
    return { threw: false, msg: 'group not found in bob chatlist' }
  }, bobId)
  if (!rename.threw || !/admin/i.test(rename.msg)) {
    throw new Error(
      `core let a non-admin rename the group: ${JSON.stringify(rename)}`
    )
  }
  console.log(`OK: core rejected a rename by a non-admin ("${rename.msg}")`)

  // 4. bob writes; alice (admin) deletes his message for everyone
  const bobMarker = 'bob-' + Math.random().toString(36).slice(2)
  await composer.fill(bobMarker)
  await page.locator('button.send-button').click()
  await page
    .locator('.message.outgoing')
    .filter({ hasText: bobMarker })
    .waitFor({ state: 'visible', timeout: 30_000 })

  await switchToProfile(aliceId)
  const bobMsg = page.locator('.message.incoming').filter({ hasText: bobMarker })
  await bobMsg.waitFor({ state: 'visible', timeout: 60_000 })
  await bobMsg.click({ button: 'right' })
  await page.getByText('Delete Message', { exact: true }).click()
  const deleteForAll = page.getByTestId('delete_for_everyone')
  await deleteForAll.waitFor({ state: 'visible', timeout: 15_000 })
  await shot('4-admin-delete-for-everyone')
  await deleteForAll.click()
  await bobMsg.waitFor({ state: 'detached', timeout: 30_000 })
  console.log('OK: admin deleted a member message for everyone')

  // ...and it disappears on bob's device too
  await switchToProfile(bobId)
  await page
    .locator('.message.outgoing')
    .filter({ hasText: bobMarker })
    .waitFor({ state: 'detached', timeout: 60_000 })
  await shot('5-member-message-deleted')
  console.log('OK: the deletion reached bob — message gone on his side')

  console.log('OK: group admins e2e — creation, gating, enforcement, deletion')
} catch (err) {
  console.error('FAIL:', err.message)
  console.error('--- last page console lines ---')
  console.error(consoleTail.slice(-60).join('\n'))
  failed = true
} finally {
  clearTimeout(watchdog)
  await browser.close()
  cleanup()
}
process.exit(failed ? 1 : 0)
