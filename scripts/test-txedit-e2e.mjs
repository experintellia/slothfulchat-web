// E2E for the in-app translation editor (packages/web-app/src/translation-editor.ts).
// Fully offline — boots the app to the onboarding screen (translated text, no
// account/network needed) and checks the two things most prone to silent
// regression:
//   (a) the editor opens in a SEPARATE popup window (so app modal dialogs can't
//       cover it), and
//   (c) editing a string LIVE-refreshes the app — the editor must use the
//       runtime handle captured at init, because the frontend deletes window.r
//       right after importing it, which would make the refresh a silent no-op.
//
// Modeled on scripts/test-web-app-e2e.mjs (serve.mjs, avoid-eval freeze,
// __coreSystemInfo boot gate).
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const script = p => fileURLToPath(new URL(p, import.meta.url))
const APP_PORT = Number(process.env.APP_PORT ?? 8655)
const SENTINEL = 'SLOTHTX_SENTINEL_42'

const appServer = spawn('node', [script('../packages/web-app/serve.mjs')], {
  env: { ...process.env, PORT: String(APP_PORT) },
  stdio: 'inherit',
})
const cleanup = () => appServer.kill()
process.on('exit', cleanup)
const watchdog = setTimeout(() => {
  console.error('FAIL: watchdog (4 min) — test hung')
  cleanup()
  process.exit(1)
}, 240_000)
await new Promise(r => setTimeout(r, 600)) // let the server bind

const browser = await chromium.launch()
const context = await browser.newContext()
const page = await context.newPage()
page.on('pageerror', e => console.error('[pageerror]', e.message))
// upstream's avoid-eval.js breaks page.evaluate; freeze the real eval first.
await page.addInitScript(() => {
  Object.defineProperty(window, 'eval', { value: window.eval, writable: false })
})

let failed = false
try {
  await page.goto(`http://localhost:${APP_PORT}/main.html`)
  await page.waitForFunction(() => window.__coreSystemInfo, null, { timeout: 120_000 })
  console.log('OK: wasm core booted')

  // The onboarding screen renders translated text and populates the tx registry.
  const sel = '[data-testid=other-login-button],[data-testid=create-account-button]'
  await page.locator(sel).first().waitFor({ state: 'visible', timeout: 90_000 })

  // Resolve the tx key behind a visible string, from the editor's live registry.
  const picked = await page.evaluate(s => {
    const text = (document.querySelector(s)?.textContent || '').trim()
    const keys = window.__txRegistry && window.__txRegistry.get(text)
    return { text, key: keys ? [...keys][0] : null }
  }, sel)
  if (!picked.key) throw new Error(`no tx key for on-screen text ${JSON.stringify(picked.text)}`)
  console.log(`picked key=${picked.key} text=${JSON.stringify(picked.text)}`)

  // (a) Shortcut opens a real popup window hosting the editor panel.
  const [popup] = await Promise.all([
    context.waitForEvent('page'),
    page.keyboard.press('Control+Shift+L'),
  ])
  await popup.waitForLoadState('domcontentloaded')
  if ((await popup.title()) !== 'Translation editor')
    throw new Error(`popup title = ${await popup.title()}`)
  if ((await popup.locator('[role=dialog][aria-label="Translation editor"]').count()) !== 1)
    throw new Error('editor panel is not inside the popup window')
  console.log('OK (a): editor opened in a separate popup window')

  // (c) Edit that key in the popup; the app must live-refresh.
  await popup.getByRole('searchbox').fill(picked.key)
  const input = popup.locator(`input[aria-label="${picked.key}"]`).first()
  await input.waitFor({ state: 'visible', timeout: 10_000 })
  await input.fill(SENTINEL)
  await input.blur() // fires onchange -> editValue + refreshApp

  await page.waitForFunction(
    ([k, s]) => window.static_translate(k) === s,
    [picked.key, SENTINEL],
    { timeout: 15_000 }
  )
  await page.locator(sel).filter({ hasText: SENTINEL }).first().waitFor({ state: 'visible', timeout: 15_000 })
  console.log('OK (c): edit live-applied — static_translate + on-screen text updated')

  console.log('\nPASS: translation editor e2e')
} catch (e) {
  failed = true
  console.error('FAIL:', e.message)
} finally {
  clearTimeout(watchdog)
  await browser.close()
  cleanup()
  process.exit(failed ? 1 : 0)
}
