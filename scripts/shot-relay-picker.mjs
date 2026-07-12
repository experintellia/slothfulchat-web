// Screenshot helper for the relay picker dialog (not a test). Boots the web-app
// with a mocked directory + bridge probes and captures two frames: the sonar
// ping shown while relays are still being probed, and the settled dialog with
// latencies and an unreachable relay.
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const script = p => fileURLToPath(new URL(p, import.meta.url))
const PROXY_PORT = 8651
const APP_PORT = 8652
const OUT = process.env.SHOT_OUT || script('../relay-picker.png')
const OUT_PING = OUT.replace(/\.png$/, '-ping.png')

const RELAYS_JSON = JSON.stringify({
  relays: [
    { host: 'nine.testrun.org' },
    { host: 'mehl.cloud' },
    { host: 'chat.adminforge.de' },
    { host: 'relay.does-not-exist.invalid' },
  ],
})

const IP_BY_HOST = {
  'nine.testrun.org': '10.0.0.1',
  'mehl.cloud': '10.0.0.2',
  'chat.adminforge.de': '10.0.0.3',
}
const LATENCY_BY_IP = { '10.0.0.1': 34, '10.0.0.2': 71, '10.0.0.3': 128 }
// delay DNS answers so the sonar ping is on screen for the first frame
const DNS_DELAY = 1400

const procs = [
  spawn('node', [script('../packages/ws-tcp-proxy/ws-tcp-proxy.mjs')], {
    env: { ...process.env, PORT: String(PROXY_PORT) },
    stdio: 'ignore',
  }),
  spawn('node', [script('../packages/web-app/serve.mjs')], {
    env: { ...process.env, PORT: String(APP_PORT) },
    stdio: 'ignore',
  }),
]
const cleanup = () => procs.forEach(p => p.kill())
process.on('exit', cleanup)
await new Promise(r => setTimeout(r, 600))

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_EXECUTABLE || undefined,
})
const page = await browser.newPage({ viewport: { width: 440, height: 860 } })
await page.addInitScript(() => {
  Object.defineProperty(window, 'eval', { value: window.eval, writable: false })
})
await page.route('https://raw.githubusercontent.com/**', route =>
  route.fulfill({
    status: 200,
    contentType: 'text/plain; charset=utf-8',
    body: RELAYS_JSON,
  })
)
await page.routeWebSocket(/\/(dns|tcp)\//, ws => {
  const url = ws.url()
  if (url.includes('/dns/')) {
    const host = decodeURIComponent(url.split('/dns/')[1] || '')
    const ip = IP_BY_HOST[host]
    setTimeout(() => {
      try {
        ws.send(JSON.stringify(ip ? [ip] : []))
        ws.close()
      } catch {
        /* closed */
      }
    }, DNS_DELAY)
  } else if (url.includes('/tcp/')) {
    const ip = decodeURIComponent((url.split('/tcp/')[1] || '').split('/')[0])
    setTimeout(() => {
      try {
        ws.send('tls')
      } catch {
        /* closed */
      }
    }, LATENCY_BY_IP[ip] ?? 30)
  }
})

await page.goto(`http://localhost:${APP_PORT}/main.html`)
await page.getByTestId('create-account-button').click({ timeout: 60_000 })
await page.getByTestId('relay-picker-button').click({ timeout: 30_000 })

// frame 1: relays still probing → sonar ping
await page.getByTestId('relay-option-nine.testrun.org').waitFor({ state: 'visible' })
await page.waitForTimeout(500)
await page.screenshot({ path: OUT_PING })
console.log('wrote', OUT_PING)

// frame 2: settled → latencies + unreachable
await page
  .getByTestId('relay-option-relay.does-not-exist.invalid')
  .filter({ hasText: 'unreachable' })
  .waitFor({ timeout: 15_000 })
await page.waitForTimeout(400)
await page.screenshot({ path: OUT })
console.log('wrote', OUT)

await browser.close()
cleanup()
process.exit(0)
