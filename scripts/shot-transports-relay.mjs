// Screenshot helper for the "add relays in the Transports dialog" feature (not a
// test). Boots the web-app fully offline with a provisioned webimap account and
// a handful of contacts, then captures three frames:
//   1. transports-dialog.png      — the Transports dialog with its two footer
//      buttons ("Add from relay list…" + "Scan relay QR code…")
//   2. relay-picker-initial.png   — the picker: directory relays auto-probed
//      (latencies), plus the "Relays your contacts use" section UN-probed
//      (per-host contact counts, no latency), with its "Measure ping" button
//   3. relay-picker-pinged.png    — after "Measure ping": the contact section
//      re-sorted by latency, the unreachable host greyed/disabled + last
// Bonus: relay-picker-pinging.png — mid-sonar on the contact section.
//
// Offline like its siblings: the relay directory JSON is a page.route fixture,
// the bridge probes (/dns, /tcp) are page.routeWebSocket mocks, and the account
// is provisioned against an in-process mock madmail server on 127.0.0.1 (no real
// mail server, no real bridge). See scripts/shot-relay-picker.mjs (probe/boot
// pattern) and scripts/test-link-preview-e2e.mjs (offline webimap account).
//
// Run from the repo root:
//   CHROMIUM_EXECUTABLE=/opt/pw-browsers/chromium \
//     node scripts/shot-transports-relay.mjs
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'
import { chromium } from 'playwright'

const script = p => fileURLToPath(new URL(p, import.meta.url))
const PROXY_PORT = 8661
const APP_PORT = 8662
const OUT =
  process.env.SHOT_OUT ||
  '/tmp/claude-0/-home-user-slothfulchat-web/b27873ea-fd9c-5736-8c8b-3157bf0b02f7/scratchpad/shots'

// --- relay directory fixture (default relay is prepended by the app) ---
const RELAYS_JSON = JSON.stringify({
  source: 'https://chatmail.at/relays',
  fetchedAt: '2026-07-20T00:00:00Z',
  relays: [
    { host: 'nine.testrun.org' }, // == default, deduped by the app
    { host: 'mehl.cloud' },
    { host: 'chat.adminforge.de' },
  ],
})

// contacts live on domains NOT in the directory, with distinct latencies so the
// post-"Measure ping" order differs visibly from the initial contact-count order
const CONTACT_HOSTS = new Set([
  'chat.example.com',
  'relay.friends.example',
  'mail.slow.example',
  'gone.example', // unresolvable → unreachable → sorts last, disabled
])
const CONTACTS = [
  ['amy@chat.example.com', 'Amy'],
  ['ben@chat.example.com', 'Ben'],
  ['cara@chat.example.com', 'Cara'],
  ['dan@relay.friends.example', 'Dan'],
  ['eve@relay.friends.example', 'Eve'],
  ['fay@mail.slow.example', 'Fay'],
  ['gil@gone.example', 'Gil'],
]

const IP_BY_HOST = {
  'nine.testrun.org': '10.0.0.1',
  'mehl.cloud': '10.0.0.2',
  'chat.adminforge.de': '10.0.0.3',
  'chat.example.com': '10.1.0.1',
  'relay.friends.example': '10.1.0.2',
  'mail.slow.example': '10.1.0.3',
  // gone.example: deliberately absent → empty DNS answer → unreachable
}
const LATENCY_BY_IP = {
  '10.0.0.1': 34,
  '10.0.0.2': 71,
  '10.0.0.3': 128,
  '10.1.0.1': 95, // chat.example.com  (3 contacts, mid latency)
  '10.1.0.2': 22, // relay.friends.example (2 contacts, fastest)
  '10.1.0.3': 180, // mail.slow.example (1 contact, slow)
}
// DNS delay: directory settles fast; contacts linger so the sonar is catchable.
const dnsDelay = host => (CONTACT_HOSTS.has(host) ? 550 : 40)

