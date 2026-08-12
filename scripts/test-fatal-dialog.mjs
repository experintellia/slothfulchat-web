// Fatal-start dialog e2e: serve the built web-app and drive the two things a
// user has when the core cannot start — knowing what actually broke, and being
// able to get the error text out of a dead app.
//
// Covers:
//   - a browser without WebAssembly (Safari Lockdown Mode) is named as such,
//     instead of the worker's misleading "stored data could not be loaded"
//   - the copyable report carries the failure kind and the browser
//   - the report block is selectable despite the app's global user-select:none
//   - only one fatal dialog is ever shown, however many fatals arrive, and
//     boot-error.js's generic "browser too old" guess stands down for it
//   - a failure the USER can fix leads with the fix: the report and its send
//     buttons start collapsed behind a disclosure (open only for our own bugs)
//   - the dialog actually renders as a dialog, not just as the right text
//     in the right elements (#211)
//   - a report button carries the failure, the worker's error, its stack and
//     the origin to the configured destination, says what the tracker costs
//     before it is pressed, and does not exist at all on an instance that
//     configured no destination (#176)
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

// --- 2) first aid first, then the copyable report carries kind + browser ---
// no-wasm is a failure the USER can fix (turn off Lockdown Mode for this
// site), so the report and its send buttons start COLLAPSED: the sentence
// saying what to do must be the biggest thing on the screen, not a wall of
// monospace. Section 8 asserts the opposite default for a failure of ours.
const details = dialog.locator('details.sc-details')
if (await details.evaluate(d => d.open)) {
  throw new Error('a user-fixable failure buries its first aid under an open report')
}
// expanding is what a reporting user does — and what makes the <pre> below
// visible to innerText
await details.locator('summary').click()
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
// an unstyled pile of nodes in the corner — which is what these dialogs render
// if ui-shared's stylesheet does not reach them.
await assertDialogRendered(dialog, 400, 'fatal dialog')
console.log('OK: the fatal dialog is a centred, styled modal')

// ...and that assertion has teeth: take the overlay stylesheet away — every
// declaration these dialogs render with is in it — and it must fail.
// Destructive, so it runs last of the checks that touch this dialog.
await page.evaluate(() => document.getElementById('sc-overlay-css')?.remove())
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

// ...and neither does boot-error.js's guess. It listens for window-level
// errors and can only offer "your browser may be too old", which would sit
// behind this dialog contradicting it — with its own copy button and a
// first-aid step for a problem the user does not have. Dispatched by hand
// because in this scenario nothing reaches window.onerror on its own: #root is
// empty (the app never mounted), so without the stand-down it WOULD paint.
await page.evaluate(() =>
  window.dispatchEvent(new ErrorEvent('error', { message: 'simulated late boot error' }))
)
if (await page.locator('#sc-boot-error').count()) {
  throw new Error('the "browser too old" screen painted itself behind a specific fatal dialog')
}
console.log('OK: the generic boot-error guess stands down for a specific fatal')

await context.close()

