// Smoke test for boot-error.js (the pre-bundle boot-failure screen): serve
// dist, break the built bundles, assert the fallback screen renders with the
// error details instead of a blank page. Restores dist afterwards.
// Needs an assembled+built dist (pnpm assemble && pnpm build in web-app).
import { spawn } from 'node:child_process'
import { copyFile, readFile, rename, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const path = p => fileURLToPath(new URL(p, import.meta.url))
const dist = path('../packages/web-app/dist')
const APP_PORT = Number(process.env.APP_PORT ?? 8652)

const server = spawn('node', [path('../packages/web-app/serve.mjs')], {
  env: { ...process.env, PORT: String(APP_PORT) },
  stdio: 'inherit',
})
process.on('exit', () => server.kill())
await new Promise(r => setTimeout(r, 500)) // let the server bind

const browser = await chromium.launch()
let failed = false

async function expectFallback(label, needle) {
  const page = await browser.newPage()
  // avoid-eval.js replaces window.eval, breaking waitForFunction (see smoke-web-app.mjs)
  await page.addInitScript(() => {
    Object.defineProperty(window, 'eval', { value: window.eval, writable: false })
  })
  await page.goto(`http://localhost:${APP_PORT}/main.html`)
  try {
    await page.waitForFunction(
      () => (document.getElementById('root')?.innerText || '').includes('could not start'),
      null, { timeout: 10_000 }
    )
    const text = await page.evaluate(() => document.getElementById('root').innerText)
    if (!text.includes(needle)) {
      console.error(`FAIL ${label}: fallback shown but missing "${needle}":\n${text}`)
      failed = true
    } else {
      console.log(`OK ${label}: fallback screen shown with "${needle}"`)
    }
  } catch {
    console.error(`FAIL ${label}: fallback screen never appeared`)
    failed = true
  }
  await page.close()
}

// scenario 1: parse error in bundle.js (the "too-old browser" failure mode)
await copyFile(`${dist}/bundle.js`, `${dist}/bundle.js.bak`)
const bundle = await readFile(`${dist}/bundle.js`, 'utf8')
await writeFile(`${dist}/bundle.js`, '];\n' + bundle)
await expectFallback('parse-error', 'SyntaxError')
await rename(`${dist}/bundle.js.bak`, `${dist}/bundle.js`)

// scenario 2: runtime.js missing (script load failure)
await rename(`${dist}/runtime.js`, `${dist}/runtime.js.bak`)
await expectFallback('load-failure', 'failed to load')
await rename(`${dist}/runtime.js.bak`, `${dist}/runtime.js`)

await browser.close()
server.kill()
console.log(failed ? 'VERDICT: boot-error fallback works: NO' : 'VERDICT: boot-error fallback works: YES')
process.exit(failed ? 1 : 0)
