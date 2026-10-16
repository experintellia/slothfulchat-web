// E2E test for the onboarding's relay choice (patches desktop/1023, 1070):
// welcome → bridge → profile kind → new profile. Nothing is preselected; the
// relay chooser lists the directory relays (default first), probes each over
// the WS→TCP bridge when it opens (reachability + a round-trip latency), lets
// the user pick up to three and type another, and every picked relay — the
// typed one too — gets measured on the profile screen. The first picked relay
// is the main one until another is made main, and the consent opens a list of
// each picked relay's privacy policy.
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
//  - the bridge probes (/dns/{host}, /tcp/{ip}/143) are intercepted with
//    page.routeWebSocket so the outcomes are deterministic.
import { chromium } from 'playwright'
import { startServers } from './harness.mjs'

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

const { cleanup, watchdog } = await startServers({
  app: APP_PORT,
  proxy: PROXY_PORT,
  watchdogMs: 240_000,
})

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
    const parts = (url.split('/tcp/')[1] || '').split('/')
    const ip = decodeURIComponent(parts[0])
    const port = parts[1]
    if (ip === BLOCKED_IP) {
      // bridge allowlist refuses the tunnel — same close code the real proxy uses
      ws.close({ code: 4003 })
    } else if (port === '143') {
      // A real IMAP server greets in plaintext on 143 the moment the socket is
      // up; on IMAPS :993 it stays SILENT until the client speaks TLS. Answer
      // only on 143 so this test also guards the probe's port choice — probing
      // :993 (or anything that doesn't greet) would leave every relay silent →
      // unreachable, and the reachable-relay assertions below would fail.
      setTimeout(() => {
        try {
          ws.send('* OK ready')
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

// step 1: welcome (no analytics in a test build, so Next is enabled)
await page.getByTestId('onboarding-next').click({ timeout: 60_000 })

// step 2: bridge. The probe of the local bridge is mocked to answer, so the
// "This device" tile (the one in use) reads reachable; Next keeps it, no reload.
await page.getByTestId('bridge-tile-local').waitFor({ timeout: 15_000 })
await page
  .getByTestId('bridge-status')
  .filter({ hasText: /Reachable, \d+ ms/ })
  .waitFor({ timeout: 15_000 })
await page.getByTestId('onboarding-next').click()

// step 3: profile kind → new profile
await page.getByTestId('create-account-button').click({ timeout: 15_000 })

// step 4: nothing preselected, no consent until a relay is picked
const trigger = page.getByTestId('relay-picker-button')
await trigger.waitFor({ state: 'visible', timeout: 30_000 })
if ((await page.locator('[data-testid^="onboarding-relay-"]').count()) !== 0)
  fail('a relay was preselected')
if ((await page.getByTestId('privacy-policies-button').count()) !== 0)
  fail('consent shown before any relay was picked')
// lazy: nothing has been probed before the dialog is opened
if (relayProbed) fail('relays were probed before the dialog was opened (not lazy)')

// creating without a relay is refused with a hint
await page.locator('#displayName').fill('Alice')
await page.getByTestId('login-button').click()
await page.getByText('Pick at least one relay.').waitFor({ timeout: 5_000 })

// open the chooser → the directory relays are listed, junk skipped
await trigger.click()
if (!directoryRequested) fail('chooser opened but the directory was never fetched')
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

// pick two: the dialog stays open and counts
await optExample.click()
await page.getByTestId('relay-option-nine.testrun.org').click()
await page.getByText('Choose relays (2 of 3)').waitFor({ timeout: 5_000 })

// a typed relay outside the directory is the third
await page.getByTestId('relay-option-other').click()
await page.getByTestId('relay-custom-input').fill('custom.relay.example')
await page.getByTestId('relay-custom-confirm').click()
await page.getByText('Choose relays (3 of 3)').waitFor({ timeout: 5_000 })
await page.getByTestId('relay-picker-done').click()

// back on the profile screen: all three listed in pick order, the first is
// main, and the typed relay is measured too (it resolves to nothing here)
const rows = page.locator('[data-testid^="onboarding-relay-"]')
await rows.nth(2).waitFor({ timeout: 5_000 })
const order = await rows.evaluateAll(els => els.map(e => e.dataset.testid))
if (order.join() !== ['example.org', 'nine.testrun.org', 'custom.relay.example'].map(h => 'onboarding-relay-' + h).join())
  fail(`unexpected relay order: ${order}`)
if (!/Main/.test(await rows.nth(0).textContent()))
  fail('first picked relay is not marked main')
await page
  .getByTestId('onboarding-relay-custom.relay.example')
  .filter({ hasText: 'unreachable' })
  .waitFor({ timeout: 15_000 })
await page
  .getByTestId('onboarding-relay-example.org')
  .locator('text=/\\d+ ms/')
  .waitFor({ timeout: 15_000 })

// "Make main" moves a relay to the front
await page
  .getByTestId('onboarding-relay-nine.testrun.org')
  .getByRole('button', { name: 'Make main' })
  .click()
if (!/Main/.test(await rows.nth(0).textContent()) || !/nine\.testrun\.org/.test(await rows.nth(0).textContent()))
  fail('Make main did not move the relay to the front')

// the consent opens each picked relay's privacy policy, main first
await page.getByTestId('privacy-policies-button').click()
const policies = page.getByTestId('privacy-policies-dialog').locator('a')
await policies.first().waitFor({ timeout: 5_000 })
const hrefs = await policies.evaluateAll(els => els.map(e => e.getAttribute('href')))
const want = ['nine.testrun.org', 'example.org', 'custom.relay.example'].map(h => `https://${h}/privacy.html`)
if (hrefs.join() !== want.join()) fail(`privacy policy links: ${hrefs}`)
await page.keyboard.press('Escape')

// removing a relay
await page
  .getByTestId('onboarding-relay-custom.relay.example')
  .getByRole('button', { name: 'Remove relay' })
  .click()
if ((await rows.count()) !== 2) fail('relay was not removed')

console.log(
  'PASS: onboarding steps, no preselection, chooser probes lazily (latency vs unreachable — a refused/blocked probe is never a false success), picks up to 3 incl. a typed relay that gets measured, make main, privacy policies, remove'
)
clearTimeout(watchdog)
await browser.close()
cleanup()
process.exit(0)