// --- 7) a second fatal must not bury the first, more specific one ----------
// Driven by a stub worker rather than the real one, so the second fatal is
// definitely sent: asserting "only one dialog" against a worker that might
// never have reported twice would pass whether or not anything was suppressed.
// Check 7a proves the stub's messages do reach the page's handler; 7b then
// shows the second one being swallowed.
async function withStubWorker(body, { config, inspect } = {}) {
  const ctx = await browser.newContext({ serviceWorkers: 'block' })
  const p = await ctx.newPage()
  await p.addInitScript(() => {
    Object.defineProperty(window, 'eval', { value: window.eval, writable: false })
  })
  // same instance-config injection as test-bridge-dialog.mjs: replace config.js
  // wholesale rather than patching the object, because the real file assigns
  // window.__slothfulConfig and would overwrite anything set before it
  if (config) {
    await p.route('**/config.js', route =>
      route.fulfill({
        contentType: 'text/javascript',
        body: `window.__slothfulConfig=${JSON.stringify(config)}\n`,
      })
    )
  }
  await p.route('**/core/worker.js', route =>
    route.fulfill({ contentType: 'text/javascript', body })
  )
  await p.goto(url, { waitUntil: 'domcontentloaded' })
  await p.waitForTimeout(4000)
  const ids = await p.evaluate(() =>
    [...document.querySelectorAll('dialog')].filter(d => d.open).map(d => d.id)
  )
  if (inspect) await inspect(p)
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

// --- 8) a report button exists only where a destination is configured ------
// #176's own requirement: with neither destination set the button must be
// ABSENT, not present and dead — on a screen where nothing works, a button
// that goes nowhere is worse than no button. Both halves drive the identical
// failure, so the config is the only difference between them.
// The two destinations are separate buttons because they cost the user
// different things, so this also checks that the difference is stated before
// the click rather than after it.
// The stub's stack is the frames-only shape Firefox and Safari produce (V8
// repeats the message on the first line); it is the case where a naive join
// would drop the message that names the failure.
const INIT_FATAL = `self.postMessage({
  type: 'fatal-init-error',
  message: 'Error: sahpool install failed: NotFoundError',
  stack: 'install@https://web.slothful.chat/core/worker.js:311:9',
})`

let href = ''
let shown = ''
let labels = []
let note = ''
await withStubWorker(INIT_FATAL, {
  config: {
    instanceName: 'FatalTest',
    crashReportUrl: 'https://report.example.test/crash',
    supportUrl: 'https://tracker.example.test/issues/new',
  },
  inspect: async p => {
    // ours, so no first aid to bury: the report is open on arrival
    if (!(await p.locator('#sc-init-error-dialog details.sc-details').evaluate(d => d.open))) {
      throw new Error('a failure of ours hides its report behind a click for no reason')
    }
    const links = p.locator('#sc-init-error-dialog a.sc-btn')
    labels = await links.allInnerTexts()
    href = await links.first().getAttribute('href')
    shown = await p.locator('#sc-init-error-dialog pre').innerText()
    note = await p.locator('#sc-init-error-dialog .sc-note').innerText()
  },
})
// the no-account one first: it is the one most people can actually finish
if (labels.length !== 2 || !/developers/i.test(labels[0]) || !/issue/i.test(labels[1])) {
  throw new Error(`expected [Send to the developers, Open an issue], got ${JSON.stringify(labels)}`)
}
if (!href.startsWith('https://report.example.test/crash?')) {
  throw new Error(`the no-account button points somewhere unexpected: ${href}`)
}
// the tracker's price has to be visible BEFORE the click, on a screen with no back
for (const needle of ['account', 'public']) {
  if (!note.includes(needle)) throw new Error(`the choice note never mentions ${needle}: ${note}`)
}
if (/anonym/i.test(note)) {
  throw new Error(`the note claims anonymity we cannot keep — the request carries an IP: ${note}`)
}
// searchParams, not decodeURIComponent: URLSearchParams writes spaces as '+',
// which decodeURIComponent leaves alone — every needle below would miss
const sent = new URL(href).searchParams.get('body')
for (const [what, needle] of [
  ['the failure kind', 'failure: init-error'],
  ["the worker's error text", 'sahpool install failed'],
  ['the stack', 'install@'],
  ['the origin, which names the deployment', `origin: http://localhost:${APP_PORT}`],
  ['the browser', 'browser: Mozilla/5.0'],
]) {
  if (!sent.includes(needle)) throw new Error(`the report link is missing ${what}: ${sent}`)
}
// what the user is asked to send has to be what they were shown
for (const needle of ['sahpool install failed', 'install@']) {
  if (!shown.includes(needle)) {
    throw new Error(`the dialog sends more than it shows — missing ${needle}: ${shown}`)
  }
}
console.log('OK: both buttons offered, cheaper one first, each cost named up front')
console.log('OK: the report carries kind, error, stack and origin to the configured URL')

let anchors = -1
let copyButtons = -1
await withStubWorker(INIT_FATAL, {
  config: { instanceName: 'FatalTest' },
  inspect: async p => {
    anchors = await p.locator('#sc-init-error-dialog a.sc-btn').count()
    copyButtons = await p.locator('#sc-init-error-dialog pre + button').count()
  },
})
if (anchors !== 0) {
  throw new Error(`an unconfigured instance still renders ${anchors} report link(s)`)
}
if (copyButtons !== 1) {
  throw new Error('no copy button either — an unconfigured instance has no way to report at all')
}
console.log('OK: no destination configured → no button, and Copy details still there')

await browser.close()
cleanup()
console.log('\nfatal-start dialog: all checks passed')
