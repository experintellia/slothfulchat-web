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
  spawn('node', [script('../packages/ws-tcp-proxy/ws-tcp-proxy.mjs')], {
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
// CSP violations surface as console errors ("Refused to ..."). The Lottie
// sticker player must stay eval-free to satisfy script-src 'self'
// 'wasm-unsafe-eval'; a regression to an eval-using build would show up here.
const cspViolations = []
page.on('console', m => {
  const t = m.text()
  if (
    m.type() === 'error' &&
    /Content Security Policy|Refused to (?:evaluate|execute|run)/.test(t)
  ) {
    cspViolations.push(t.slice(0, 300))
  }
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

  // Lottie sticker support: the animated-sticker player (lottie-web) must be
  // bundled, otherwise .tgs stickers silently fall back to a broken image.
  // Assert it shipped in the served bundle. (A full render e2e needs a
  // two-account message carrying a .tgs — left as follow-up.)
  const lottieBundled = await page.evaluate(async appPort => {
    const src = await (await fetch(`http://localhost:${appPort}/bundle.js`)).text()
    // These are lottie-web-internal player methods (not our own component code,
    // which only calls loadAnimation/goToAndStop/destroy), so this fails if the
    // player itself didn't bundle — not merely if our component shipped.
    return /registerAnimation/.test(src) && /setSubframeRendering/.test(src)
  }, APP_PORT)
  if (!lottieBundled) {
    throw new Error('lottie-web sticker player missing from bundle.js')
  }
  console.log('OK: lottie sticker player bundled')

  // -- regression: an SW-controlled reload must still deliver the proxy config
  // to the core worker. The app-shell SW serves the precached worker.js whose
  // response URL (= the worker's import.meta.url) has no query params, so the
  // config rides a postMessage from startCore now — see core-wasm's index.ts.
  await page.evaluate(() => navigator.serviceWorker.ready)
  console.log('OK: service worker active')
  consoleTail.length = 0
  await page.reload()
  // polling: interval — rAF polling can stall in headless after reload.
  // timeout: generous. After reload the new worker can't take the OPFS lock
  // until the *previous* worker is fully torn down; core-wasm's
  // waitForOpfsSyncHandles retries 30× with a 2s probe timeout each (worker.ts),
  // so the lock handoff alone can burn ~75s on a loaded/headless CI runner
  // before wasm re-init + core re-boot even start. 120s was right at the edge
  // and flaked in CI; give the slow-but-correct handoff room to finish.
  await page.waitForFunction(() => window.__coreSystemInfo && window.exp?.rpc, null, {
    timeout: 240_000,
    polling: 250,
  })
  if (!(await page.evaluate(() => navigator.serviceWorker.controller !== null))) {
    throw new Error('page not SW-controlled after reload — regression phase tests nothing')
  }
  // force a core network attempt: configure against a dead host. Through a
  // configured proxy this fails with DNS/connect errors; a worker that lost
  // its config fails with "no WebSocket proxy configured" instead.
  const configureError = await page.evaluate(async () => {
    const id = await window.exp.rpc.addAccount()
    await window.exp.rpc.batchSetConfig(id, {
      addr: 'smoke@sw-regression.invalid',
      mail_pw: 'x',
      mail_server: 'sw-regression.invalid',
      send_server: 'sw-regression.invalid',
    })
    return await window.exp.rpc.configure(id).then(() => '', e => String(e?.message ?? e))
  })
  const spam = [configureError, ...consoleTail].filter(t =>
    t.includes('no WebSocket proxy configured')
  )
  if (spam.length > 0) {
    throw new Error(`worker lost its proxy config behind the SW: ${spam[0].slice(0, 200)}`)
  }
  console.log(
    `OK: SW-served worker kept proxy config (dead-host configure failed with: ${configureError.slice(0, 120)})`
  )

  // Sticker picker backend: its core RPCs must round-trip on the wasm memfs
  // (misc_get_sticker_folder does create_dir_all; misc_get_stickers does
  // read_dir on the account's stickers/ dir, which lives outside the blobdir).
  // A regression in the fs shim would throw here.
  const stickerBackend = await page.evaluate(async () => {
    const id = await window.exp.rpc.addAccount()
    const folder = await window.exp.rpc.miscGetStickerFolder(id)
    const packs = await window.exp.rpc.miscGetStickers(id)
    return { folder, packCount: Object.keys(packs).length }
  })
  if (!stickerBackend.folder || !stickerBackend.folder.endsWith('stickers')) {
    throw new Error(`sticker folder RPC returned unexpected path: ${stickerBackend.folder}`)
  }
  console.log(
    `OK: sticker picker backend works on wasm (folder=${stickerBackend.folder}, packs=${stickerBackend.packCount})`
  )

  if (cspViolations.length > 0) {
    console.error(`FAIL: ${cspViolations.length} CSP violation(s): ${cspViolations[0]}`)
    failed = true
  }

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
