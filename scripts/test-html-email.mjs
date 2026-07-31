// HTML email viewer security check (runtime.openMessageHTML): the check that
// fails if any of the viewer's three isolation layers breaks. Self-sufficient:
// esbuilds src/html-email.ts + copies static/html-email.html into a temp dir
// and serves only those two files — no wasm core, no frontend build, offline.
// Drives window.__initHtmlEmail with hostile mail content and asserts:
//   - no script executes (inline, onerror handler, javascript: URL)
//   - attacker <meta> CSP / <base> / <link rel=stylesheet> are stripped
//   - links are rewritten to target=_blank rel=noopener noreferrer
//   - the content document cannot reach its parent (opaque origin sandbox)
//   - remote images are NOT fetched until the user opts in, then they are
//   - never/once/always control: "always" persists via callback, contact
//     requests don't offer "always"
// Modeled on scripts/test-bridge-dialog.mjs.
import { execFileSync, spawn } from 'node:child_process'
import { mkdtempSync, copyFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const script = p => fileURLToPath(new URL(p, import.meta.url))
const webApp = script('../packages/web-app')
const APP_PORT = Number(process.env.APP_PORT ?? 8663)

// build the two files under test into a temp dir
const dir = mkdtempSync(join(tmpdir(), 'html-email-test-'))
execFileSync(
  join(webApp, 'node_modules/.bin/esbuild'),
  ['--format=esm', '--bundle', join(webApp, 'src/html-email.ts'), `--outfile=${join(dir, 'html-email.js')}`],
  { stdio: 'inherit' }
)
copyFileSync(join(webApp, 'static/html-email.html'), join(dir, 'html-email.html'))

const server = spawn('node', [script('../packages/web-app/serve.mjs')], {
  env: { ...process.env, PORT: String(APP_PORT), SERVE_ROOT: dir },
  stdio: 'inherit',
})
const cleanup = () => server.kill()
process.on('exit', cleanup)
await new Promise(r => setTimeout(r, 500)) // let the server bind

const REMOTE_IMG = 'https://remote-tracker.invalid/pixel.png'
const HOSTILE = `
  <html><head>
    <meta http-equiv="Content-Security-Policy" content="img-src https: 'unsafe-inline'">
    <base href="https://evil.invalid/">
    <link rel="stylesheet" href="https://evil.invalid/style.css">
    <style>p { color: rgb(1, 2, 3); }</style>
  </head><body>
    <script>window.__pwned = 'script'<\/script>
    <img src="broken" onerror="window.__pwned = 'onerror'">
    <a id="jslink" href="javascript:window.__pwned = 'jsurl'">js link</a>
    <a id="weblink" href="https://example.com/page">web link</a>
    <svg width="20" height="20"><a id="svglink" href="https://example.com/svg"><circle r="9" cx="10" cy="10"/></a></svg>
    <img id="remote" src="${REMOTE_IMG}">
    <img id="inline" src="data:image/gif;base64,R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==">
    <form action="https://evil.invalid/submit"><input name="x"></form>
    <p id="text">hello</p>
  </body></html>`

let failures = 0
const check = (ok, name) => {
  console.log(`${ok ? 'ok' : 'FAIL'} - ${name}`)
  if (!ok) failures++
}

// CHROMIUM_PATH: run against a system chromium when the playwright-pinned
// browser build isn't downloaded (unset in CI, which installs the pinned one)
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined })
const context = await browser.newContext()
const page = await context.newPage()
page.on('dialog', d => {
  check(false, `unexpected dialog: ${d.message()}`)
  d.dismiss()
})
// Playwright reports even CSP-blocked requests via 'request' — they never
// reach the network and fail with errorText 'csp' (verified: a real attempt
// fails with a net:: error instead). Track outcomes, not just attempts.
const requests = new Map() // url -> 'csp' | net error | 'finished' | 'pending'
page.on('request', r => requests.set(r.url(), 'pending'))
page.on('requestfailed', r => requests.set(r.url(), r.failure()?.errorText ?? 'failed'))
page.on('requestfinished', r => requests.set(r.url(), 'finished'))
const remoteOutcome = () =>
  [...requests].filter(([u]) => u.startsWith('https://remote-tracker.invalid')).map(([, o]) => o)

await page.goto(`http://localhost:${APP_PORT}/html-email.html`)
await page.evaluate(
  ([content, isContactRequest]) => {
    window.__closed = false
    window.__always = null
    window.__initHtmlEmail({
      subject: 'Test subject',
      from: 'Sender <sender@example.com>',
      sentTime: 'Friday, July 31, 2026 12:00 PM',
      content,
      isContactRequest,
      alwaysLoadRemote: false,
      labels: { loadRemoteImages: 'Load Remote Images', ask: 'ask', never: 'Never', once: 'Once', always: 'Always', close: 'Close' },
      onClose: () => (window.__closed = true),
      onSetAlwaysLoad: v => (window.__always = v),
    })
  },
  [HOSTILE, false]
)