// --- mock madmail server (in-process, 127.0.0.1) so the core can provision a
// real configured webimap account with no bridge and no real mail server ---
const users = new Map()
let userSeq = 0
// The mock hands out these addresses in order: the first is the main account
// (its domain becomes an excluded transport), the rest become the key-contacts.
const ADDR_QUEUE = [
  'owner@webimap.example',
  ...CONTACTS.map(c => c[0]),
]
const mjson = (res, code, obj) => {
  res.statusCode = code
  res.setHeader('content-type', 'application/json')
  res.end(JSON.stringify(obj))
}
const mock = createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Headers', 'X-Email, X-Password, Content-Type')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS')
  if (req.method === 'OPTIONS') {
    res.statusCode = 204
    res.end()
    return
  }
  const url = new URL(req.url, 'http://mock')
  if (req.method === 'POST' && url.pathname === '/new') {
    const email = ADDR_QUEUE[userSeq++] ?? `u${userSeq}@webimap.example`
    const password = randomBytes(9).toString('hex')
    users.set(email, { password })
    mjson(res, 200, { email, password, dclogin_url: '' })
    return
  }
  if (url.pathname.startsWith('/webimap/')) {
    const user = users.get(req.headers['x-email'])
    if (!user || user.password !== req.headers['x-password'])
      return mjson(res, 401, { error: 'bad credentials' })
    if (url.pathname === '/webimap/mailboxes')
      return mjson(res, 200, [{ name: 'INBOX', messages: 0, unseen: 0 }])
    if (url.pathname === '/webimap/messages') return mjson(res, 200, [])
    if (url.pathname === '/webimap/send') return mjson(res, 200, { status: 'sent' })
  }
  mjson(res, 404, { error: 'not found' })
})
await new Promise(r => mock.listen(0, '127.0.0.1', r))
const QR = `webimapaccount:127.0.0.1:${mock.address().port}`

// --- app + bridge processes (bridge is spawned for parity; all its WS traffic
// is intercepted by routeWebSocket below) ---
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
const cleanup = () => {
  procs.forEach(p => p.kill())
  mock.close()
}
process.on('exit', cleanup)
const watchdog = setTimeout(() => {
  console.error('FAIL: watchdog (6 min) — hung')
  cleanup()
  process.exit(1)
}, 360_000)
await new Promise(r => setTimeout(r, 700))

// --- probe-before-measure guard: contact rows must NOT probe until the user
// clicks "Measure ping". Any /dns|/tcp for a contact host while this is false is
// a product bug (see task) — recorded, reported, never faked. ---
let measureClicked = false
let contactProbedEarly = null

const browser = await chromium.launch({
  args: ['--disable-features=LocalNetworkAccessChecks'],
  executablePath: process.env.CHROMIUM_EXECUTABLE || undefined,
})
const page = await browser.newPage({ viewport: { width: 720, height: 1040 } })
page.on('pageerror', e => console.error('[pageerror]', e.message))
// upstream's avoid-eval.js breaks page.evaluate; freeze the real eval
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
    if (CONTACT_HOSTS.has(host) && !measureClicked && contactProbedEarly === null)
      contactProbedEarly = host
    const ip = IP_BY_HOST[host]
    setTimeout(() => {
      try {
        ws.send(JSON.stringify(ip ? [ip] : []))
        ws.close()
      } catch {
        /* closed */
      }
    }, dnsDelay(host))
  } else if (url.includes('/tcp/')) {
    const ip = decodeURIComponent((url.split('/tcp/')[1] || '').split('/')[0])
    const ms = LATENCY_BY_IP[ip]
    if (ms === undefined) {
      ws.close({ code: 4003 }) // no mapping → unreachable
      return
    }
    setTimeout(() => {
      try {
        ws.send('* OK ready')
      } catch {
        /* closed */
      }
    }, ms)
  }
})

const rpc = (method, ...args) =>
  page.evaluate(([m, a]) => window.exp.rpc[m](...a), [method, args])
const shot = async name => {
  await page.screenshot({ path: `${OUT}/${name}.png` })
  console.log('wrote', `${OUT}/${name}.png`)
}

