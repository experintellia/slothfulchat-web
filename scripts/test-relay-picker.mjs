// E2E test for the instant-onboarding relay picker (patches/desktop
// 0042/0043): the "create profile" screen offers a dropdown of chatmail
// relays — default relay first, then the relays from the live directory that
// the WS→TCP bridge's /dns endpoint can resolve — and the privacy-policy
// consent link follows the selection.
//
// The directory fetch (the chatmail-relays-mirror relays.json on
// raw.githubusercontent.com) is intercepted with a Playwright route and
// answered with a fixture, so the test runs offline and doesn't depend on
// the real mirror's contents:
//  - nine.testrun.org — the default relay, must stay first
//  - example.org — resolvable, must be offered
//  - relay.does-not-exist.invalid — guaranteed NXDOMAIN, must be filtered out
//  - a junk entry (host is a URL, not a bare hostname) — must be skipped
//
// Modeled on scripts/smoke-web-app.mjs (servers, eval fix).
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const script = p => fileURLToPath(new URL(p, import.meta.url))
const PROXY_PORT = Number(process.env.PROXY_PORT ?? 8641)
const APP_PORT = Number(process.env.APP_PORT ?? 8642)

const RELAYS_JSON = JSON.stringify({
  source: 'https://chatmail.at/relays',
  fetchedAt: '2026-07-12T00:00:00Z',
  relays: [
    { host: 'nine.testrun.org' },
    { host: 'example.org' },
    { host: 'relay.does-not-exist.invalid' },
    { host: 'https://chatmail.at/doc/relay' },
  ],
})

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
const watchdog = setTimeout(() => {
  console.error('FAIL: global watchdog (4 min) — test hung')
  cleanup()
  process.exit(1)
}, 240_000)
await new Promise(r => setTimeout(r, 500)) // let servers bind

// CHROMIUM_EXECUTABLE: use a system/preinstalled Chromium instead of the
// playwright-managed download (e.g. sandboxes where the download is blocked)
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_EXECUTABLE || undefined,
})
const page = await browser.newPage()
page.on('pageerror', e => console.error('[pageerror]', e.message))
// upstream's avoid-eval.js breaks page.evaluate; freeze the real eval
await page.addInitScript(() => {
  Object.defineProperty(window, 'eval', { value: window.eval, writable: false })
})

// serve the directory fixture instead of the real (network) URL
let directoryRequested = false
await page.route('https://raw.githubusercontent.com/**', route => {
  directoryRequested = true
  route.fulfill({
    status: 200,
    contentType: 'text/plain; charset=utf-8', // GitHub raw serves JSON as text/plain
    body: RELAYS_JSON,
  })
})

const fail = msg => {
  console.error(`FAIL: ${msg}`)
  cleanup()
  process.exit(1)
}

await page.goto(`http://localhost:${APP_PORT}/main.html`)

// welcome screen → "Create New Profile" → instant onboarding screen
await page.getByTestId('create-account-button').click({ timeout: 60_000 })

// the picker appears once the (mocked) directory is fetched and the
// unreachable relay was probed away over the bridge
const picker = page.locator('#relay-picker')
await picker.waitFor({ state: 'visible', timeout: 30_000 })
if (!directoryRequested) fail('picker visible but directory was never fetched')

const options = await picker.locator('option').allTextContents()
console.log('picker options:', options)
if (options[0] !== 'nine.testrun.org')
  fail(`default relay not first: ${options}`)
if (!options.includes('example.org'))
  fail(`resolvable directory relay missing: ${options}`)
if (options.some(o => o.includes('invalid')))
  fail(`NXDOMAIN relay not filtered out: ${options}`)
if (options.some(o => o.includes('chatmail.at')))
  fail(`junk (URL-valued host) entry not skipped: ${options}`)

// consent link follows the selection
const consent = page.locator('a', { hasText: 'Privacy Policy' })
if (!/nine\.testrun\.org/.test(await consent.getAttribute('href')))
  fail('consent link does not point at the default relay initially')

await picker.selectOption('example.org')
const href = await consent.getAttribute('href')
console.log('consent link after selection:', href)
if (href !== 'https://example.org/privacy.html')
  fail(`consent link did not follow the selection: ${href}`)

// switching back to the default restores the stock link
await picker.selectOption('nine.testrun.org')
if (!/nine\.testrun\.org\/privacy\.html/.test(await consent.getAttribute('href')))
  fail('consent link did not switch back to the default relay')

console.log('PASS: relay picker offers default first, filters by bridge DNS, consent link follows')
clearTimeout(watchdog)
await browser.close()
cleanup()
process.exit(0)
