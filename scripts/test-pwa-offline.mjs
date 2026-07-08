// PWA offline app-shell test: load the app once online (SW installs +
// precaches), KILL the static server (playwright's setOffline doesn't apply
// to service workers in Chromium), reload, and assert the full app — frontend
// AND wasm core — boots from the service worker cache. Also asks Chrome for
// PWA installability errors via CDP. Modeled on scripts/smoke-web-app.mjs.
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const script = p => fileURLToPath(new URL(p, import.meta.url))
const APP_PORT = Number(process.env.APP_PORT ?? 8652)

let server = spawn('node', [script('../packages/web-app/serve.mjs')], {
  env: { ...process.env, PORT: String(APP_PORT) },
  stdio: 'inherit',
})
const cleanup = () => server?.kill()
process.on('exit', cleanup)
await new Promise(r => setTimeout(r, 500))

const browser = await chromium.launch()
const page = await browser.newPage()
const consoleTail = []
page.on('console', m => consoleTail.push(m.text().slice(0, 300)))

// see smoke-web-app.mjs: freeze eval so avoid-eval.js can't break playwright
await page.addInitScript(() => {
  Object.defineProperty(window, 'eval', { value: window.eval, writable: false })
})

const waitForBoot = async label => {
  // polling: interval — default rAF polling can stall in headless after reload
  await page.waitForFunction(() => window.__coreSystemInfo, null, {
    timeout: 120_000,
    polling: 250,
  })
  await page.waitForFunction(
    () => {
      const root = document.getElementById('root')
      return root && root.children.length > 0 && root.innerHTML.length > 500
    },
    null,
    { timeout: 60_000, polling: 250 }
  )
  console.log(`OK: app booted ${label}`)
}

let failed = false
try {
  // online visit: SW registers, activates, precaches the shell
  await page.goto(`http://localhost:${APP_PORT}/main.html`)
  await waitForBoot('online')
  await page.evaluate(() => navigator.serviceWorker.ready)
  // ready resolves on activation; install (precache) finished before that
  console.log('OK: service worker active')

  const cdp = await page.context().newCDPSession(page)
  const { installabilityErrors } = await cdp.send('Page.getInstallabilityErrors')
  if (installabilityErrors.length > 0) {
    console.error('FAIL: installability errors:', JSON.stringify(installabilityErrors))
    failed = true
  } else {
    console.log('OK: Chrome reports no installability errors')
  }
  // detach BEFORE reload: an attached CDP session keeps the old page's core
  // worker alive, its OPFS handles never release, and the new core can't start
  await cdp.detach()

  // go offline for real: no server at all
  server.kill()
  server = null

  // Cold offline start (the real PWA scenario: open the installed app later).
  // NOT page.reload(): an instant reload races the old core worker's OPFS
  // sync-access-handle release — a pre-existing issue unrelated to the SW
  // (network reloads are just slow enough to usually win that race).
  await page.goto('about:blank')
  await new Promise(r => setTimeout(r, 1000)) // let the old worker die
  await page.goto(`http://localhost:${APP_PORT}/main.html`)
  await waitForBoot('OFFLINE (server down)')
} catch (err) {
  console.error('FAIL:', err.message)
  console.error('--- last page console lines ---')
  console.error(consoleTail.slice(-40).join('\n'))
  failed = true
} finally {
  await browser.close()
  cleanup()
}
console.log(failed ? 'VERDICT: offline app shell: NO' : 'VERDICT: offline app shell: YES')
process.exit(failed ? 1 : 0)
