// PWA update-path test: the common fail points of the content-hashed precache
// (sw-manifest.mjs + blobs-sw.ts). Serves a COPY of dist with GitHub-Pages-like
// headers (max-age=600, mtime validators), fakes a deploy onto it, and asserts:
//   1. the deploy propagates: changed bundle.css is served after the SW
//      update even though the HTTP cache still holds the old copy as "fresh"
//      (needs updateViaCache:'none' + install fetch cache:'no-cache')
//   2. unchanged files are NOT re-fetched: zero requests for the 10MB emoji
//      font after the first install (copy-forward from the old cache)
//   3. a file that vanished from the server does not brick the update
//      (allSettled install; the entry just stays absent)
//   4. old shell caches are deleted after activate (no storage leak)
//   5. offline after the update: font + new css served from cache alone,
//      the vanished file is a 404, not a crash
// Modeled on scripts/test-pwa-offline.mjs, but with no wasm-core boot: it
// only exercises the service worker, so it is fast and OPFS-race-free.
import { createServer } from 'node:http'
import { appendFile, cp, mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { extname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const here = fileURLToPath(new URL('.', import.meta.url))
const dist = join(here, '../packages/web-app/dist')
const swManifest = join(here, '../packages/web-app/sw-manifest.mjs')
const PORT = Number(process.env.APP_PORT ?? 8646)
const FONT = '/fonts/noto/emoji/NotoColorEmoji.ttf'

// fake deploy target: a throwaway copy of dist we can mutate between phases
const root = await mkdtemp(join(tmpdir(), 'pwa-update-'))
await cp(dist, root, { recursive: true })
const fontBytes = (await stat(join(root, FONT))).size

// micro static server, GitHub-Pages-flavored: max-age=600 freshness, mtime
// validators, 304s. Records every hit so the test can see what used the network.
const hits = []
const types = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json',
  '.wasm': 'application/wasm', '.ttf': 'font/ttf',
}
const sockets = new Set()
const server = createServer(async (req, res) => {
  try {
    const urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname)
    const path = normalize(join(root, urlPath === '/' ? '/main.html' : urlPath))
    const mtime = (await stat(path)).mtime.toUTCString()
    hits.push(urlPath)
    res.setHeader('cache-control', 'max-age=600') // what GitHub Pages sends
    res.setHeader('last-modified', mtime)
    if (req.headers['if-modified-since'] === mtime) {
      res.statusCode = 304
      return res.end()
    }
    res.setHeader('content-type', types[extname(path)] ?? 'application/octet-stream')
    res.end(await readFile(path))
  } catch {
    res.statusCode = 404
    res.end('not found')
  }
})
server.on('connection', s => sockets.add(s))
await new Promise(r => server.listen(PORT, r))

const browser = await chromium.launch()
const page = await browser.newPage()
// see smoke-web-app.mjs: freeze eval so avoid-eval.js can't break playwright
await page.addInitScript(() => {
  Object.defineProperty(window, 'eval', { value: window.eval, writable: false })
})

let failed = false
const assert = (cond, msg) => {
  if (!cond) throw new Error(msg)
  console.log('OK:', msg)
}
// NOT page.waitForFunction(async () => ...): with interval polling playwright
// does not await async predicates — the returned Promise is truthy and the
// wait "passes" instantly. Poll from Node instead.
const until = async (fn, msg, timeout = 60_000) => {
  const t0 = Date.now()
  while (!(await fn())) {
    if (Date.now() - t0 > timeout) throw new Error(`timeout waiting for: ${msg}`)
    await new Promise(r => setTimeout(r, 400))
  }
}

try {
  // ---- phase 1: first visit, SW installs + precaches ----
  await page.goto(`http://localhost:${PORT}/main.html`)
  await page.evaluate(() => navigator.serviceWorker.ready)
  await page.waitForFunction(() => navigator.serviceWorker.controller, null, {
    polling: 250,
    timeout: 30_000,
  })
  assert(
    await page.evaluate(
      f => caches.keys().then(async ks => {
        for (const k of ks) if (await (await caches.open(k)).match(f)) return true
        return false
      }),
      FONT
    ),
    'font precached on first install'
  )
  const phase1 = hits.length

  // ---- fake deploy: change two files, then break one of them ----
  await appendFile(join(root, 'bundle.css'), '\n/*deploy-v2*/')
  await appendFile(join(root, 'imprint.html'), '<!--v2-->')
  execFileSync('node', [swManifest, root]) // rebuild the hashed manifest
  // imprint.html is in the new manifest but 404s: the partial-install case
  await rm(join(root, 'imprint.html'))

  // ---- phase 2: update; a real client triggers this check on navigation ----
  await page.evaluate(() =>
    navigator.serviceWorker.getRegistration().then(r => r.update())
  )
  // bundle.css sits "fresh" (max-age=600) in the HTTP cache — v2 only ever
  // shows up if the update check and the install both bypass that freshness
  await until(
    () =>
      page.evaluate(async () =>
        (await (await fetch('./bundle.css')).text()).includes('deploy-v2')
      ),
    'deploy propagated'
  )
  console.log('OK: deploy propagated despite fresh HTTP-cache copy (no stale poisoning)')
  console.log('OK: update survived a manifest file missing from the server')

  const after = hits.slice(phase1)
  assert(
    !after.some(p => p.includes('NotoColorEmoji')),
    `unchanged font not re-requested on update (${after.length} update-phase requests)`
  )
  assert(after.some(p => p.endsWith('/bundle.css')), 'changed file was fetched on update')
  // activation deletes old shell caches (may lag activation: poll)
  await until(
    () =>
      page.evaluate(async () =>
        (await caches.keys()).filter(k => k.startsWith('slothful-shell-')).length === 1
      ),
    'old shell cache deleted'
  )
  console.log('OK: exactly one shell cache after activate (old deploy cleaned up)')
  // the tolerated failure must be visible, not silent
  const installErrors = await page.evaluate(async () =>
    (await (await caches.match('./__sw-install-errors__'))?.json()) ?? null
  )
  assert(
    installErrors?.length === 1 && installErrors[0].includes('imprint.html'),
    `partial-install failure recorded for inspection (${JSON.stringify(installErrors)})`
  )

  // ---- phase 3: offline (server gone entirely), served from cache alone ----
  server.close()
  sockets.forEach(s => s.destroy())
  const offline = await page.evaluate(async font => {
    const f = await fetch(font)
    return {
      fontStatus: f.status,
      fontBytes: (await f.arrayBuffer()).byteLength,
      cssV2: (await (await fetch('./bundle.css')).text()).includes('deploy-v2'),
      goneStatus: (await fetch('./imprint.html')).status,
    }
  }, FONT)
  assert(
    offline.fontStatus === 200 && offline.fontBytes === fontBytes,
    `font served offline, byte-complete (${offline.fontBytes} bytes)`
  )
  assert(offline.cssV2, 'updated bundle.css served offline')
  assert(offline.goneStatus === 404, 'vanished file is a clean 404 offline')
} catch (err) {
  console.error('FAIL:', err.message)
  failed = true
} finally {
  await browser.close()
  server.close()
  sockets.forEach(s => s.destroy())
  await rm(root, { recursive: true, force: true })
}
console.log(failed ? 'VERDICT: hashed precache update path: NO' : 'VERDICT: hashed precache update path: YES')
process.exit(failed ? 1 : 0)