let failed = false
try {
  await page.goto(`http://localhost:${APP_PORT}/main.html?proxy=ws://localhost:${PROXY_PORT}`)
  await page.waitForFunction(() => window.__coreSystemInfo, null, { timeout: 120_000 })
  console.log('OK: core booted')

  // Provision the auto-created account as an offline webimap account (the mock
  // assigns it owner@webimap.example — that domain is the excluded transport).
  const accountId = (await rpc('getAllAccountIds'))[0] ?? (await rpc('addAccount'))
  await rpc('addTransportFromQr', accountId, QR)
  await rpc('setConfig', accountId, 'displayname', 'Relay Tester')

  // The picker's contact section only counts KEY-contacts: the product's
  // getContactIds(accountId, 0, null) filters on `(fingerprint='')=false`, so
  // keyless address-book contacts (createContact / exp.importContacts) never
  // appear — only contacts you have a PGP key for do. So build real key-contacts
  // on the target relay domains: spin up one throwaway webimap account per
  // contact (the mock hands each the next ADDR_QUEUE address), start its IO so
  // the key is generated, export its keyed vCard, and import that into the main
  // account. Then drop the throwaways.
  for (const [, name] of CONTACTS) {
    const tId = await rpc('addAccount')
    await rpc('addTransportFromQr', tId, QR)
    await rpc('startIo', tId)
    await rpc('setConfig', tId, 'displayname', name)
    let vcard = ''
    for (let i = 0; i < 40 && !vcard; i++) {
      vcard = await rpc('makeVcard', tId, [1])
      if (!vcard) await new Promise(r => setTimeout(r, 250))
    }
    if (!vcard) throw new Error(`no keyed vcard for ${name} (key never generated)`)
    await rpc('importVcardContents', accountId, vcard)
    await rpc('removeAccount', tId)
  }
  const keyContacts = (await rpc('getContactIds', accountId, 0, null)).length
  console.log(`OK: ${keyContacts} key-contacts on main account`)
  if (keyContacts < CONTACTS.length)
    throw new Error(`expected ${CONTACTS.length} key-contacts, have ${keyContacts}`)

  // OPFS write-through barrier (see test-link-preview-e2e.mjs #72): reload only
  // after the account + contacts have mirrored to OPFS, else the reload tears
  // down the worker mid-flush and the account is gone.
  const markerPath = await page.evaluate(() =>
    window.exp.runtime.writeTempFile('opfs-flush-barrier', 'x')
  )
  const flushDeadline = Date.now() + 120_000
  for (;;) {
    const flushed = await page.evaluate(async p => {
      try {
        let dir = await navigator.storage.getDirectory()
        const parts = ('memfs' + p).split('/').filter(Boolean)
        for (const part of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(part)
        await dir.getFileHandle(parts[parts.length - 1])
        return true
      } catch {
        return false
      }
    }, markerPath)
    if (flushed) break
    if (Date.now() > flushDeadline) throw new Error('OPFS flush barrier never reached')
    await new Promise(r => setTimeout(r, 250))
  }
  await page.reload()
  await page.waitForFunction(() => window.__coreSystemInfo, null, { timeout: 120_000 })

  // select the account → main screen
  const accItem = page.getByTestId(`account-item-${accountId}`)
  await accItem.waitFor({ state: 'visible', timeout: 120_000 })
  await accItem.click()

  // Settings → Advanced → Transports
  await page.getByTestId('open-settings-button').click()
  await page.getByTestId('open-advanced-settings').click()
  await page.getByTestId('open-transport-settings').click()

  const dialog = page.getByTestId('transports-dialog')
  await dialog.waitFor({ state: 'visible', timeout: 30_000 })
  await page.getByTestId('transports-add-from-list').waitFor({ state: 'visible' })
  await page.waitForTimeout(300)
  await shot('transports-dialog')

  // --- frame 2: open the picker ---
  await page.getByTestId('transports-add-from-list').click()
  // directory relays auto-probe on open — wait for the slowest to settle
  await page
    .getByTestId('relay-option-chat.adminforge.de')
    .locator('text=/\\d+ ms/')
    .waitFor({ timeout: 20_000 })
  // contact section present, un-probed
  await page.getByTestId('relay-option-chat.example.com').waitFor({ state: 'visible' })
  await page.getByTestId('relay-contact-measure').waitFor({ state: 'visible' })
  await page.waitForTimeout(400)
  if (contactProbedEarly)
    throw new Error(
      `PRODUCT BUG: contact host ${contactProbedEarly} was probed before "Measure ping" was clicked`
    )
  await shot('relay-picker-initial')

  // --- frame 3 (+ bonus): Measure ping ---
  measureClicked = true
  await page.getByTestId('relay-contact-measure').click()
  // bonus: catch the sonar mid-probe (contact DNS delay ~550ms)
  await page.waitForTimeout(180)
  await shot('relay-picker-pinging')
  // settled: the unreachable contact host reads "unreachable" and is disabled
  const gone = page.getByTestId('relay-option-gone.example')
  await gone.filter({ hasText: 'unreachable' }).waitFor({ timeout: 20_000 })
  await page
    .getByTestId('relay-option-relay.friends.example')
    .locator('text=/\\d+ ms/')
    .waitFor({ timeout: 20_000 })
  await page.waitForTimeout(400)
  if ((await gone.getAttribute('aria-disabled')) !== 'true')
    console.warn('note: unreachable contact host is not disabled (expected aria-disabled=true)')
  await shot('relay-picker-pinged')

  console.log('DONE: 4 frames written to', OUT)
} catch (err) {
  failed = true
  console.error('FAIL:', err.message)
  await page.screenshot({ path: `${OUT}/error.png` }).catch(() => {})
} finally {
  clearTimeout(watchdog)
  await browser.close()
  cleanup()
}
process.exit(failed ? 1 : 0)
