// HTML email viewer security check (runtime.openMessageHTML): the check that
// fails if any of the viewer's three isolation layers breaks. Self-sufficient:
// esbuilds src/html-email.ts + copies static/html-email.html into a temp dir
// and serves only those two files — no wasm core, no frontend build, offline.
// Drives window.__initHtmlEmail with hostile mail content and asserts:
//   - no script executes (inline, onerror handler, javascript: URL)
//   - attacker <meta> CSP / <base> / <link rel=stylesheet> are stripped
//   - the content document cannot reach its parent (opaque origin sandbox)
//   - remote images are NOT fetched until the user opts in, then they are
//   - never/once/always control: "always" persists via callback, contact
//     requests don't offer "always"
//   - app links AND http(s) links are routed through the app via the relay
//     page, tagged with the originating account (#3); http(s) goes to the
//     safe-link path (#4). Fragment/relative/tel handled distinctly.
// Modeled on scripts/test-bridge-dialog.mjs.
import { execFileSync, spawn } from 'node:child_process'
import { mkdtempSync, copyFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { startServers } from './harness.mjs'

const script = p => fileURLToPath(new URL(p, import.meta.url))
const webApp = script('../packages/web-app')
const APP_PORT = Number(process.env.APP_PORT ?? 8663)
const ACCT = 7 // originating account id; relayed links must carry it (#3)

// build the two files under test into a temp dir
const dir = mkdtempSync(join(tmpdir(), 'html-email-test-'))
execFileSync(
  join(webApp, 'node_modules/.bin/esbuild'),
  ['--format=esm', '--bundle', join(webApp, 'src/html-email.ts'), `--outfile=${join(dir, 'html-email.js')}`],
  { stdio: 'inherit' }
)
copyFileSync(join(webApp, 'static/html-email.html'), join(dir, 'html-email.html'))
// the page loads it; serve the real one rather than 404ing (it no-ops unframed)
copyFileSync(join(webApp, 'static/frame-guard.js'), join(dir, 'frame-guard.js'))

const { cleanup } = await startServers({ app: APP_PORT, appRoot: dir })

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
    <a id="frag" href="#section">jump</a>
    <a id="relx" href="some/relative.html">relative</a>
    <a id="applink" href="OPENPGP4FPR:1234ABCD#a=1">verify contact</a>
    <a id="mailtolink" href="mailto:friend@example.com?subject=Hi">mail</a>
    <a id="invitelink" href="https://i.delta.chat/#82AB12">invite</a>
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
  ([content, isContactRequest, accountId]) => {
    window.__closed = false
    window.__always = null
    window.__initHtmlEmail({
      subject: 'Test subject',
      from: 'Sender <sender@example.com>',
      sentTime: 'Friday, July 31, 2026 12:00 PM',
      content,
      accountId,
      isContactRequest,
      alwaysLoadRemote: false,
      labels: { loadRemoteImages: 'Load Remote Images', ask: 'ask', never: 'Never', once: 'Once', always: 'Always', close: 'Close' },
      onClose: () => (window.__closed = true),
      onSetAlwaysLoad: v => (window.__always = v),
    })
  },
  [HOSTILE, false, ACCT]
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
// #4: http(s) links are routed through the app's safe-link path (relay page,
// same as app links) so they get tracking-param stripping — no longer a direct
// sandbox escape. Full click->deliver behavior is asserted below + in the e2e.
check(
  await frame.$eval(
    '#weblink',
    (e, port) =>
      e.getAttribute('href') ===
        `http://localhost:${port}/html-email.html#open=${encodeURIComponent('https://example.com/page')}&acct=7` &&
      e.target === '_blank' &&
      e.getAttribute('rel') === 'opener',
    APP_PORT
  ),
  'http(s) link routed through the app relay (safe-link path), not a direct escape'
)
check(
  await frame.$eval('#svglink', e => e.getAttribute('target') === '_blank'),
  'SVG links rewritten too (would otherwise navigate the frame itself)'
)
check(
  await frame.$eval('#frag', e => e.getAttribute('href') === '#section' && e.target !== '_blank'),
  'fragment link kept for in-document jump, not sent to a new tab'
)
check(
  await frame.$eval('#relx', e => e.getAttribute('href') === null),
  'relative href dropped (would be a dead blob:-relative navigation)'
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

// -- app links (mailto / openpgp4fpr / i.delta.chat invites): rewritten to the
// same-origin relay page carrying the originating account (#3), keeping
// window.opener so the relay can find the app
frame = await contentFrame()
for (const [id, orig] of [
  ['applink', 'OPENPGP4FPR:1234ABCD#a=1'],
  ['mailtolink', 'mailto:friend@example.com?subject=Hi'],
  ['invitelink', 'https://i.delta.chat/#82AB12'],
]) {
  const [href, target, rel] = await frame.$eval(`#${id}`, e => [
    e.getAttribute('href'),
    e.getAttribute('target'),
    e.getAttribute('rel'),
  ])
  check(
    href === `http://localhost:${APP_PORT}/html-email.html#open=${encodeURIComponent(orig)}&acct=${ACCT}` &&
      target === '_blank' &&
      rel === 'opener',
    `app link #${id} rewritten to the relay page with &acct (absolute URL, rel=opener)`
  )
}
// click → relay tab escapes the sandbox, forwards (url, accountId) up the
// opener chain (here: the wrapper page is the top-level host), closes itself
await page.evaluate(() => {
  window.__appLink = null
  window.__appLinkAcct = null
  window.__slothfulOpenAppLink = (u, acct) => {
    window.__appLink = u
    window.__appLinkAcct = acct
  }
})
const [relayPage] = await Promise.all([context.waitForEvent('page'), frame.click('#applink')])
await page.waitForFunction(() => window.__appLink !== null)
check(
  (await page.evaluate(() => window.__appLink)) === 'OPENPGP4FPR:1234ABCD#a=1',
  'clicking an app link relays the original URL to the host app'
)
check(
  (await page.evaluate(() => window.__appLinkAcct)) === ACCT,
  'relayed app link carries the originating account id (#3)'
)
if (!relayPage.isClosed()) await relayPage.waitForEvent('close', { timeout: 5000 }).catch(() => {})
check(relayPage.isClosed(), 'relay tab closes itself')

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
check(
  await page.$$eval('#menu button', els => els.map(b => b.dataset.state).join(',')) === 'never,once',
  'contact request ⋮ menu offers only never/once'
)

// -- desktop layout (default wide viewport): exposed control + close, no back/menu
const vis = sel => page.$eval(sel, e => getComputedStyle(e).display !== 'none')
check((await vis('#close')) && (await vis('#remote')), 'desktop: close button + remote control exposed')
check(!(await vis('#back')) && !(await vis('#menu-btn')), 'desktop: no back button / ⋮ menu button')

// -- mobile layout (≤500px): back button left, remote control inside ⋮ menu
const mpage = await context.newPage()
await mpage.setViewportSize({ width: 400, height: 800 })
const mrequests = new Map()
mpage.on('request', r => mrequests.set(r.url(), 'pending'))
mpage.on('requestfailed', r => mrequests.set(r.url(), r.failure()?.errorText ?? 'failed'))
await mpage.goto(`http://localhost:${APP_PORT}/html-email.html`)
await mpage.evaluate(
  ([content]) => {
    window.__closed = false
    window.__alwaysCalls = []
    const p = {
      subject: 's', from: 'f', sentTime: 't', content,
      isContactRequest: false,
      alwaysLoadRemote: false,
      labels: { loadRemoteImages: 'Load Remote Images', ask: 'ask', never: 'Never', once: 'Once', always: 'Always', close: 'Close' },
      onClose: () => (window.__closed = true),
      onSetAlwaysLoad: v => window.__alwaysCalls.push(v),
    }
    window.__initHtmlEmail(p)
    window.__initHtmlEmail(p) // the wrapper is reused across opens — must not duplicate controls/handlers
  },
  [HOSTILE]
)
const mvis = sel => mpage.$eval(sel, e => getComputedStyle(e).display !== 'none')
check((await mvis('#back')) && (await mvis('#menu-btn')), 'mobile: back button + ⋮ menu button shown')
check(!(await mvis('#close')) && !(await mvis('#remote')), 'mobile: close button + exposed control hidden')
check(
  (await mpage.$$eval('#remote-select option', els => els.length)) === 3 &&
    (await mpage.$$eval('#menu button', els => els.length)) === 3,
  'double init does not duplicate controls'
)
await mpage.click('#menu-btn')
check(await mvis('#menu'), '⋮ menu opens')
await mpage.click('#menu button[data-state="once"]')
check(!(await mvis('#menu')), '⋮ menu closes after choosing')
await mpage.waitForTimeout(500)
check(
  [...mrequests].some(([u, o]) => u.startsWith('https://remote-tracker.invalid') && o !== 'csp'),
  'menu "Once" loads remote images'
)
check(
  await mpage.evaluate(() => JSON.stringify(window.__alwaysCalls)) === '[false]',
  'change handler fired exactly once despite double init'
)
await mpage.click('#back')
check(await mpage.evaluate(() => window.__closed === true), 'mobile back button calls onClose')

await browser.close()
if (failures) {
  console.error(`${failures} check(s) FAILED`)
  process.exit(1)
}
console.log('html-email viewer security checks passed')
process.exit(0) // the spawned server would keep the event loop alive
