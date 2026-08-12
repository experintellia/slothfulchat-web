// PWA update-path test: the common fail points of the content-hashed precache
// (sw-manifest.mjs + blobs-sw.ts). Serves a COPY of dist with GitHub-Pages-like
// headers (max-age=600, mtime validators), fakes a deploy onto it, and asserts:
//   1. the deploy propagates: changed bundle.css is served after the SW
//      update even though the HTTP cache still holds the old copy as "fresh"
//      (needs updateViaCache:'none' + install fetch cache:'no-cache')
//   2. unchanged files are NOT re-fetched: zero requests for the 10MB emoji
//      font after the first install (copy-forward from the old cache)
//   3. a file that vanished from the server does NOT activate a partial
//      update: the install fails, the previous complete cache keeps serving,
//      repeats are counted (./__sw-update-failed__, what runtime.ts surfaces
//      as a device message), and the retry after the file returns succeeds
//      and clears the record
//   4. a partial FIRST install is still tolerated (no complete cache to
//      protect, and no worker at all means no blob serving)
//   5. an SW-code-only deploy (unchanged manifest => the SAME cache name as
//      the running worker) with a failing entry does NOT delete that cache
//   6. a failed file the old cache also lacks is tolerated (nothing to lose,
//      and failing would pin an adblocked client forever)
//   7. old shell caches are deleted after activate (no storage leak)
//   8. offline after the update: font + new css + every other manifest entry
//      served from cache alone
// Modeled on scripts/test-pwa-offline.mjs, but with no wasm-core boot: it
// only exercises the service worker, so it is fast and OPFS-race-free.
import { createServer } from 'node:http'
import { appendFile, cp, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
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
  const cachedSomewhere = f =>
    page.evaluate(
      f => caches.keys().then(async ks => {
        for (const k of ks) if (await (await caches.open(k)).match(f)) return true
        return false
      }),
      f
    )
  assert(await cachedSomewhere(FONT), 'font precached on first install')
  const phase1 = hits.length
  const shellCaches = () =>
    page.evaluate(async () => (await caches.keys()).filter(k => k.startsWith('slothful-shell-')))
  const [v1Cache] = await shellCaches()

  // ---- fake deploy: change two files, then break one of them ----
  await appendFile(join(root, 'bundle.css'), '\n/*deploy-v2*/')
  await appendFile(join(root, 'imprint.html'), '<!--v2-->')
  execFileSync('node', [swManifest, root]) // rebuild the hashed manifest
  const imprint = await readFile(join(root, 'imprint.html'))
  // imprint.html is in the new manifest but 404s: the partial-install case
  await rm(join(root, 'imprint.html'))

  // ---- phase 2: update; a real client triggers this check on navigation ----
  // NB: reg.update() resolves as soon as the new worker starts installing (the
  // spec resolves the job promise before the install event runs), so it says
  // nothing about the outcome — watch the worker's state instead: a failed
  // install goes straight to 'redundant', a good one reaches 'activated'.
  const update = () =>
    page.evaluate(
      () =>
        new Promise(resolve =>
          navigator.serviceWorker.getRegistration().then(r => {
            const watch = w => {
              const check = () =>
                (w.state === 'redundant' || w.state === 'activated') && resolve(w.state)
              w.addEventListener('statechange', check)
              check()
            }
            // a browser-initiated soft update may already be installing — its
            // updatefound fired before we listened, so check first, or this
            // promise never settles (hang, not a failure)
            if (r.installing) watch(r.installing)
            else r.addEventListener('updatefound', () => watch(r.installing))
            r.update()
          })
        )
    )
  assert((await update()) === 'redundant', 'incomplete update fails to install')
  assert(
    JSON.stringify(await shellCaches()) === JSON.stringify([v1Cache]),
    'previous complete cache kept, half-filled new cache dropped'
  )
  assert(
    !(await page.evaluate(async () =>
      (await (await fetch('./bundle.css')).text()).includes('deploy-v2')
    )),
    'old version still served: no partial deploy went live'
  )
  // a second failed attempt of the same version is counted, so the page can
  // tell "stuck" from "blip" and surface it (runtime.ts surfaceFailedUpdate)
  assert((await update()) === 'redundant', 'second attempt fails the same way')
  const rec = await page.evaluate(async () => {
    const r = await caches.match('./__sw-update-failed__')
    return r ? await r.json() : null
  })
  assert(
    rec?.attempts === 2 && rec.errors[0].includes('imprint.html'),
    `repeated failures counted for the page to surface (${JSON.stringify(rec)})`
  )

  // ---- phase 2b: the same deploy, once the missing file is back ----
  await writeFile(join(root, 'imprint.html'), imprint)
  // bundle.css sits "fresh" (max-age=600) in the HTTP cache — v2 only ever
  // shows up if the update check and the install both bypass that freshness
  assert((await update()) === 'activated', 'retry after the file returns installs')
  await until(
    () =>
      page.evaluate(async () =>
        (await (await fetch('./bundle.css')).text()).includes('deploy-v2')
      ),
    'deploy propagated'
  )
  console.log('OK: deploy propagated despite fresh HTTP-cache copy (no stale poisoning)')

  const after = hits.slice(phase1)
  assert(
    !after.some(p => p.includes('NotoColorEmoji')),
    `unchanged font not re-requested on update (${after.length} update-phase requests)`
  )
  assert(after.some(p => p.endsWith('/bundle.css')), 'changed file was fetched on update')
  // activation deletes old shell caches (may lag activation: poll)
  await until(async () => (await shellCaches()).length === 1, 'old shell cache deleted')
  console.log('OK: exactly one shell cache after activate (old deploy cleaned up)')
  assert(
    !(await page.evaluate(async () => !!(await caches.match('./__sw-update-failed__')))),
    'failure record died with the old cache (no stale nag after a good update)'
  )

  // ---- phase 2c: a FIRST install is allowed to be partial (fresh profile) ----
  await rm(join(root, 'imprint.html')) // break the same file again
  const fresh = await browser.newContext()
  await fresh.addInitScript(() => {
    Object.defineProperty(window, 'eval', { value: window.eval, writable: false })
  })
  const freshPage = await fresh.newPage()
  await freshPage.goto(`http://localhost:${PORT}/main.html`)
  await freshPage.waitForFunction(() => navigator.serviceWorker.controller, null, {
    polling: 250,
    timeout: 60_000,
  })
  // ... and the tolerated failure must be visible, not silent
  const installErrors = await freshPage.evaluate(async () =>
    (await (await caches.match('./__sw-install-errors__'))?.json()) ?? null
  )
  assert(
    installErrors?.length === 1 && installErrors[0].includes('imprint.html'),
    `partial first install still activates, failure recorded (${JSON.stringify(installErrors)})`
  )
  await fresh.close()

  // ---- phase 2d: an SW-code-only deploy REUSES the live cache's name ----
  // blobs-sw.js/sw-precache.js are outside the manifest (precacheSkip), so a
  // worker-only change ships a new worker under an unchanged
  // __PRECACHE_VERSION: CACHE *is* the cache the active worker serves from.
  // Add a stale manifest-bearing cache (what an interrupted activate leaves
  // behind) so oldCache is truthy, break an entry, and the "delete CACHE"
  // branch would wipe the live offline copy — the very thing this guards.
  await page.evaluate(() =>
    caches.open('slothful-shell-stale').then(c => c.put('./__sw-manifest__', new Response('{}')))
  )
  await appendFile(join(root, 'blobs-sw.js'), '\n//sw-only-v3\n') // manifest NOT rebuilt
  const beforeSwOnly = hits.length
  assert(
    (await update()) === 'activated',
    'sw-only redeploy with a failing entry activates instead of deleting its own cache'
  )
  assert(
    await cachedSomewhere(FONT),
    'live offline copy survived the sw-only redeploy (font still cached)'
  )
  // CACHE already holds this manifest, so install reuses it in place. It must
  // not re-download the shell over the top of the cache the active worker is
  // serving from: those entries are put before they are verified, so one
  // mismatch would delete a live file with no failed-install branch to catch
  // it (CACHE carries MANIFEST_KEY, so the guard below deliberately activates).
  const swOnly = hits.slice(beforeSwOnly)
  assert(
    !swOnly.some(p => p.includes('NotoColorEmoji') || p.endsWith('/bundle.css')),
    `sw-only redeploy reused the live cache instead of refetching it (${swOnly.join(', ')})`
  )

  // ---- phase 2e: a failed file the old cache ALSO lacks is tolerated ----
  // A brand-new file that 404s: failing the install on it would protect
  // nothing (the old cache never had it) but would pin e.g. a client whose
  // adblocker rejects that one URL to its current version forever.
  await writeFile(join(root, 'imprint.html'), imprint) // undo 2c's breakage
  await writeFile(join(root, 'brand-new.txt'), 'v3')
  execFileSync('node', [swManifest, root])
  await rm(join(root, 'brand-new.txt'))
  assert((await update()) === 'activated', 'update missing only a NEW file still activates')
  await until(async () => (await shellCaches()).length === 1, 'new-file deploy became sole cache')
  assert(await cachedSomewhere(FONT), 'font copied forward past the tolerated failure')

  // ---- phase 2f: a TORN deploy — right status, wrong bytes — is refused ----
  // The half a 404 cannot express: the file is there and answers 200, it is
  // just the previous deploy's copy, because the deploy is mid-write (or a CDN
  // edge is behind). Install used to take any 200, and a content-versioned
  // cache is never revalidated, so that mixture would be served until the next
  // deploy. Simulated by recording new bytes in the manifest and then serving
  // the old ones.
  const cssV2 = await readFile(join(root, 'bundle.css'))
  await appendFile(join(root, 'bundle.css'), '\n/*deploy-v4*/')
  execFileSync('node', [swManifest, root]) // manifest now describes the v4 bytes
  await writeFile(join(root, 'bundle.css'), cssV2) // ...but v2 is what is served
  assert((await update()) === 'redundant', 'bytes not matching the manifest fail the install')
  const torn = await page.evaluate(async () => {
    const r = await caches.match('./__sw-update-failed__')
    return r ? await r.json() : null
  })
  assert(
    torn?.errors?.some(e => e.includes('bundle.css') && e.includes('manifest says')),
    `the mismatching file is named, not just counted (${JSON.stringify(torn)})`
  )
  assert(await cachedSomewhere(FONT), 'the complete previous cache survived the torn deploy')

  // ---- phase 3: offline (server gone entirely), served from cache alone ----
  server.close()
  sockets.forEach(s => s.destroy())
  const offline = await page.evaluate(async font => {
    const f = await fetch(font)
    return {
      fontStatus: f.status,
      fontBytes: (await f.arrayBuffer()).byteLength,
      cssV2: (await (await fetch('./bundle.css')).text()).includes('deploy-v2'),
      imprintV2: (await (await fetch('./imprint.html')).text()).includes('<!--v2-->'),
    }
  }, FONT)
  assert(
    offline.fontStatus === 200 && offline.fontBytes === fontBytes,
    `font served offline, byte-complete (${offline.fontBytes} bytes)`
  )
  assert(offline.cssV2, 'updated bundle.css served offline')
  assert(offline.imprintV2, 'the file that once 404d is offline too (cache is complete)')
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
