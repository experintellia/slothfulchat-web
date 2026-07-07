// Web-app boot smoke test: start the ws-tcp proxy + web-app static server,
// load main.html headless, assert the frontend renders past a blank screen
// and the wasm core answers rpc. Modeled on scripts/smoke-core-wasm.mjs.
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const script = p => fileURLToPath(new URL(p, import.meta.url))
const PROXY_PORT = Number(process.env.PROXY_PORT ?? 8641)
const APP_PORT = Number(process.env.APP_PORT ?? 8642)

const procs = [
  spawn('node', [script('./ws-tcp-proxy.mjs')], {
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
await new Promise(r => setTimeout(r, 500)) // let servers bind

const browser = await chromium.launch()
const page = await browser.newPage()
const consoleTail = []
page.on('console', m => consoleTail.push(m.text().slice(0, 300)))
const pageErrors = []
page.on('pageerror', e => {
  pageErrors.push(e.message)
  console.error('[pageerror]', e.message)
})

// upstream's avoid-eval.js replaces window.eval with a throwing stub, which
// breaks playwright's evaluate/waitForFunction. Freeze the real eval first
// (the app's assignment then silently no-ops; its own local stub still works).
await page.addInitScript(() => {
  Object.defineProperty(window, 'eval', { value: window.eval, writable: false })
})

let failed = false
try {
  await page.goto(
    `http://localhost:${APP_PORT}/main.html?proxy=ws://localhost:${PROXY_PORT}`
  )

  // wasm core booted and answers rpc (marker set by our runtime.js)
  await page.waitForFunction(() => window.__coreSystemInfo, null, {
    timeout: 120_000,
  })
  const info = await page.evaluate(() => window.__coreSystemInfo)
  console.log(`OK: wasm core booted (core ${info.deltachat_core_version})`)

  // frontend rendered something real (zero accounts -> onboarding/welcome)
  await page.waitForFunction(
    () => {
      const root = document.getElementById('root')
      return root && root.children.length > 0 && root.innerHTML.length > 500
    },
    null,
    { timeout: 60_000 }
  )
  const snippet = await page.evaluate(() => ({
    html: document.getElementById('root').innerHTML.length,
    text: document.getElementById('root').innerText.slice(0, 200),
    classes: [...document.querySelectorAll('#root [class]')]
      .slice(0, 8)
      .map(e => e.className.toString().split(' ')[0]),
  }))
  console.log('OK: frontend rendered #root:', JSON.stringify(snippet))

  if (pageErrors.length > 0) {
    console.error(`FAIL: ${pageErrors.length} uncaught page error(s)`)
    failed = true
  }
} catch (err) {
  console.error('FAIL:', err.message)
  console.error('--- last page console lines ---')
  console.error(consoleTail.slice(-40).join('\n'))
  failed = true
} finally {
  await browser.close()
  cleanup()
}
console.log(failed ? 'VERDICT: frontend boots on wasm core: NO' : 'VERDICT: frontend boots on wasm core: YES')
process.exit(failed ? 1 : 0)
