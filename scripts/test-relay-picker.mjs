// E2E test for the instant-onboarding relay picker (patches/desktop 0042 +
// 0047): the "create profile" screen offers a custom dropdown of chatmail
// relays — default relay first, then the relays from the live directory. The
// list is fetched up front; each relay is probed over the WS→TCP bridge only
// once the dropdown is opened (reachability + a rough latency), and an
// "Other…" entry lets the user type any relay by hostname. The privacy-policy
// consent link follows the selection.
//
// Both network dependencies are mocked so the test is hermetic and offline:
//  - the directory fetch (chatmail-relays-mirror relays.json on
//    raw.githubusercontent.com) is answered from a fixture:
//      nine.testrun.org — the default relay, must stay first
//      example.org — resolvable, reachable, shows a latency
//      relay.does-not-exist.invalid — resolves to nothing, shown but disabled
//      a junk entry (host is a URL) — must be skipped by the parser
//  - the bridge WebSocket probes (/dns/{host}, /tcp/{ip}/993) are intercepted
//    with page.routeWebSocket so reachability/latency outcomes are
//    deterministic regardless of the sandbox's DNS egress.
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

// intercept the bridge probes: /dns/{host} answers with IPs (empty = the
// unreachable relay), /tcp/{ip}/993 sends a byte so a latency is measured.
// `relayProbed` records whether any *relay* (not the runtime's /dns/localhost
// bridge health check) was probed — used to assert the picker probes lazily.
let relayProbed = false
await page.routeWebSocket(/\/(dns|tcp)\//, ws => {
  const url = ws.url()
  if (url.includes('/dns/')) {
    const host = decodeURIComponent(url.split('/dns/')[1] || '')
    if (host !== 'localhost') relayProbed = true
    const ips = host === 'relay.does-not-exist.invalid' ? [] : ['93.184.216.34']
    ws.send(JSON.stringify(ips))
    ws.close()
  } else if (url.includes('/tcp/')) {
    relayProbed = true
    // stand in for the relay's TLS ServerHello, so the picker times a handshake
    setTimeout(() => {
      try {
        ws.send('tls')
      } catch {
        /* already closed */
      }
    }, 12)
  }
})

const fail = msg => {
  console.error(`FAIL: ${msg}`)
  cleanup()
  process.exit(1)
}

await page.goto(`http://localhost:${APP_PORT}/main.html`)

// welcome screen → "Create New Profile" → instant onboarding screen
await page.getByTestId('create-account-button').click({ timeout: 60_000 })

// the picker button appears once the (mocked) directory is fetched — it shows
// the default relay and only needs the directory (>= 2 relays), no probing yet
const button = page.getByTestId('relay-picker-button')
await button.waitFor({ state: 'visible', timeout: 30_000 })
if (!directoryRequested) fail('picker visible but directory was never fetched')
if (!/nine\.testrun\.org/.test(await button.textContent()))
  fail(`default relay not shown on the closed picker: ${await button.textContent()}`)

// consent link starts on the default relay
const consent = page.locator('a', { hasText: 'Privacy Policy' })
if (!/nine\.testrun\.org/.test((await consent.getAttribute('href')) || ''))
  fail('consent link does not point at the default relay initially')

// lazy: the directory has been fetched and the picker is showing, but no relay
// has been probed over the bridge yet — probing must wait until the dropdown is
// opened (the whole point of the loading rework)
if (relayProbed)
  fail('relays were probed before the dropdown was opened (probing is not lazy)')

// open the dropdown → the directory relays are listed, junk skipped
await button.click()
await page.getByTestId('relay-picker-menu').waitFor({ state: 'visible' })
const optDefault = page.getByTestId('relay-option-nine.testrun.org')
const optExample = page.getByTestId('relay-option-example.org')
const optInvalid = page.getByTestId('relay-option-relay.does-not-exist.invalid')
await optExample.waitFor({ state: 'visible' })
if ((await optDefault.count()) === 0) fail('default relay missing from the menu')
if (
  (await page.locator('[data-testid^="relay-option-"]', { hasText: 'chatmail.at' }).count()) !== 0
)
  fail('junk (URL-valued host) entry not skipped')

// probing resolves: example.org reachable with a latency badge, the invalid
// relay disabled and marked unreachable
await optExample.locator('text=/\\d+ ms/').waitFor({ timeout: 15_000 })
await page
  .getByTestId('relay-option-relay.does-not-exist.invalid')
  .filter({ hasText: 'unreachable' })
  .waitFor({ timeout: 15_000 })
if ((await optInvalid.getAttribute('aria-disabled')) !== 'true')
  fail('unreachable relay is not disabled')
if ((await optExample.getAttribute('aria-disabled')) === 'true')
  fail('reachable relay is unexpectedly disabled')

// select example.org → consent link follows
await optExample.click()
let href = await consent.getAttribute('href')
console.log('consent link after selecting example.org:', href)
if (href !== 'https://example.org/privacy.html')
  fail(`consent link did not follow the selection: ${href}`)

// the "Other…" field accepts a hand-typed relay
await button.click()
await page.getByTestId('relay-option-other').click()
await page.getByTestId('relay-custom-input').fill('custom.relay.example')
await page.getByTestId('relay-custom-confirm').click()
href = await consent.getAttribute('href')
console.log('consent link after typing a custom relay:', href)
if (href !== 'https://custom.relay.example/privacy.html')
  fail(`consent link did not follow the custom relay: ${href}`)

// switching back to the default restores the stock link
await button.click()
await page.getByTestId('relay-option-nine.testrun.org').click()
if (!/nine\.testrun\.org\/privacy\.html/.test((await consent.getAttribute('href')) || ''))
  fail('consent link did not switch back to the default relay')

console.log(
  'PASS: relay picker lists directory relays, probes lazily (latency + unreachable), custom relay + consent link follow'
)
clearTimeout(watchdog)
await browser.close()
cleanup()
process.exit(0)
