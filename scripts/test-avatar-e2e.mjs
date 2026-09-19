// Offline UI end-to-end test for setting your own avatar: Settings -> Your
// Profile -> pick an image -> crop -> OK, then assert the core actually
// ingested it (selfavatar config + a readable blob on the self contact).
//
// The whole chain is web-specific and has no other coverage: our file picker
// stages the pick into the core memfs, the cropper reads it back through the
// blobs service worker, draws it on a canvas and writes the result out as a
// temp file, and only then does setConfig('selfavatar') copy it into the
// blobdir and recode it.
//
// Fully offline, like scripts/shot-voice-player.mjs: one webimap account
// against the in-process mock madmail server.
//
// Requires packages/core-wasm built and packages/web-app assembled+built.
// Run:  node scripts/test-avatar-e2e.mjs
import { chromium } from 'playwright'
import { startServers } from './harness.mjs'
import { startMockMadmail } from './mock-madmail.mjs'

const APP_PORT = Number(process.env.APP_PORT ?? 8679)

const mock = await startMockMadmail()
const QR = `webimapaccount:127.0.0.1:${mock.port}`
console.log(`mock madmail on 127.0.0.1:${mock.port}`)

const { cleanup, watchdog } = await startServers({
  app: APP_PORT,
  settleMs: 700,
  watchdogMs: 300_000,
  label: 'avatar-e2e',
})

const browser = await chromium.launch(
  process.env.CHROMIUM_BIN ? { executablePath: process.env.CHROMIUM_BIN } : {}
)
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
page.on('console', m => {
  const t = m.text()
  if (/panicked at|Error|error/.test(t)) console.log('[page]', t.slice(0, 300))
})
page.on('pageerror', e => console.error('[pageerror]', e.message))
await page.addInitScript(() => {
  Object.defineProperty(window, 'eval', { value: window.eval, writable: false })
})
const rpc = (method, ...args) =>
  page.evaluate(([m, a]) => window.exp.rpc[m](...a), [method, args])

let failed = false
try {
  await page.goto(`http://localhost:${APP_PORT}/main.html`)
  await page.waitForFunction(() => window.__coreSystemInfo, null, {
    timeout: 120_000,
  })
  console.log('OK: wasm core booted')

  const accountId = await rpc('addAccount')
  await rpc('addTransportFromQr', accountId, QR)
  await rpc('setConfig', accountId, 'displayname', 'Avatar Tester')
  console.log(`OK: account ${accountId} configured`)

  await page.reload()
  await page
    .locator('#new-chat-button')
    .waitFor({ state: 'visible', timeout: 120_000 })

  // --- the UI flow ---
  await page.getByTestId('open-settings-button').click()
  await page.getByTestId('edit-profile-button').click()
  const chooser = page.waitForEvent('filechooser', { timeout: 30_000 })
  await page.getByRole('button', { name: 'Select Profile Image' }).click()
  // A non-square pick, so the cropper takes its canvas path (crop + re-encode
  // + writeTempFileFromBase64) rather than just copying the file through.
  const pngBase64 = await page.evaluate(() => {
    const c = document.createElement('canvas')
    c.width = 300
    c.height = 180
    const x = c.getContext('2d')
    x.fillStyle = '#2f7d4f'
    x.fillRect(0, 0, c.width, c.height)
    x.fillStyle = '#d4442f'
    x.fillRect(30, 20, 120, 90)
    return c.toDataURL('image/png').split(',')[1]
  })
  await (await chooser).setFiles({
    name: 'my-new-avatar.png',
    mimeType: 'image/png',
    buffer: Buffer.from(pngBase64, 'base64'),
  })
  console.log('OK: picked an image')

  const cropper = page.locator('dialog[open]').filter({ hasText: 'Crop' })
  await cropper.waitFor({ state: 'visible', timeout: 30_000 })
  await cropper.getByRole('button', { name: 'Save', exact: true }).click()
  await cropper.waitFor({ state: 'detached', timeout: 30_000 })
  console.log('OK: cropped')

  await page.getByTestId('ok').click()

  // --- did the core ingest it? ---
  const deadline = Date.now() + 30_000
  let selfavatar = ''
  while (Date.now() < deadline) {
    selfavatar = (await rpc('getConfig', accountId, 'selfavatar')) || ''
    if (selfavatar) break
    await new Promise(r => setTimeout(r, 300))
  }
  if (!selfavatar) throw new Error('selfavatar config is still empty')
  console.log(`OK: selfavatar = ${selfavatar}`)

  const selfContact = await rpc('getContact', accountId, 1)
  if (!selfContact.profileImage) {
    throw new Error('self contact has no profileImage')
  }
  // The blob must be a real image the app can serve: fetch it back through
  // the blobs service worker, the same way every avatar in the UI is drawn.
  const bytes = await page.evaluate(async path => {
    const url = window.exp.runtime.transformBlobURL(path)
    const resp = await fetch(url)
    if (!resp.ok) throw new Error(`blob fetch ${resp.status} for ${url}`)
    const blob = await resp.blob()
    const bitmap = await createImageBitmap(blob)
    return { size: blob.size, type: blob.type, w: bitmap.width, h: bitmap.height }
  }, selfContact.profileImage)
  if (!bytes.size || !bytes.w || !bytes.h) {
    throw new Error(`avatar blob is not a usable image: ${JSON.stringify(bytes)}`)
  }
  console.log(`OK: avatar blob decodes — ${JSON.stringify(bytes)}`)

  // ...and the settings screen shows it, without a reload
  await page
    .getByTestId('edit-profile-button')
    .locator('img')
    .first()
    .waitFor({ state: 'visible', timeout: 15_000 })
  console.log('OK: settings shows the new avatar')

  console.log('PASS: the new avatar was ingested')
} catch (err) {
  failed = true
  console.error('FAIL:', err.message)
  await page.screenshot({ path: '/tmp/avatar-e2e-fail.png' }).catch(() => {})
} finally {
  clearTimeout(watchdog)
  await browser.close().catch(() => {})
  mock.close()
  cleanup()
  process.exit(failed ? 1 : 0)
}
