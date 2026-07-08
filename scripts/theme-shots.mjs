// Screenshot harness for theme work: boots the web-app under a given theme
// and dumps screenshots to .cache/theme-shots/. Uses a persistent browser
// profile (.cache/theme-shots-profile/) so the throwaway accounts + seeded
// conversation from the first run are reused — later runs take ~10s.
//
//   node scripts/theme-shots.mjs [dc:rocket] [--fresh]
//
// Login/seed flow copied from scripts/test-web-app-e2e.mjs.
import { spawn } from 'node:child_process'
import { mkdir, rm } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { deflateSync } from 'node:zlib'
import { chromium } from 'playwright'

// minimal PNG encoder: 48x48 two-tone image so profile-photo avatars are
// visually distinct from initial-block fallbacks in the screenshots
function tinyPngBase64() {
  const w = 48
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    return c >>> 0
  })
  const crc = buf => {
    let c = 0xffffffff
    for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8)
    return (c ^ 0xffffffff) >>> 0
  }
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type), data])
    const out = Buffer.alloc(body.length + 8)
    out.writeUInt32BE(data.length, 0)
    body.copy(out, 4)
    out.writeUInt32BE(crc(body), body.length + 4)
    return out
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(w, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // rgb
  const raw = Buffer.alloc(w * (w * 3 + 1))
  for (let y = 0; y < w; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * (w * 3 + 1) + 1 + x * 3
      const on = (x < w / 2) !== (y < w / 2) // checkerboard quadrants
      raw[i] = on ? 0x1d : 0xff
      raw[i + 1] = on ? 0x74 : 0xd0
      raw[i + 2] = on ? 0xf5 : 0x2a
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]).toString('base64')
}

const script = p => fileURLToPath(new URL(p, import.meta.url))
const THEME = process.argv.find(a => a.includes(':')) ?? 'dc:rocket'
const FRESH = process.argv.includes('--fresh')
const PROXY_PORT = Number(process.env.PROXY_PORT ?? 8651)
const APP_PORT = Number(process.env.APP_PORT ?? 8652)
const CHATMAIL_NEW = process.env.CHATMAIL_NEW ?? 'https://nine.testrun.org/new'
const PROFILE = script('../.cache/theme-shots-profile')
const SHOTS = script('../.cache/theme-shots/' + THEME.replace(':', '-'))
const GROUP_NAME = 'design-team'

if (FRESH) await rm(PROFILE, { recursive: true, force: true })
await mkdir(SHOTS, { recursive: true })

// recompile our themes into the served dist so scss edits show up on rerun
{
  const { createRequire } = await import('node:module')
  const { readdir, writeFile } = await import('node:fs/promises')
  const webApp = script('../packages/web-app')
  const sass = createRequire(webApp + '/package.json')('sass')
  for (const file of await readdir(`${webApp}/themes`)) {
    if (!file.endsWith('.scss') || file.startsWith('_')) continue
    const { css } = sass.compile(`${webApp}/themes/${file}`, {
      loadPaths: [script('../build/desktop/packages/frontend/themes')],
      style: 'compressed',
    })
    await writeFile(
      `${webApp}/dist/themes/${file.replace(/\.scss$/, '.css')}`,
      css
    )
    console.log(`compiled themes/${file}`)
  }
}

// -- servers --
const procs = [
  spawn('node', [script('../packages/ws-tcp-proxy/ws-tcp-proxy.mjs')], {
    env: { ...process.env, PORT: String(PROXY_PORT) },
    stdio: 'inherit',
  }),
  spawn('node', [script('../packages/web-app/serve.mjs')], {
    env: { ...process.env, PORT: String(APP_PORT) },
    stdio: 'inherit',
  }),
]
const cleanup = () => procs.forEach(p => p.kill())
process.on('exit', cleanup)
const watchdog = setTimeout(() => {
  console.error('FAIL: watchdog (8 min)')
  cleanup()
  process.exit(1)
}, 480_000)
await new Promise(r => setTimeout(r, 500))

const context = await chromium.launchPersistentContext(PROFILE, {
  viewport: { width: 1280, height: 800 },
})
const page = context.pages()[0] ?? (await context.newPage())
page.on('console', m => {
  if (/panicked at/.test(m.text())) console.error('[page PANIC]', m.text())
})
// upstream's avoid-eval.js breaks page.evaluate; freeze the real eval
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
}

