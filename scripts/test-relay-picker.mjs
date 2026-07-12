// E2E test for the instant-onboarding relay picker (patch desktop/0042): the
// "create profile" screen shows a row with the chosen chatmail relay and a
// button that opens a dialog to change it. The dialog lists the directory
// relays (default first), probes each over the WS→TCP bridge when it opens
// (reachability + a round-trip latency), offers an "Other…" hostname field, and
// the privacy-policy consent link follows the selection.
//
// Both network dependencies are mocked so the test is hermetic and offline:
//  - the directory fetch (chatmail-relays-mirror relays.json) is a fixture:
//      nine.testrun.org — the default relay, first, reachable
//      example.org — reachable, shows a latency
//      relay.blocked.example — resolves, but the bridge refuses the /tcp probe
//        (allowlist, close 4003): the real signup would be refused the same
//        way, so it must show "unreachable" + disabled, never a false success
//      relay.does-not-exist.invalid — resolves to nothing: unreachable, disabled
//      a junk entry (host is a URL) — skipped by the parser
//  - the bridge probes (/dns/{host}, /tcp/{ip}/993) are intercepted with
//    page.routeWebSocket so the outcomes are deterministic.
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
    { host: 'relay.blocked.example' },
    { host: 'relay.does-not-exist.invalid' },
    { host: 'https://chatmail.at/doc/relay' },
  ],
})

// per-host resolved IP, so the /tcp handler can treat the blocked relay's IP
// differently; the NXDOMAIN relay resolves to nothing
const IP_BY_HOST = {
  'nine.testrun.org': '10.0.0.1',
  'example.org': '10.0.0.2',
  'relay.blocked.example': '10.0.0.9',
}
const BLOCKED_IP = '10.0.0.9'

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

// intercept the bridge probes. `relayProbed` records whether any *relay* (not
// the runtime's /dns/localhost health check) was probed — used to assert the
// dialog probes lazily (only once opened).
let relayProbed = false
await page.routeWebSocket(/\/(dns|tcp)\//, ws => {
  const url = ws.url()
  if (url.includes('/dns/')) {
    const host = decodeURIComponent(url.split('/dns/')[1] || '')
    if (host !== 'localhost') relayProbed = true
    const ip = IP_BY_HOST[host]
    ws.send(JSON.stringify(ip ? [ip] : []))
    ws.close()
  } else if (url.includes('/tcp/')) {
    relayProbed = true
    const ip = decodeURIComponent((url.split('/tcp/')[1] || '').split('/')[0])
    if (ip === BLOCKED_IP) {
      // bridge allowlist refuses the tunnel — same close code the real proxy uses
      ws.close({ code: 4003 })
    } else {
      // stand in for the relay's TLS ServerHello, so a latency is measured
      setTimeout(() => {
        try {
          ws.send('tls')
        } catch {
          /* already closed */
        }
      }, 12)
    }
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

// the picker row appears once the (mocked) directory is fetched; it shows the
// default relay and only needs the directory (>= 2 relays), no probing yet
const trigger = page.getByTestId('relay-picker-button')
await trigger.waitFor({ state: 'visible', timeout: 30_000 })
if (!directoryRequested) fail('picker visible but directory was never fetched')
if (!/nine\.testrun\.org/.test(await trigger.textContent()))
  fail(`default relay not shown on the picker row: ${await trigger.textContent()}`)

// consent link starts on the default relay
const consent = page.locator('a', { hasText: 'Privacy Policy' })
if (!/nine\.testrun\.org/.test((await consent.getAttribute('href')) || ''))
  fail('consent link does not point at the default relay initially')

// lazy: nothing has been probed before the dialog is opened
if (relayProbed) fail('relays were probed before the dialog was opened (not lazy)')

// open the dialog → the directory relays are listed, junk skipped
await trigger.click()
const optExample = page.getByTestId('relay-option-example.org')
const optBlocked = page.getByTestId('relay-option-relay.blocked.example')
const optInvalid = page.getByTestId('relay-option-relay.does-not-exist.invalid')
await optExample.waitFor({ state: 'visible', timeout: 15_000 })
if ((await page.getByTestId('relay-option-nine.testrun.org').count()) === 0)
  fail('default relay missing from the dialog')
if (
  (await page.locator('[data-testid^="relay-option-"]', { hasText: 'chatmail.at' }).count()) !== 0
)
  fail('junk (URL-valued host) entry not skipped')

// example.org: reachable, shows a latency
await optExample.locator('text=/\\d+ ms/').waitFor({ timeout: 15_000 })
if ((await optExample.getAttribute('aria-disabled')) === 'true')
  fail('reachable relay is unexpectedly disabled')

// relay.blocked.example: the bridge (allowlist) refused the tunnel with 4003,
// so the real signup would be refused the same way — it must read as
// unreachable + disabled, never a latency (a refused probe is not a success)
await optBlocked.filter({ hasText: 'unreachable' }).waitFor({ timeout: 15_000 })
if ((await optBlocked.getAttribute('aria-disabled')) !== 'true')
  fail('a relay the bridge refused to reach was not disabled')
if ((await optBlocked.locator('text=/\\d+ ms/').count()) !== 0)
  fail('a probe the bridge refused was shown with a latency (false success)')

// relay.does-not-exist.invalid: unreachable and disabled
await optInvalid.filter({ hasText: 'unreachable' }).waitFor({ timeout: 15_000 })
if ((await optInvalid.getAttribute('aria-disabled')) !== 'true')
  fail('unreachable relay is not disabled')

// select example.org → dialog closes, consent link follows
await optExample.click()
let href = await consent.getAttribute('href')
console.log('consent link after selecting example.org:', href)
if (href !== 'https://example.org/privacy.html')
  fail(`consent link did not follow the selection: ${href}`)

// the "Other…" field accepts a hand-typed relay
await trigger.click()
await page.getByTestId('relay-option-other').click()
await page.getByTestId('relay-custom-input').fill('custom.relay.example')
await page.getByTestId('relay-custom-confirm').click()
href = await consent.getAttribute('href')
console.log('consent link after typing a custom relay:', href)
if (href !== 'https://custom.relay.example/privacy.html')
  fail(`consent link did not follow the custom relay: ${href}`)

// switching back to the default restores the stock link
await trigger.click()
await page.getByTestId('relay-option-nine.testrun.org').click()
if (!/nine\.testrun\.org\/privacy\.html/.test((await consent.getAttribute('href')) || ''))
  fail('consent link did not switch back to the default relay')

console.log(
  'PASS: relay dialog lists relays, probes lazily (latency vs unreachable — a refused/blocked probe is never a false success), custom relay + consent link follow'
)
clearTimeout(watchdog)
await browser.close()
cleanup()
process.exit(0)
