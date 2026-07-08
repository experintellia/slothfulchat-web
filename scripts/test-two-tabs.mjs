// Two-tab test: the core runs once per origin (exclusive OPFS lock). A second
// tab must show the "already running in another tab" dialog (raised when the
// core worker's 15s OPFS probe gives up) instead of a silently dead app, and
// a plain single-tab reload must NOT show it. Modeled on smoke-web-app.mjs.
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const script = p => fileURLToPath(new URL(p, import.meta.url))
const APP_PORT = Number(process.env.APP_PORT ?? 8653)
const DIALOG = '#sc-already-running-dialog'

let server = spawn('node', [script('../packages/web-app/serve.mjs')], {
  env: { ...process.env, PORT: String(APP_PORT) },
  stdio: 'inherit',
})
process.on('exit', () => server?.kill())
await new Promise(r => setTimeout(r, 500))

const browser = await chromium.launch()
const context = await browser.newContext()
// see smoke-web-app.mjs: freeze eval so avoid-eval.js can't break playwright
await context.addInitScript(() => {
  Object.defineProperty(window, 'eval', { value: window.eval, writable: false })
})
const url = `http://localhost:${APP_PORT}/main.html`
const bootMarker = page =>
  page.waitForFunction(() => window.__coreSystemInfo, null, { timeout: 120_000, polling: 250 })

let failed = false
try {
  const tab1 = await context.newPage()
  await tab1.goto(url)
  await bootMarker(tab1)
  console.log('OK: tab 1 booted')

  const tab2 = await context.newPage()
  await tab2.goto(url)
  await tab2.waitForSelector(DIALOG, { state: 'visible', timeout: 30_000 })
  console.log('OK: tab 2 shows the "already running in another tab" dialog')
  if (!(await tab1.evaluate(() => !!window.__coreSystemInfo))) {
    throw new Error('tab 1 broke when tab 2 opened')
  }
  console.log('OK: tab 1 unaffected')
  await tab2.close()

  // single-tab reload must not false-positive the dialog
  await tab1.reload()
  await bootMarker(tab1)
  if (await tab1.$(DIALOG)) throw new Error('dialog shown on a plain single-tab reload')
  console.log('OK: no dialog on single-tab reload, core rebooted')
} catch (err) {
  console.error('FAIL:', err.message)
  failed = true
} finally {
  await browser.close()
  server.kill()
  server = null
}
console.log(failed ? 'VERDICT: two-tab handling: NO' : 'VERDICT: two-tab handling: YES')
process.exit(failed ? 1 : 0)
