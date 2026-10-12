// E2E check for the composer grammar checker's Harper engine (desktop/1065),
// FULLY OFFLINE like scripts/shot-profile-description.mjs (mock madmail).
//
// Asserts that nothing under harper/ is fetched while the checker is off or
// merely being configured, that the dialog offers Harper / LanguageTool cloud /
// LanguageTool self-hosted with Harper preselected, and that once the switch
// is on, a typo in the composer gets underlined and its suggestion card
// replaces it. Shots land in .cache/grammar-check-shots/.
//
// Requires packages/core-wasm built and packages/web-app assembled+built.
// Run:  node scripts/test-grammar-check-e2e.mjs
// (CHROMIUM_BIN=/path/to/chrome overrides the playwright-managed browser.)
import { mkdir } from 'node:fs/promises'
import { chromium } from 'playwright'
import { freezeEval, logPanics, script, startServers } from './harness.mjs'
import { startMockMadmail } from './mock-madmail.mjs'

const SHOTS = script('../.cache/grammar-check-shots/')
await mkdir(SHOTS, { recursive: true })
const APP_PORT = 8681

const mock = await startMockMadmail()
const { cleanup, watchdog } = await startServers({
  app: APP_PORT,
  settleMs: 700,
  watchdogMs: 300_000,
})

const browser = await chromium.launch(
  process.env.CHROMIUM_BIN ? { executablePath: process.env.CHROMIUM_BIN } : {}
)
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
logPanics(page)
page.on('pageerror', e => console.error('[pageerror]', e.message))
await freezeEval(page)
const harperRequests = []
page.on('request', r => r.url().includes('/harper/') && harperRequests.push(r.url()))
const rpc = (method, ...args) =>
  page.evaluate(([m, a]) => window.exp.rpc[m](...a), [method, args])
const expect = (cond, msg) => {
  if (!cond) throw new Error(msg)
  console.log(`OK: ${msg}`)
}

let failed = false
try {
  await page.goto(`http://localhost:${APP_PORT}/main.html`)
  await page.waitForFunction(() => window.__coreSystemInfo, null, {
    timeout: 120_000,
  })
  const id = await rpc('addAccount')
  await rpc('addTransportFromQr', id, `webimapaccount:127.0.0.1:${mock.port}`)
  await rpc('setConfig', id, 'displayname', 'Alice')
  await rpc('startIo', id)
  await rpc('createChatByContactId', id, 1) // Saved Messages
  await page.reload()
  await page.locator('#new-chat-button').waitFor({ state: 'visible', timeout: 120_000 })

  // pick the checker first (dialog), then switch it on
  await page.getByTestId('open-settings-button').click()
  await page.getByText('Experimental Features').click()
  await page.getByText('Checker', { exact: true }).click()
  const dialog = page.locator('dialog').filter({ hasText: 'Grammar & spelling checker' })
  for (const label of ['Harper', 'LanguageTool cloud', 'LanguageTool self-hosted']) {
    await dialog.getByText(label, { exact: true }).waitFor()
  }
  expect(
    await dialog.locator('input[value="harper"]').isChecked(),
    'the dialog offers all three checkers, Harper preselected'
  )
  expect(
    (await dialog.getByRole('button', { name: 'Check connection' }).count()) === 0,
    'no connection check (which would load Harper) while Harper is picked'
  )
  await dialog.screenshot({ path: `${SHOTS}/dialog.png` })
  await dialog.getByRole('button', { name: 'Save' }).click()
  expect(harperRequests.length === 0, 'nothing of Harper loaded while the checker is off')
  await page.getByText('Grammar & spelling checker', { exact: true }).click()
  await page.screenshot({ path: `${SHOTS}/settings.png` })
  await page.keyboard.press('Escape')

  await page
    .locator('.chat-list .chat-list-item')
    .filter({ hasText: 'Saved Messages' })
    .first()
    .click()
  const composer = page.locator('#composer-textarea-non-edit')
  await composer.fill('This are a tset.')
  const issue = page.locator('.language-tool-issue', { hasText: 'tset' })
  await issue.waitFor({ timeout: 90_000 })
  expect(harperRequests.some(u => u.endsWith('.wasm')), 'Harper loaded once switched on')
  await composer.click()
  await page.keyboard.press('End')
  for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowLeft')
  const card = page.locator('.language-tool-card')
  await card.waitFor()
  await page.screenshot({ path: `${SHOTS}/card.png` })
  await card.getByRole('button', { name: 'test', exact: true }).click()
  expect((await composer.inputValue()) === 'This are a test.', 'the suggestion replaced the typo')
} catch (e) {
  failed = true
  console.error('FAIL:', e)
  await page.screenshot({ path: `${SHOTS}/failure.png` }).catch(() => {})
} finally {
  clearTimeout(watchdog)
  await browser.close().catch(() => {})
  mock.close()
  cleanup()
}
process.exit(failed ? 1 : 0)
