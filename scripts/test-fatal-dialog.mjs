// Fatal-start dialog e2e: serve the built web-app and drive the two things a
// user has when the core cannot start — knowing what actually broke, and being
// able to get the error text out of a dead app.
//
// Covers:
//   - a browser without WebAssembly (Safari Lockdown Mode) is named as such,
//     instead of the worker's misleading "stored data could not be loaded"
//   - the copyable report carries the failure kind and the browser
//   - the report block is selectable despite the app's global user-select:none
//   - only one fatal dialog is ever shown, however many fatals arrive
// No ws-tcp-proxy and no core boot needed — the dialog lives in runtime.js.
// Modeled on scripts/test-bridge-dialog.mjs.
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const script = p => fileURLToPath(new URL(p, import.meta.url))
const APP_PORT = Number(process.env.APP_PORT ?? 8646)

const server = spawn('node', [script('../packages/web-app/serve.mjs')], {
  env: { ...process.env, PORT: String(APP_PORT) },
  stdio: 'inherit',
})
const cleanup = () => server.kill()
process.on('exit', cleanup)
await new Promise(r => setTimeout(r, 500)) // let the server bind

const browser = await chromium.launch(
  process.env.CHROMIUM_BIN ? { executablePath: process.env.CHROMIUM_BIN } : {}
)
// the dialog lives in runtime.js; the SW would only add reload races (#72)
const context = await browser.newContext({ serviceWorkers: 'block' })
const page = await context.newPage()
page.on('pageerror', e => console.error('[pageerror]', e.message))

// upstream's avoid-eval.js replaces window.eval with a throwing stub, which
// breaks playwright's evaluate/waitForFunction. Freeze the real eval first.
await page.addInitScript(() => {
  Object.defineProperty(window, 'eval', { value: window.eval, writable: false })
})
// Lockdown Mode's effect: no WebAssembly in the page. Applied before any app
// code runs, which is where the real check happens too.
await page.addInitScript(() => {
  delete globalThis.WebAssembly
})
// ...and in the worker, which addInitScript does not reach. Without this the
// worker boots normally, never reports its own fatal, and check 5 below would
// pass without a second dialog ever having been possible.
await page.route('**/core/worker.js', async route => {
  const res = await route.fetch()
  route.fulfill({
    contentType: 'text/javascript',
    body: 'delete globalThis.WebAssembly;\n' + (await res.text()),
  })
})

const url = `http://localhost:${APP_PORT}/main.html`
await page.goto(url, { waitUntil: 'domcontentloaded' })

const dialog = page.locator('#sc-no-wasm-dialog')
await dialog.waitFor({ state: 'attached', timeout: 20000 })

// --- 1) it names WebAssembly and Lockdown Mode, not storage ----------------
const bodyText = await dialog.locator('p').first().innerText()
for (const phrase of ['WebAssembly', 'Lockdown Mode', 'Website Settings']) {
  if (!bodyText.includes(phrase)) {
    throw new Error(`fatal dialog text is missing ${phrase}: ${bodyText}`)
  }
}
if (/stored data/i.test(bodyText)) {
  throw new Error('no-wasm dialog blames storage — that is the misleading message')
}
console.log('OK: a browser without WebAssembly is told about Lockdown Mode')

// --- 2) the copyable report carries kind + browser -------------------------
const report = await dialog.locator('pre').innerText()
if (!/^failure: no-wasm$/m.test(report)) {
  throw new Error(`report is missing the failure kind: ${report}`)
}
if (!/^browser: .*(Chrome|HeadlessChrome)/m.test(report)) {
  throw new Error(`report is missing the browser: ${report}`)
}
console.log('OK: the report names the failure and the browser')

// --- 3) the report stays selectable under the app's global user-select -----
// _global.scss turns selection off app-wide; a report you cannot select is a
// report you cannot copy where the clipboard API is refused.
const selectable = await dialog
  .locator('pre')
  .evaluate(el => getComputedStyle(el).userSelect)
if (selectable === 'none') {
  throw new Error('report block is not selectable — manual copy fallback is dead')
}
console.log('OK: the report block is selectable')

// --- 4) the copy button puts the report on the clipboard -------------------
await context.grantPermissions(['clipboard-read', 'clipboard-write'], {
  origin: `http://localhost:${APP_PORT}`,
})
// by position, not by text: the button relabels itself on click, so a
// hasText locator would stop matching the moment we press it
const copyBtn = dialog.locator('pre + button')
if ((await copyBtn.innerText()) !== 'Copy details') {
  throw new Error('expected a "Copy details" button right below the report')
}
await copyBtn.click()
const clipboard = await page.evaluate(() => navigator.clipboard.readText())
if (clipboard.trim() !== report.trim()) {
  throw new Error(`clipboard does not match the shown report:\n${clipboard}\n---\n${report}`)
}
if ((await copyBtn.innerText()) !== 'Copied') {
  throw new Error('copy button gave no feedback — silent success reads as broken')
}
console.log('OK: Copy details copies the report and says so')

// --- 5) a second fatal must not bury the first, more specific one ----------
// The worker (broken the same way, above) reports its own generic init-error
// moments later. <dialog> stacks in the top layer, so a second one would bury
// the Lockdown Mode explanation under "the stored data could not be loaded".
await page.waitForTimeout(3000) // let the worker's fatal-init-error land
const dialogCount = await page.locator('dialog[id^="sc-"]').count()
if (dialogCount !== 1) {
  throw new Error(`expected exactly one fatal dialog, found ${dialogCount}`)
}
if (await page.locator('#sc-init-error-dialog').count()) {
  throw new Error('the generic init-error dialog buried the specific one')
}
console.log('OK: the worker’s later init-error does not bury the specific dialog')

await browser.close()
server.kill()
console.log('\nfatal-start dialog: all checks passed')
