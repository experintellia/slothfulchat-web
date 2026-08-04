// Throwaway-session gate e2e: `?persist=0` boots a memory-only core, which is
// a test switch but also a data-loss trap in a link — accounts look gone, and
// anything set up or received in such a session dies with the tab. So it must
// be confirmed before anything starts, and be visible while it runs.
//
// Covers:
//   - an unconfirmed ?persist=0 opens the gate and starts NOTHING (the core
//     worker is never even fetched)
//   - "Keep my data" reloads into a normal, saved session
//   - "Start throwaway session" reloads into the memory-only one, which then
//     says so permanently and non-dismissably
//   - the consent is per tab: another tab on the same link is asked again
// No ws-tcp-proxy and no core boot needed — the gate lives in runtime.js, and
// the core worker is stubbed out. Modeled on scripts/test-fatal-dialog.mjs.
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const script = p => fileURLToPath(new URL(p, import.meta.url))
const APP_PORT = Number(process.env.APP_PORT ?? 8647)

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
// the gate lives in runtime.js; the SW would only add reload races (#72)
const context = await browser.newContext({ serviceWorkers: 'block' })
const url = `http://localhost:${APP_PORT}/main.html`
const THROWAWAY_URL = `${url}?persist=0`

/** A page with the real runtime but a stubbed core worker: whether the core
 * was started is then a single observable fact (did anything fetch it?) and no
 * wasm is ever loaded. */
async function newPage() {
  const page = await context.newPage()
  page.on('pageerror', e => console.error('[pageerror]', e.message))
  // upstream's avoid-eval.js replaces window.eval with a throwing stub, which
  // breaks playwright's evaluate/waitForFunction. Freeze the real eval first.
  await page.addInitScript(() => {
    Object.defineProperty(window, 'eval', { value: window.eval, writable: false })
  })
  const started = { core: false }
  await page.route('**/core/worker.js', route => {
    started.core = true
    route.fulfill({ contentType: 'text/javascript', body: '' })
  })
  return [page, started]
}

const gate = page => page.locator('#sc-throwaway-dialog')
const banner = page => page.locator('#sc-throwaway-toast')

/** Wait until the page asked for the core worker (see newPage), or give up. */
async function coreStarted(page, started, ms = 30000) {
  for (let waited = 0; waited < ms && !started.core; waited += 100) {
    await page.waitForTimeout(100)
  }
  return started.core
}

// --- 1) an unconfirmed ?persist=0 asks first, and starts nothing -----------
const [page, started] = await newPage()
await page.goto(THROWAWAY_URL, { waitUntil: 'domcontentloaded' })
await gate(page).waitFor({ state: 'attached', timeout: 20000 })
const gateText = await gate(page).innerText()
for (const phrase of ['without saving anything', 'erased for good']) {
  if (!gateText.includes(phrase)) {
    throw new Error(`gate does not say what is lost (${phrase}): ${gateText}`)
  }
}
if (await banner(page).count()) {
  throw new Error('a throwaway session is flagged as running before it was agreed to')
}
// long enough for the frontend to have asked for a core if it were going to
await page.waitForTimeout(3000)
if (started.core) {
  throw new Error('the core started before the throwaway session was confirmed')
}
console.log('OK: an unconfirmed ?persist=0 asks first and starts nothing')

// --- 2) "Keep my data" reloads into a normal, saved session ----------------
await page.getByRole('button', { name: 'Keep my data' }).click()
await page.waitForURL(u => !u.searchParams.has('persist'), { timeout: 20000 })
if (!(await coreStarted(page, started))) {
  throw new Error('the normal session never started the core')
}
if (await gate(page).count()) throw new Error('the gate is still up after keeping the data')
if (await banner(page).count()) {
  throw new Error('a saved session is flagged as throwaway')
}
console.log('OK: "Keep my data" drops the flag and starts a normal session')

// --- 3) accepting reloads into the memory-only session, permanently flagged -
const [tab2, started2] = await newPage()
await tab2.goto(THROWAWAY_URL, { waitUntil: 'domcontentloaded' })
await gate(tab2).waitFor({ state: 'attached', timeout: 20000 })
await tab2.evaluate(() => (window.__scPreReload = true))
await tab2.getByRole('button', { name: 'Start throwaway session' }).click()
await tab2.waitForFunction(() => !window.__scPreReload, null, { timeout: 20000 })
await banner(tab2).waitFor({ state: 'attached', timeout: 20000 })
if (await gate(tab2).count()) throw new Error('still asking after the session was confirmed')
if (!/nothing is being saved/i.test(await banner(tab2).innerText())) {
  throw new Error(`the throwaway banner does not say so: ${await banner(tab2).innerText()}`)
}
if (!(await coreStarted(tab2, started2))) {
  throw new Error('the confirmed throwaway session never started the core')
}
console.log('OK: accepting starts the throwaway session and flags it')

// --- 4) the flag cannot be dismissed, and survives a reload ---------------
// It is the only sign that everything on screen is about to be thrown away.
await banner(tab2).evaluate(el => el.click())
await tab2.waitForTimeout(200)
if (!(await banner(tab2).count())) throw new Error('the throwaway banner can be dismissed')
await tab2.reload({ waitUntil: 'domcontentloaded' })
await banner(tab2).waitFor({ state: 'attached', timeout: 20000 })
if (await gate(tab2).count()) throw new Error('the confirmed tab is asked again on reload')
console.log('OK: the flag stays put and the confirmed tab is not re-asked')

// --- 5) the consent is per tab, not per browser ---------------------------
// A second link opened later is a second decision — the first one must not
// silently authorise it.
const [tab3] = await newPage()
await tab3.goto(THROWAWAY_URL, { waitUntil: 'domcontentloaded' })
await gate(tab3).waitFor({ state: 'attached', timeout: 20000 })
console.log('OK: another tab on the same link is asked again')

await context.close()
await browser.close()
server.kill()
console.log('\nthrowaway-session gate: all checks passed')
