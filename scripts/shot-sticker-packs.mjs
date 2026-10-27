// Screenshot + self-check harness for sticker packs (core sticker packs +
// desktop sticker pack UI) — FULLY OFFLINE like scripts/shot-reactions.mjs: an
// in-process mock madmail server provides the accounts.
//
// Bob sends Alice a StickersBot-style pack zip, a zip that is no pack, and a
// sticker. Alice sees a pack card for the first zip only, adds the pack, finds
// it in the picker, and in Manage Stickers makes a pack, drags a sticker into
// it, saves the sticker Bob sent from "Recently Seen", imports the pack of her
// other profile, and exports a pack as a zip that is a pack again. The backup
// export confirmation mentions the packs. Shots go to .cache/sticker-shots/.
//
// Requires packages/core-wasm built and packages/web-app assembled+built.
// Run:  node scripts/shot-sticker-packs.mjs
// (CHROMIUM_BIN=/path/to/chrome overrides the playwright-managed browser.)
import { mkdir, readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { startServers } from './harness.mjs'
import { startMockMadmail } from './mock-madmail.mjs'

const { zipSync, unzipSync } = createRequire(
  new URL('../packages/web-app/package.json', import.meta.url)
)('fflate')

const SHOTS = fileURLToPath(new URL('../.cache/sticker-shots/', import.meta.url))
await mkdir(SHOTS, { recursive: true })
const APP_PORT = 8679

const mock = await startMockMadmail()
const QR = `webimapaccount:127.0.0.1:${mock.port}`
const { cleanup, watchdog } = await startServers({
  app: APP_PORT,
  settleMs: 700,
  watchdogMs: 420_000,
})
const browser = await chromium.launch(
  process.env.CHROMIUM_BIN ? { executablePath: process.env.CHROMIUM_BIN } : {}
)
const page = await browser.newPage({ viewport: { width: 1100, height: 800 } })
page.on('pageerror', e => console.error('[pageerror]', e.message))
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
  await page.waitForTimeout(700)
  await page.screenshot({ path: `${SHOTS}/${name}.png` })
  console.log(`shot: ${SHOTS}/${name}.png`)
}
/** a 256px webp sticker: an emoji on a transparent background */
const stickerWebp = emoji =>
  page.evaluate(async e => {
    const c = new OffscreenCanvas(256, 256)
    const g = c.getContext('2d')
    g.font = '200px sans-serif'
    g.textAlign = 'center'
    g.textBaseline = 'middle'
    g.fillText(e, 128, 140)
    const bytes = new Uint8Array(await (await c.convertToBlob({ type: 'image/webp' })).arrayBuffer())
    return btoa(String.fromCharCode(...bytes))
  }, emoji)
const writeTemp = (name, b64) =>
  page.evaluate(([n, b]) => window.exp.runtime.writeTempFileFromBase64(n, b), [name, b64])