const contentFrame = async () => {
  // the blob: iframe inside #frame-host; wait for it to attach + load
  await page.waitForSelector('#frame-host iframe')
  const handle = await page.$('#frame-host iframe')
  const frame = await handle.contentFrame()
  await frame.waitForLoadState()
  return frame
}
let frame = await contentFrame()

// -- sanitizer (layer 3)
check((await frame.$$('script')).length === 0, 'script tags stripped')
check((await frame.$$('base')).length === 0, 'base tag stripped')
check((await frame.$$('link')).length === 0, 'stylesheet link stripped')
check((await frame.$$('form, input')).length === 0, 'form controls stripped')
const metas = await frame.$$eval('meta[http-equiv]', els => els.map(e => e.getAttribute('content')))
check(!metas.some(c => c.includes('unsafe-inline') && c.includes('https:')), 'attacker meta CSP stripped')
check(metas.some(c => c.startsWith("default-src 'none'")), 'our meta CSP present')
check(await frame.$eval('#text', e => e.textContent) === 'hello', 'benign content kept')
check(await frame.$eval('p', e => getComputedStyle(e).color) === 'rgb(1, 2, 3)', 'benign <style> kept')
const jslink = await frame.$eval('#jslink', e => e.getAttribute('href') ?? '')
check(!jslink.startsWith('javascript:'), 'javascript: href stripped')
check(
  await frame.$eval('#weblink', e => e.target === '_blank' && e.rel.includes('noopener') && e.rel.includes('noreferrer')),
  'links rewritten to target=_blank noopener noreferrer'
)
check(
  await frame.$eval('#svglink', e => e.getAttribute('target') === '_blank'),
  'SVG links rewritten too (would otherwise navigate the frame itself)'
)

// -- no execution (layers 1+2): give onerror a moment, then look for markers
await page.waitForTimeout(300)
check(await page.evaluate(() => window.__pwned === undefined), 'no script executed in wrapper/top')
check(
  await frame.evaluate(() => {
    try {
      return window.parent.document == null ? 'reachable-null' : 'reachable'
    } catch {
      return 'blocked'
    }
  }) === 'blocked',
  'content frame cannot reach parent (opaque origin)'
)

// -- remote content blocked by default (authored CSP, layer 2)
check(
  remoteOutcome().every(o => o === 'csp'),
  `remote image CSP-blocked, never reaches the network, while blocked (saw: ${remoteOutcome().join(',') || 'no request'})`
)
check(await frame.$eval('#inline', e => e.complete && e.naturalWidth > 0), 'data: inline image renders')

// -- opt in: "Once" → remote request is attempted
await page.selectOption('#remote-select', 'once')
frame = await contentFrame()
await page.waitForTimeout(500)
check(
  remoteOutcome().some(o => o !== 'csp'),
  `remote image attempted on the network after opting in (saw: ${remoteOutcome().join(',')})`
)
check(await page.evaluate(() => window.__always === false), '"Once" reported always=false')

// -- "Always" persists via callback
await page.selectOption('#remote-select', 'always')
check(await page.evaluate(() => window.__always === true), '"Always" persisted via onSetAlwaysLoad')

// -- close button
await page.click('#close')
check(await page.evaluate(() => window.__closed === true), 'close button calls onClose')

// -- contact request: no "always" option, starts blocked even with always-load set
await page.goto(`http://localhost:${APP_PORT}/html-email.html`)
await page.evaluate(
  ([content]) => {
    window.__initHtmlEmail({
      subject: 's', from: 'f', sentTime: 't', content,
      isContactRequest: true,
      alwaysLoadRemote: true,
      labels: { loadRemoteImages: 'Load Remote Images', ask: 'ask', never: 'Never', once: 'Once', always: 'Always', close: 'Close' },
      onClose: () => {}, onSetAlwaysLoad: () => {},
    })
  },
  [HOSTILE]
)
const options = await page.$$eval('#remote-select option', els => els.map(o => o.value))
check(options.join(',') === 'never,once', 'contact request offers only never/once')
check(await page.$eval('#remote-select', e => e.value) === 'never', 'contact request starts blocked')

await browser.close()
if (failures) {
  console.error(`${failures} check(s) FAILED`)
  process.exit(1)
}
console.log('html-email viewer security checks passed')
process.exit(0) // the spawned server would keep the event loop alive
