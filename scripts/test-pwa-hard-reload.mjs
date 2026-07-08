// Verify: hard reload (SW bypass) → page auto-reloads once → blobs served by SW.
// Modeled on scripts/test-pwa-update.mjs (no wasm-core assertions needed).
import { createServer } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { extname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const here = fileURLToPath(new URL('.', import.meta.url))
const dist = '/home/dev/work/slothfulchat-web/packages/web-app/dist'
const PORT = 8649

const types = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json',
  '.wasm': 'application/wasm', '.ttf': 'font/ttf',
}
const server = createServer(async (req, res) => {
  try {
    const urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname)
    const path = normalize(join(dist, urlPath === '/' ? '/main.html' : urlPath))
    await stat(path)
    res.setHeader('content-type', types[extname(path)] ?? 'application/octet-stream')
    res.end(await readFile(path))
  } catch {
    res.statusCode = 404
    res.end('not found') // distinct from the SW's 'blob not found'
  }
})
await new Promise(r => server.listen(PORT, r))

const browser = await chromium.launch()
const page = await browser.newPage()
await page.addInitScript(() => {
  Object.defineProperty(window, 'eval', { value: window.eval, writable: false })
})
let navs = 0
page.on('framenavigated', f => { if (f === page.mainFrame()) navs++ })

let failed = false
const assert = (cond, msg) => {
  if (!cond) throw new Error(msg)
  console.log('OK:', msg)
}
const until = async (fn, msg, timeout = 30_000) => {
  const t0 = Date.now()
  for (;;) {
    try { if (await fn()) return } catch {} // context destroyed mid-reload is fine
    if (Date.now() - t0 > timeout) throw new Error(`timeout waiting for: ${msg}`)
    await new Promise(r => setTimeout(r, 300))
  }
}
const controlled = () => page.evaluate(() => !!navigator.serviceWorker.controller)

try {
  // phase 1: first visit — SW installs, claims, page becomes controlled
  await page.goto(`http://localhost:${PORT}/main.html`)
  await until(controlled, 'controlled after first visit')
  console.log('OK: controlled after first visit, navs =', navs)
  const navsBefore = navs

  // phase 2: hard reload via CDP — bypasses the SW for the new page
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Page.reload', { ignoreCache: true })

  // the fix: page detects it's uncontrolled + SW active → reloads itself once
  await until(
    async () => navs >= navsBefore + 2 && (await controlled()),
    'auto-reload back under SW control'
  )
  assert(true, `auto-reloaded and controlled again (navs ${navsBefore} -> ${navs})`)

  // blob URLs actually hit the SW now: its 404 body differs from the server's
  const body = await page.evaluate(() =>
    fetch('/blobs/1/does-not-exist.png').then(r => r.text())
  )
  assert(body === 'blob not found', `blob URL intercepted by SW (body: ${JSON.stringify(body)})`)

  // phase 3: no reload loop — navigation count stays put
  const settled = navs
  await new Promise(r => setTimeout(r, 3000))
  assert(navs === settled, `no reload loop (navs stable at ${navs})`)

  // flag was cleaned up on the controlled load
  const flag = await page.evaluate(() => sessionStorage.getItem('sw-force-reloaded'))
  assert(flag === null, 'sessionStorage flag cleared after controlled load')

  // sanity: a plain normal reload does not trigger the reload path
  await page.reload()
  await until(controlled, 'controlled after normal reload')
  const after = navs
  await new Promise(r => setTimeout(r, 2000))
  assert(navs === after, 'normal reload does not self-reload')
} catch (err) {
  console.error('FAIL:', err.message)
  failed = true
} finally {
  await browser.close()
  server.close()
  server.closeAllConnections?.()
}
console.log(failed ? 'VERDICT: NO' : 'VERDICT: hard-reload blob fix works: YES')
process.exit(failed ? 1 : 0)