const b64 = bytes => Buffer.from(bytes).toString('base64')

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
  const bobId = await setup('Bob Martinez')
  const workId = await setup('Alice (Work)')

  // Alice's other profile has a pack of its own.
  const workPack = await rpc('createStickerPack', workId, 'Office Life')
  for (const [i, e] of ['☕', '💼', '📎', '🖨️'].entries()) {
    const path = await writeTemp(`w${i}.webp`, await stickerWebp(e))
    await rpc('addStickerFromFile', workId, workPack, path, `w${i}.webp`)
  }

  // Bob -> Alice: a pack zip in StickersBot's layout, a zip that is no
  // pack, and a single sticker.
  const [aliceAtBob] = await rpc('importVcardContents', bobId, await rpc('makeVcard', aliceId, [1]))
  const dm = await rpc('createChatByContactId', bobId, aliceAtBob)
  const animals = ['🐶', '🐱', '🦊', '🐼', '🐨', '🦁', '🐸', '🐵']
  const packFiles = {}
  for (const [i, e] of animals.entries()) {
    packFiles[`Cute%20Animals/${i + 1}.animal+${e}.webp`] = Buffer.from(await stickerWebp(e), 'base64')
  }
  const sendFile = async (name, bytes, viewtype = 'File') =>
    rpc('sendMsg', bobId, dm, { file: await writeTemp(name, b64(bytes)), filename: name, viewtype })
  await rpc('miscSendTextMessage', bobId, dm, 'Got you a sticker pack from StickersBot 🎁')
  await sendFile('Cute%20Animals-k2j4h1.zip', zipSync(packFiles))
  await sendFile('holiday-notes.zip', zipSync({ 'notes.txt': Buffer.from('not stickers') }))
  await sendFile('sloth.webp', Buffer.from(await stickerWebp('🦥'), 'base64'), 'Sticker')

  let chatAtAlice
  await until(async () => {
    const [entry] = await rpc('getChatlistEntries', aliceId, 0, null, null)
    if (!entry) return false
    chatAtAlice = entry
    const ids = await rpc('getMessageIds', aliceId, entry, false, false)
    const msgs = Object.values(await rpc('getMessages', aliceId, ids))
    return msgs.filter(m => m.file && m.downloadState === 'Done').length === 3
  }, 'all three attachments at Alice')
  await rpc('acceptChat', aliceId, chatAtAlice)

  await page.reload()
  await page.locator('#new-chat-button').waitFor({ state: 'visible', timeout: 120_000 })
  if (!(await page.getByTestId(`selected-account:${aliceId}`).count())) {
    await page.getByTestId(`account-item-${aliceId}`).click()
    await page.getByTestId(`selected-account:${aliceId}`).waitFor({ state: 'attached', timeout: 30_000 })
  }
  await page.locator('.chat-list-item', { hasText: 'Bob Martinez' }).first().click()

  // Only the pack zip becomes a card.
  const card = page.getByTestId('sticker-pack-card')
  await card.waitFor({ timeout: 30_000 })
  await card.locator('img').nth(3).waitFor()
  expect((await card.count()) === 1, 'exactly one zip shows as a sticker pack card')
  expect((await card.textContent()).includes('Cute Animals'), 'card names the pack from the url-quoted folder')
  expect((await card.textContent()).includes('8 stickers'), 'card counts 8 stickers')
  expect(
    await page.locator('.message-attachment-generic', { hasText: 'holiday-notes.zip' }).count(),
    'the other zip stays a plain file tile'
  )
  await shot('01-pack-card-in-chat')

  // Empty sticker tab: find packs + import + manage.
  await page.getByRole('button', { name: 'Emoji' }).last().click()
  await page.getByRole('tab', { name: 'Sticker', exact: true }).click()
  await page.getByRole('button', { name: 'Find Sticker Packs' }).waitFor()
  await shot('02-empty-sticker-tab')
  await page.keyboard.press('Escape')

  // Add the pack from the card.
  await card.getByRole('button', { name: 'Add Sticker Pack' }).click()
  await card.getByRole('button', { name: 'Added' }).waitFor({ timeout: 30_000 })
  const packs = async () => rpc('getStickerPacks', aliceId)
  expect(
    (await packs()).some(p => p.name === 'Cute Animals' && p.stickers.length === 8),
    'the pack was imported with all 8 stickers'
  )
  expect(
    (await packs())[0].stickers[0].path.includes('dc.db-blobs'),
    'pack stickers are blobs (so they are in backups)'
  )
  await shot('03-pack-added')

  await page.getByRole('button', { name: 'Emoji' }).last().click()
  await page.getByRole('tab', { name: 'Sticker', exact: true }).click()
  await page.locator('.sticker-pack .title', { hasText: 'Cute Animals' }).waitFor()
  await shot('04-picker-with-pack')

  // Manage Stickers.
  await page.getByRole('button', { name: 'Manage Stickers' }).click()
  const dialog = page.getByTestId('manage-stickers-dialog')
  await dialog.getByText('Recently Seen').waitFor({ timeout: 30_000 })
  await dialog.getByText('Office Life').waitFor()
  await shot('05-manage-dialog')

  await dialog.getByRole('button', { name: 'New Pack' }).click()
  await page.locator('#sticker-pack-name').fill('Favorites')
  await page.getByRole('button', { name: 'OK' }).click()
  const favorites = dialog.getByTestId('sticker-pack').filter({ hasText: 'Favorites' })
  await favorites.waitFor()
  const animalsPack = dialog.getByTestId('sticker-pack').filter({ hasText: 'Cute Animals' })
  await animalsPack.locator('button[draggable]').first().dragTo(favorites)
  await until(
    async () => (await packs()).find(p => p.name === 'Favorites')?.stickers.length === 1,
    'the dragged sticker in Favorites'
  )
  expect(
    (await packs()).find(p => p.name === 'Cute Animals').stickers.length === 7,
    'dragging moved the sticker out of Cute Animals'
  )

  // Save Bob's single sticker from "Recently Seen".
  const recent = dialog.locator('section', { hasText: 'Recently Seen' })
  await recent.locator('button[draggable]').first().click()
  await page.getByRole('menuitem', { name: 'Add to Pack' }).click()
  await page.getByRole('menuitem', { name: 'Favorites' }).click()
  await until(
    async () => (await packs()).find(p => p.name === 'Favorites')?.stickers.length === 2,
    'the recent sticker in Favorites'
  )
  expect(true, 'a recently seen sticker was added to a pack')
  await dialog.getByText('Recently Seen').waitFor({ state: 'detached' })
  expect(true, 'the saved sticker left "Recently Seen"')

  // Import the other profile's pack.
  await dialog.getByRole('button', { name: 'Import' }).click()
  await until(
    async () => (await packs()).find(p => p.name === 'Office Life')?.stickers.length === 4,
    'Office Life imported'
  )
  expect(true, "the other profile's pack was imported")
  await page.waitForTimeout(500)
  await shot('06-manage-after-edits')

  // Export a pack: the zip is a pack again.
  await animalsPack.getByRole('button', { name: 'More options' }).click()
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('menuitem', { name: 'Export as .zip' }).click(),
  ])
  const exported = unzipSync(new Uint8Array(await readFile(await download.path())))
  const names = Object.keys(exported)
  expect(download.suggestedFilename() === 'Cute Animals.zip', 'export is named after the pack')
  expect(
    names.length === 7 && names.every(n => /^Cute Animals\/\d+\.webp$/.test(n)),
    'export holds the 7 stickers in one folder'
  )
  await page.keyboard.press('Escape')
  await dialog.waitFor({ state: 'detached' })

  // Backup export mentions the packs.
  await page.getByTestId('open-settings-button').click()
  await page.getByRole('button', { name: 'Chats' }).click()
  await page.getByRole('button', { name: 'Export Backup' }).click()
  await page.getByText('Other Delta Chat apps').waitFor({ timeout: 30_000 })
  expect(true, 'backup export warns that other apps lose sticker packs')
  await shot('07-backup-note')

  console.log('PASS: sticker packs work as expected')
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
