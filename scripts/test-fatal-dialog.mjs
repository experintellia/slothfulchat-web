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
//   - the dialog actually renders as a dialog, not just as the right text
//     in the right elements (#211)
// No ws-tcp-proxy and no core boot needed — the dialog lives in runtime.js.
// Modeled on scripts/test-bridge-dialog.mjs.
import { chromium } from 'playwright'
import { assertDialogRendered, startServers } from './harness.mjs'

const APP_PORT = Number(process.env.APP_PORT ?? 8646)

const { cleanup } = await startServers({ app: APP_PORT })

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
// worker boots normally, never reports its own fatal, and check 6 below would
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

// --- 3) the report stays selectable ---------------------------------------
// A report you cannot select is a report you cannot copy where the clipboard
// API is refused. Nothing targets a bare <pre> today (the app's global
// user-select:none covers headings and buttons), so this guards the inline
// userSelect against a future global rule rather than an existing one.
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

// --- 5) it renders as a dialog, not just as the right words ----------------
// Checks 1-4 are text and structure, and all four pass just as happily against
// an unstyled pile of nodes in the corner — which is what a refactor moving
// this construction into a <template> would render if it lost its stylesheet.
await assertDialogRendered(dialog, 400, 'fatal dialog')
console.log('OK: the fatal dialog is a centred, styled modal')

// ...and that assertion has teeth: strip the inline styles the dialog is built
// from — what a <template> refactor that failed to load its stylesheet would
// leave behind — and it must fail. Destructive, so it runs last of the checks
// that touch this dialog.
await dialog.evaluate(root => {
  for (const n of [root, ...root.querySelectorAll('*')]) n.removeAttribute('style')
})
let noticed = false
try {
  await assertDialogRendered(dialog, 400, 'fatal dialog')
} catch {
  noticed = true
}
if (!noticed) {
  throw new Error('render checks pass on an unstyled dialog — they earn nothing')
}
console.log('OK: the render checks fail when the styling is gone')

// --- 6) nothing else piles onto the error screen ---------------------------
// The bridge probe runs at startup and its toast opens the bridge dialog on
// click — over the explanation of what actually broke, and about a problem the
// user does not have: the core never started, so the bridge is irrelevant.
await page.waitForTimeout(3000) // long enough for the probe to time out
if (await page.locator('#sc-bridge-toast, #sc-bridge-hint').count()) {
  throw new Error('the bridge warning is still on screen next to a fatal dialog')
}
console.log('OK: the bridge warning stays out of the way of a fatal dialog')

await context.close()

// --- 7) a second fatal must not bury the first, more specific one ----------
// Driven by a stub worker rather than the real one, so the second fatal is
// definitely sent: asserting "only one dialog" against a worker that might
// never have reported twice would pass whether or not anything was suppressed.
// Check 7a proves the stub's messages do reach the page's handler; 7b then
// shows the second one being swallowed.
async function withStubWorker(body) {
  const ctx = await browser.newContext({ serviceWorkers: 'block' })
  const p = await ctx.newPage()
  await p.addInitScript(() => {
    Object.defineProperty(window, 'eval', { value: window.eval, writable: false })
  })
  await p.route('**/core/worker.js', route =>
    route.fulfill({ contentType: 'text/javascript', body })
  )
  await p.goto(url, { waitUntil: 'domcontentloaded' })
  await p.waitForTimeout(4000)
  const ids = await p.evaluate(() =>
    [...document.querySelectorAll('dialog')].filter(d => d.open).map(d => d.id)
  )
  await ctx.close()
  return ids
}

// 7a) one fatal from the stub — proves delivery, so 7b cannot pass vacuously
const single = await withStubWorker(
  `self.postMessage({ type: 'fatal-opfs-locked' })`
)
if (!single.includes('sc-already-running-dialog')) {
  throw new Error(`stub worker's fatal never reached the page: ${JSON.stringify(single)}`)
}
console.log('OK: a fatal posted by the worker opens its dialog')

// 7b) the specific one first, then a generic one 800ms later
const both = await withStubWorker(`
  self.postMessage({ type: 'fatal-init-error', message: 'Error: sahpool install failed' })
  setTimeout(() => self.postMessage({ type: 'fatal-opfs-locked' }), 800)
`)
if (both.length !== 1 || both[0] !== 'sc-init-error-dialog') {
  throw new Error(`the later generic fatal buried the specific one: ${JSON.stringify(both)}`)
}
console.log('OK: a later, less specific fatal does not bury the first')

await browser.close()
cleanup()
console.log('\nfatal-start dialog: all checks passed')