// seed: two accounts, a 1:1 chat and a group, messages in both directions so
// incoming/outgoing, author names and avatars are all on screen
async function seed() {
  const newAccount = async () => {
    const resp = await fetch(CHATMAIL_NEW, { method: 'POST' })
    if (!resp.ok) throw new Error(`account creation failed: ${resp.status}`)
    return resp.json()
  }
  const [alice, bob] = await Promise.all([newAccount(), newAccount()])
  console.log(`seeding: alice=${alice.email} bob=${bob.email}`)
  const aliceId = await loginViaUI(alice, { firstAccount: true })
  const bobId = await loginViaUI(bob, { firstAccount: false })
  await rpc('startIo', aliceId)
  await rpc('startIo', bobId)
  await rpc('setConfig', aliceId, 'displayname', 'Alice Weber')
  await rpc('setConfig', bobId, 'displayname', 'Bob Martinez')
  // bob gets a real profile photo (travels to alice with his messages), so
  // shots cover both avatar kinds: image and initial-block fallback
  const avatarPath = await page.evaluate(
    b64 => window.exp.runtime.writeTempFileFromBase64('bob-avatar.png', b64),
    tinyPngBase64()
  )
  await rpc('setConfig', bobId, 'selfavatar', avatarPath)
  // chatmail mandates E2EE: exchange keys via vcard before messaging
  const bobVcard = await rpc('makeVcard', bobId, [1])
  const [bobContact] = await rpc('importVcardContents', aliceId, bobVcard)
  const aliceVcard = await rpc('makeVcard', aliceId, [1])
  const [aliceContact] = await rpc('importVcardContents', bobId, aliceVcard)
  const dm = await rpc('createChatByContactId', aliceId, bobContact)
  const group = await rpc('createGroupChat', aliceId, GROUP_NAME, false)
  await rpc('addContactToChat', aliceId, group, bobContact)

  const say = (acc, chat, text) =>
    rpc('miscSendTextMessage', acc, chat, text)
  await say(aliceId, dm, 'Hey Bob, did you see the new theme draft?')
  await say(aliceId, group, 'Kicking off the design review in here 🎨')
  await say(
    aliceId,
    group,
    'Agenda for today:\n- sidebar contrast\n- message spacing\n- composer polish'
  )
  // wait for bob to receive the group, then answer so incoming messages exist
  await switchToProfile(bobId)
  const groupChat = page
    .locator('.chat-list .chat-list-item')
    .filter({ hasText: GROUP_NAME })
    .first()
  await groupChat.waitFor({ state: 'visible', timeout: 150_000 })
  await groupChat.click()
  // incoming chats start as contact requests: accept before the composer shows
  const accept = page.getByRole('button', { name: 'Accept' })
  await accept.waitFor({ state: 'visible', timeout: 30_000 })
  await accept.click()
  const composer = page.locator('textarea.create-or-edit-message-input')
  await composer.waitFor({ state: 'visible', timeout: 30_000 })
  await composer.fill('Looks great already! The dark sidebar really works 👍')
  await page.locator('button.send-button').click()
  await composer.fill('One thing: can we tighten the line height a bit?')
  await page.locator('button.send-button').click()
  // back to alice, wait for bob's replies to arrive
  await switchToProfile(aliceId)
  await page
    .locator('.chat-list .chat-list-item')
    .filter({ hasText: GROUP_NAME })
    .first()
    .click()
  await page
    .locator('.message.incoming')
    .filter({ hasText: 'line height' })
    .first()
    .waitFor({ state: 'visible', timeout: 150_000 })
  await say(aliceId, group, 'Sure — pushing an update in a minute.')
  console.log('OK: seeded conversation')
}

let failed = false
try {
  await page.goto(
    `http://localhost:${APP_PORT}/main.html?proxy=ws://localhost:${PROXY_PORT}`
  )
  await page.waitForFunction(() => window.__coreSystemInfo, null, {
    timeout: 120_000,
  })

  const chatList = page.locator('#new-chat-button')
  const welcome = page
    .getByTestId('create-account-button')
    .or(page.getByTestId('other-login-button'))
  await chatList.or(welcome).first().waitFor({ state: 'visible', timeout: 90_000 })
  if (!(await chatList.isVisible())) await seed()

  // apply the requested theme and reload so it takes effect everywhere
  await page.evaluate(theme => {
    const KEY = 'slothfulchat.desktopSettings'
    const s = JSON.parse(localStorage.getItem(KEY) || '{}')
    s.activeTheme = theme
    localStorage.setItem(KEY, JSON.stringify(s))
  }, THEME)
  await page.reload()
  await page.locator('#new-chat-button').waitFor({ state: 'visible', timeout: 120_000 })

  // Escape steps back through nested dialog pages, so press until none open
  const closeDialogs = async () => {
    for (let i = 0; i < 4; i++) {
      if (!(await page.locator('dialog[open]').count())) return
      await page.keyboard.press('Escape')
      await page.waitForTimeout(300)
    }
    throw new Error('dialog would not close')
  }

  const shot = async name => {
    await page.waitForTimeout(400) // let avatars/fonts settle
    const path = `${SHOTS}/${name}.png`
    await page.screenshot({ path })
    console.log(`shot: ${path}`)
  }

  // group chat open (author names + avatars + multi-line + emoji)
  await page
    .locator('.chat-list .chat-list-item')
    .filter({ hasText: GROUP_NAME })
    .first()
    .click()
  await page
    .locator('.message')
    .first()
    .waitFor({ state: 'visible', timeout: 30_000 })
  await shot('01-group-chat')

  // 1:1 chat
  const dmItem = page
    .locator('.chat-list .chat-list-item')
    .filter({ hasNotText: GROUP_NAME })
    .first()
  if (await dmItem.isVisible()) {
    await dmItem.click()
    await page.waitForTimeout(500)
    await shot('02-dm-chat')
  }

  // settings dialog with a hovered row (readability check), then appearance
  await page.getByTestId('open-settings-button').click()
  await page.getByText('Notifications', { exact: true }).hover()
  await shot('03-settings-hover')
  await page.getByText('Appearance', { exact: true }).click()
  await page.waitForTimeout(500)
  await shot('04-settings-appearance')
  await closeDialogs()

  // new-chat dialog: white dialog with a contact list (dark sidebar styles
  // must not leak in here)
  await page.locator('#new-chat-button').click()
  await page.waitForTimeout(500)
  await shot('05-new-chat-dialog')
  await closeDialogs()

  // small-screen mode: chat view fills the window, back button visible
  await page.setViewportSize({ width: 600, height: 800 })
  await page.waitForTimeout(500)
  await shot('06-small-screen-chat')
} catch (err) {
  failed = true
  console.error('FAIL:', err.message)
  await page.screenshot({ path: `${SHOTS}/error.png` }).catch(() => {})
} finally {
  clearTimeout(watchdog)
  await context.close()
  cleanup()
}
process.exit(failed ? 1 : 0)
