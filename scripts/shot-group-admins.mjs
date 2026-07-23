// Screenshot helper + offline UI check for admin groups (core/0019 +
// desktop/0064). Network-free variant of scripts/test-group-admins-e2e.mjs
// for sandboxes that cannot reach a chatmail server: the two-account demo
// state (admin group "Sloth Lounge", alice = admin, bob = member) is
// pre-baked by core's demo-state generator and imported through the real
// welcome-screen restore UI:
//
//   DEMO_OUT=/tmp/ga-demo cargo test -p deltachat --lib \
//     test_admin_group_demo_backups -- --ignored   # in build/core
//   DEMO_OUT=/tmp/ga-demo SHOT_DIR=shots node scripts/shot-group-admins.mjs
//
// Asserts the same UI gating as the e2e test (minus live delivery) and saves
// screenshots of each surface into SHOT_DIR.
import { spawn } from 'node:child_process'
import { mkdirSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const script = p => fileURLToPath(new URL(p, import.meta.url))
const APP_PORT = Number(process.env.APP_PORT ?? 8642)
const DEMO_OUT = process.env.DEMO_OUT
if (!DEMO_OUT) throw new Error('set DEMO_OUT to the demo-backup directory')
const SHOT_DIR = process.env.SHOT_DIR
if (SHOT_DIR) mkdirSync(SHOT_DIR, { recursive: true })

const backupTar = dir => {
  const d = join(DEMO_OUT, dir)
  const tar = readdirSync(d).find(f => f.includes('backup'))
  if (!tar) throw new Error(`no backup tar in ${d}`)
  return join(d, tar)
}
const aliceTar = backupTar('alice')
const bobTar = backupTar('bob')

const appServer = spawn('node', [script('../packages/web-app/serve.mjs')], {
  env: { ...process.env, PORT: String(APP_PORT) },
  stdio: 'inherit',
})
const cleanup = () => appServer.kill()
process.on('exit', cleanup)
const watchdog = setTimeout(() => {
  console.error('FAIL: global watchdog (6 min) — hung')
  cleanup()
  process.exit(1)
}, 360_000)
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

// welcome screen -> "I Already Have a Profile" -> "Restore from Backup"
async function importBackup(tarPath) {
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
  const id = await page.evaluate(() => window.__selectedAccountId)
  // offline demo: don't let the account try to connect
  await rpc('stopIo', id)
  console.log(`OK: imported ${tarPath} -> account ${id}`)
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

async function openLoungeChat() {
  const chat = page
    .locator('.chat-list .chat-list-item')
    .filter({ hasText: 'Sloth Lounge' })
    .first()
  await chat.waitFor({ state: 'visible', timeout: 30_000 })
  await chat.click()
}

async function openGroupDialog() {
  await page.getByTestId('chat-info-button').click()
  await page
    .getByTestId('view-group-dialog')
    .waitFor({ state: 'visible', timeout: 15_000 })
}

let failed = false
try {
  // persist=0: memory-only core, every run starts clean
  await page.goto(`http://localhost:${APP_PORT}/main.html?persist=0`)
  await page.waitForFunction(() => window.__coreSystemInfo, null, {
    timeout: 120_000,
  })
  console.log('OK: wasm core booted')

  const aliceId = await importBackup(aliceTar)
  // second profile through the sidebar's add button
  const add = page.getByTestId('add-account-button')
  await add.hover()
  await add.click()
  const bobId = await importBackup(bobTar)

  // 0. with the experimental setting off, the checkbox is not offered
  await switchToProfile(aliceId)
  await page.locator('#new-chat-button').click()
  await page.getByTestId('newgroup').click()
  await page.getByTestId('group-name-input').waitFor({ state: 'visible' })
  if (await page.getByTestId('admin-group-checkbox').isVisible()) {
    throw new Error('admin-group checkbox offered without the experimental setting')
  }
  await page.getByRole('button', { name: 'Cancel' }).click()
  await page.keyboard.press('Escape')
  await page
    .getByTestId('create-chat-dialog')
    .waitFor({ state: 'detached', timeout: 10_000 })
  console.log('OK: checkbox hidden while the experimental setting is off')

  // 1a. the Admin groups option is a super-dangerous option, hidden until
  // unlocked by tapping the version in About 10× (Android developer-menu style)
  await page.getByTestId('open-settings-button').click()
  await page.getByRole('button', { name: 'Experimental Features' }).click()
  const adminGroupsToggle = page
    .locator('label')
    .filter({ hasText: 'Admin groups' })
    .first()
  if (await adminGroupsToggle.isVisible()) {
    throw new Error('Admin groups option visible before unlocking')
  }
  console.log('OK: Admin groups option hidden before unlock')

  // unlock: About → tap the version 10 times (a countdown toast shows near the end)
  await page.getByRole('button', { name: 'About SlothfulChat' }).click()
  const version = page.getByTestId('about-version')
  await version.waitFor({ state: 'visible', timeout: 15_000 })
  for (let i = 0; i < 10; i++) {
    await version.click()
    if (i === 7) {
      // remaining === 2 → countdown toast
      await page
        .locator('.user-feedback')
        .filter({ hasText: 'steps away' })
        .first()
        .waitFor({ state: 'visible', timeout: 5_000 })
      await shot('0-unlock-countdown-toast')
    }
  }
  await page
    .locator('.user-feedback')
    .filter({ hasText: 'super-dangerous' })
    .first()
    .waitFor({ state: 'visible', timeout: 5_000 })
  console.log('OK: 10 taps unlocked the super-dangerous options')
  await page.keyboard.press('Escape') // close About

  // now the Admin groups toggle is revealed under "Super-dangerous"
  await page.getByRole('button', { name: 'Experimental Features' }).click()
  await adminGroupsToggle.waitFor({ state: 'visible', timeout: 15_000 })
  await shot('0-experimental-setting')
  // the "hide" button is enabled while no super-dangerous option is active
  const hideBtn = page.getByTestId('hide-super-dangerous')
  if (await hideBtn.isDisabled()) {
    throw new Error('hide button should be enabled while admin groups is off')
  }
  await adminGroupsToggle.click()
  // ...and becomes disabled once admin groups is on
  await hideBtn
    .and(page.locator(':disabled'))
    .waitFor({ state: 'attached', timeout: 5_000 })
  console.log('OK: hide button disabled while a super-dangerous option is on')
  await page.keyboard.press('Escape')

  // 1b. the "Admin group" checkbox in the New Group dialog
  await page.locator('#new-chat-button').click()
  await page.getByTestId('newgroup').click()
  await page.getByTestId('group-name-input').fill('Book club')
  await page.getByTestId('admin-group-checkbox').check()
  await shot('1-create-admin-group-checkbox')
  await page.getByRole('button', { name: 'Cancel' }).click() // CreateGroup
  await page.keyboard.press('Escape') // the underlying New Chat dialog
  await page
    .getByTestId('create-chat-dialog')
    .waitFor({ state: 'detached', timeout: 10_000 })

  // 2. admin's group dialog: Add Member, QR invite, Edit all present
  await openLoungeChat()
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
  await page.keyboard.press('Escape') // menu
  // the 👑 badge marks the admin's row, visible to every member
  await page
    .locator('.group-admin-badge')
    .waitFor({ state: 'visible', timeout: 10_000 })
  await shot('2-admin-group-dialog')
  await page.keyboard.press('Escape') // dialog
  console.log('OK: admin sees Add Member / QR invite / Edit / 👑 badge')

  // 3. admin deletes bob's message for everyone
  const bobMsg = page
    .locator('.message.incoming')
    .filter({ hasText: 'Bob here' })
    .first()
  await bobMsg.click({ button: 'right' })
  await page.getByText('Delete Message', { exact: true }).click()
  const deleteForAll = page.getByTestId('delete_for_everyone')
  await deleteForAll.waitFor({ state: 'visible', timeout: 15_000 })
  await shot('3-admin-delete-for-everyone')
  await deleteForAll.click()
  await bobMsg.waitFor({ state: 'detached', timeout: 30_000 })
  console.log("OK: admin deleted a member's message for everyone")

  // 4. bob's group dialog: no Add Member / QR invite / Edit
  await switchToProfile(bobId)
  await openLoungeChat()
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
  await page.keyboard.press('Escape') // menu
  // the member also sees the 👑 on the admin's row
  await page
    .locator('.group-admin-badge')
    .waitFor({ state: 'visible', timeout: 10_000 })
  await shot('4-member-group-dialog')
  await page.keyboard.press('Escape') // dialog
  console.log('OK: non-admin sees the 👑 but no Add Member / QR invite / Edit')

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

  console.log('OK: admin groups offline UI check — all surfaces verified')
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
