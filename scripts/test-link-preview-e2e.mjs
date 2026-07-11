// End-to-end test for the sender-baked link-preview ghost UI — runs FULLY
// OFFLINE (mock madmail for the account, a local OpenGraph server for pages,
// the ws-tcp bridge with UNFURL=1 for the CORS fallback).
//
// The OG server listens on 127.0.0.1 and is reached as http://og.localhost:PORT
// (Chromium resolves *.localhost to loopback; a host-resolver rule pins it) —
// plain `localhost` is deliberately not previewable. All previews go through
// the bridge's unfurl endpoint (there is no direct browser-fetch tier); the
// bridge fetches server-side, so a page's CORS headers don't matter — the
// /nocors-* pages (no `Access-Control-Allow-Origin`) preview just the same.
// The bridge runs with UNFURL on (no allowlist) + UNFURL_ALLOW_PRIVATE=1 so it
// may fetch the loopback OG server. A final case points the app at a dead
// bridge port to check the "needs a bridge with unfurl" hint.
//
// Flow driven through the actual UI:
//   type URL → ghost appears → Add → loading → ready chip → draft has an
//   Image attachment → send → outgoing message renders the baked PNG card;
//   expand↔collapse re-attaches with the other layout; remove clears the
//   draft; dismiss hides the ghost. Card screenshots (light + dark + custom
//   theme) land in .cache/link-preview-e2e/ for visual inspection.
//
// Requires packages/core-wasm built and packages/web-app assembled+built.
// Run:  node scripts/test-link-preview-e2e.mjs
// (CHROMIUM_BIN=/path/to/chrome overrides the playwright-managed browser.)
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'
import { deflateSync } from 'node:zlib'
import { chromium } from 'playwright'

const script = (p) => fileURLToPath(new URL(p, import.meta.url))
const OUT = script('../.cache/link-preview-e2e/')
await mkdir(OUT, { recursive: true })
const APP_PORT = 8674

// --- tiny png (from test-export-chat-html.mjs) ---
function tinyPng(seed = 0, w = 48, h = w) {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    return c >>> 0
  })
  const crc = (buf) => {
    let c = 0xffffffff
    for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8)
    return (c ^ 0xffffffff) >>> 0
  }
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type), data])
    const out = Buffer.alloc(body.length + 8)
    out.writeUInt32BE(data.length, 0)
    body.copy(out, 4)
    out.writeUInt32BE(crc(body), body.length + 4)
    return out
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  const raw = Buffer.alloc(h * (w * 3 + 1))
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * (w * 3 + 1) + 1 + x * 3
      const on = (x < w / 2) !== (y < h / 2)
      raw[i] = on ? (0x1d + seed * 90) & 0xff : 0xff
      raw[i + 1] = on ? 0x74 : (0xd0 - seed * 70) & 0xff
      raw[i + 2] = on ? 0xf5 : 0x2a
    }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

// --- mock madmail (minimal subset: /new + auth'd endpoints the core polls) ---
const users = new Map()
let userSeq = 0
const json = (res, code, obj) => {
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
    const email = `u${++userSeq}@webimap.example`
    const password = randomBytes(9).toString('hex')
    users.set(email, { password })
    json(res, 200, { email, password, dclogin_url: '' })
    return
  }
  if (url.pathname.startsWith('/webimap/')) {
    const user = users.get(req.headers['x-email'])
    if (!user || user.password !== req.headers['x-password']) {
      return json(res, 401, { error: 'bad credentials' })
    }
    if (url.pathname === '/webimap/mailboxes')
      return json(res, 200, [{ name: 'INBOX', messages: 0, unseen: 0 }])
    if (url.pathname === '/webimap/messages') return json(res, 200, [])
    if (url.pathname === '/webimap/send') return json(res, 200, { status: 'sent' })
  }
  json(res, 404, { error: 'not found' })
})
await new Promise((r) => mock.listen(0, '127.0.0.1', r))
const QR = `webimapaccount:127.0.0.1:${mock.address().port}`

// --- OpenGraph test server (CORS-permissive) ---
const heroPng = tinyPng(1, 800, 400)
const squarePng = tinyPng(2, 96, 96)
const page_ = (title, extraMeta) => `<!doctype html>
<html><head><meta charset="utf-8"><title>${title}</title>${extraMeta}</head>
<body>hello</body></html>`
const ogServer = createServer((req, res) => {
  const path = new URL(req.url, 'http://og').pathname
  // /nocors-* pages get NO Access-Control-Allow-Origin header: browser fetch()
  // fails on them and the app must fall back to the unfurl service.
  if (!path.startsWith('/nocors-')) {
    res.setHeader('Access-Control-Allow-Origin', '*')
  }
  const og = (p, c) => `<meta property="${p}" content="${c}">`
  if (path === '/nocors-hero.html') {
    res.setHeader('content-type', 'text/html; charset=utf-8')
    return res.end(
      page_(
        'Unfurl article',
        og('og:title', 'Fetched via the unfurl service') +
          og('og:description', 'This page blocks CORS; the unfurl service got it anyway.') +
          og('og:image', `${ogBase}/nocors-hero.png`) +
          og('og:image:width', '800') +
          og('og:image:height', '400') +
          '<meta name="twitter:card" content="summary_large_image">'
      )
    )
  }
  if (path === '/nocors-hero.png') {
    res.setHeader('content-type', 'image/png')
    return res.end(heroPng)
  }
  if (path === '/hero.html') {
    res.setHeader('content-type', 'text/html; charset=utf-8')
    return res.end(
      page_(
        'Hero article',
        og('og:title', 'Baked previews, explained') +
          og('og:description', 'How the sender bakes a link preview card into a PNG.') +
          og('og:image', `${ogBase}/hero.png`) +
          og('og:image:width', '800') +
          og('og:image:height', '400') +
          '<meta name="twitter:card" content="summary_large_image">'
      )
    )
  }
  if (path === '/compact.html') {
    res.setHeader('content-type', 'text/html; charset=utf-8')
    return res.end(
      page_(
        'Compact note',
        og('og:title', 'A small page') +
          og('og:description', 'Square thumbnail, compact layout.') +
          og('og:image', `${ogBase}/square.png`) +
          '<meta name="twitter:card" content="summary">'
      )
    )
  }
  if (path === '/hero.png' || path === '/square.png') {
    res.setHeader('content-type', 'image/png')
    return res.end(path === '/hero.png' ? heroPng : squarePng)
  }
  res.statusCode = 404
  res.end('nope')
})
await new Promise((r) => ogServer.listen(0, '127.0.0.1', r))
const ogBase = `http://og.localhost:${ogServer.address().port}`
console.log(`mock madmail ${QR}; og server ${ogBase}`)

// --- web-app server + the ws-tcp bridge with its unfurl endpoint enabled ---
const BRIDGE_PORT = 8675
const appServer = spawn('node', [script('../packages/web-app/serve.mjs')], {
  env: { ...process.env, PORT: String(APP_PORT) },
  stdio: 'inherit',
})
const bridge = spawn(
  'node',
  [script('../packages/ws-tcp-proxy/ws-tcp-proxy.mjs')],
  {
    env: {
      ...process.env,
      PORT: String(BRIDGE_PORT),
      // no UNFURL= and no allowlist → the endpoint is on by default (the
      // local-bridge case); ALLOW_PRIVATE lets it fetch the loopback OG server
      UNFURL_ALLOW_PRIVATE: '1',
    },
    stdio: 'inherit',
  }
)
const cleanup = () => {
  appServer.kill()
  bridge.kill()
  mock.close()
  ogServer.close()
}
process.on('exit', cleanup)
const watchdog = setTimeout(() => {
  console.error('FAIL: watchdog (6 min)')
  cleanup()
  process.exit(1)
}, 360_000)
await new Promise((r) => setTimeout(r, 700))

// --- browser ---
const launchOpts = {
  args: [
    // pin *.localhost to loopback even if the platform resolver disagrees
    `--host-resolver-rules=MAP og.localhost 127.0.0.1`,
    // headless Chromium can't show the Local Network Access prompt, which
    // would block the page's fetch() of the localhost unfurl service
    '--disable-features=LocalNetworkAccessChecks',
  ],
  ...(process.env.CHROMIUM_BIN ? { executablePath: process.env.CHROMIUM_BIN } : {}),
}
const browser = await chromium.launch(launchOpts)
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
page.on('console', (m) => {
  if (/panicked at|link preview/.test(m.text())) console.log('[page]', m.text().slice(0, 300))
})
page.on('pageerror', (e) => console.error('[pageerror]', e.message))
await page.addInitScript(() => {
  Object.defineProperty(window, 'eval', { value: window.eval, writable: false })
})
const rpc = (method, ...args) =>
  page.evaluate(([m, a]) => window.exp.rpc[m](...a), [method, args])

const composer = () => page.locator('textarea.create-or-edit-message-input')
const shot = async (name) => {
  await page.waitForTimeout(300)
  await page.screenshot({ path: `${OUT}${name}.png` })
  console.log(`shot: ${OUT}${name}.png`)
}

let failed = false
try {
  // Point the app at the UNFURL=1 bridge as its proxy; the app derives the
  // unfurl endpoint from that same URL (ws→http). The webimap account below
  // talks to mock madmail over direct HTTP, so the bridge's tunnel is unused —
  // it's here only for the unfurl route.
  await page.goto(
    `http://localhost:${APP_PORT}/main.html?proxy=ws://localhost:${BRIDGE_PORT}`
  )
  await page.waitForFunction(() => window.__coreSystemInfo, null, { timeout: 120_000 })
  console.log('OK: wasm core booted')

  // one offline webimap account + a group chat (self-only: composer, no peers)
  const accountId = await rpc('addAccount')
  await rpc('addTransportFromQr', accountId, QR)
  await rpc('setConfig', accountId, 'displayname', 'Alice Weber')
  const chatId = await rpc('createGroupChat', accountId, 'preview-test', false)
  for (const id of await rpc('getAllAccountIds')) {
    if (id !== accountId) await rpc('removeAccount', id)
  }
  await page.reload()
  await page.waitForFunction(() => window.__coreSystemInfo, null, { timeout: 120_000 })
  const accItem = page.getByTestId(`account-item-${accountId}`)
  await accItem.waitFor({ state: 'visible', timeout: 60_000 })
  await accItem.hover()
  await accItem.click()
  const chatItem = page.locator('.chat-list .chat-list-item').filter({ hasText: 'preview-test' }).first()
  await chatItem.waitFor({ state: 'visible', timeout: 30_000 })
  await chatItem.click()
  await composer().waitFor({ state: 'visible', timeout: 30_000 })
  console.log('OK: chat open')

  // the suggestion is gated by the `linkPreviewSuggestions` desktop setting,
  // an experimental feature that is OFF by default — confirm that, then opt
  // in for the rest of this test to exercise the feature.
  const dsBefore = await page.evaluate(() => window.exp.runtime.getDesktopSettings())
  if (dsBefore.linkPreviewSuggestions !== false)
    throw new Error(`linkPreviewSuggestions should default to false, got ${dsBefore.linkPreviewSuggestions}`)
  console.log('OK: link-preview suggestions setting defaults off')
  await page.evaluate(() =>
    window.exp.runtime.setDesktopSetting('linkPreviewSuggestions', true)
  )
  await page.reload()
  await page.waitForFunction(() => window.__coreSystemInfo, null, { timeout: 120_000 })
  await accItem.waitFor({ state: 'visible', timeout: 60_000 })
  await accItem.hover()
  await accItem.click()
  await chatItem.waitFor({ state: 'visible', timeout: 30_000 })
  await chatItem.click()
  await composer().waitFor({ state: 'visible', timeout: 30_000 })

  // -- ghost appears when a URL is typed --
  await composer().fill(`have a look at ${ogBase}/hero.html`)
  const ghost = page.getByTestId('link-preview-ghost')
  await ghost.waitFor({ state: 'visible', timeout: 10_000 })
  if (!(await ghost.textContent()).includes('og.localhost'))
    throw new Error('ghost does not show the link host')
  await shot('01-ghost')

  // -- Add → ready chip, draft gets a File attachment (attached as File so core
  //    ships the transparent PNG uncompressed; it promotes File→Image on send) --
  await page.getByTestId('link-preview-add').click()
  const ready = page.getByTestId('link-preview-ready')
  await ready.waitFor({ state: 'visible', timeout: 30_000 })
  // the chip shows a thumbnail of the actual baked card before sending
  const thumbSrc = await ready.locator('img').first().getAttribute('src')
  if (!thumbSrc?.startsWith('data:image/png'))
    throw new Error(`ready chip should show a PNG data-URL thumbnail, got ${thumbSrc?.slice(0, 32)}`)
  console.log('OK: baked card shown as a thumbnail in the chip')
  let draft = await rpc('getDraft', accountId, chatId)
  if (!draft?.file || draft.viewType !== 'File')
    throw new Error(`draft should carry a File attachment (uncompressed PNG), got ${JSON.stringify({ file: draft?.file, viewType: draft?.viewType })}`)
  if (!draft.file.endsWith('.png')) throw new Error(`expected a png draft file, got ${draft.file}`)
  console.log(`OK: card attached (${draft.fileBytes} bytes, ${draft.dimensionsWidth}x${draft.dimensionsHeight})`)
  if (draft.fileBytes > 0.6 * 1024 * 1024)
    throw new Error(`card PNG exceeds the 0.6 MB budget: ${draft.fileBytes}`)
  // hero page (twitter:card=summary_large_image, wide og:image) → hero layout,
  // so the chip offers to collapse
  await page.getByTestId('link-preview-toggle').and(page.locator('[aria-label="Collapse to compact"]')).waitFor({ timeout: 5_000 })
  await shot('02-ready-hero')

  // -- expand↔collapse re-attaches the other layout --
  const heroBytes = draft.fileBytes
  await page.getByTestId('link-preview-toggle').click()
  await page.getByTestId('link-preview-toggle').and(page.locator('[aria-label="Expand to hero"]')).waitFor({ timeout: 30_000 })
  draft = await rpc('getDraft', accountId, chatId)
  if (!draft?.file || draft.viewType !== 'File') throw new Error('draft lost its attachment after layout toggle')
  if (draft.fileBytes === heroBytes)
    console.log('note: compact card is byte-identical to hero (unexpected but not fatal)')
  console.log(`OK: toggled to compact (${draft.fileBytes} bytes, ${draft.dimensionsWidth}x${draft.dimensionsHeight})`)
  await shot('03-ready-compact')
  // ...and back to hero, so the riskier layout is the one that gets sent
  await page.getByTestId('link-preview-toggle').click()
  await page
    .getByTestId('link-preview-toggle')
    .and(page.locator('[aria-label="Collapse to compact"]'))
    .waitFor({ timeout: 30_000 })

  // -- send: outgoing message renders the baked card --
  await page.locator('button.send-button').click()
  const sentImg = page.locator('.message.outgoing img').first()
  await sentImg.waitFor({ state: 'visible', timeout: 30_000 })
  await page.waitForTimeout(500)
  await sentImg.screenshot({ path: `${OUT}card-hero-light.png` })
  const msgIds = await rpc('getMessageIds', accountId, chatId, false, false)
  const sent = await rpc('getMessage', accountId, msgIds[msgIds.length - 1])
  if (sent.viewType !== 'Image' || !sent.text.includes('/hero.html'))
    throw new Error(`sent message should be Image + link text, got ${sent.viewType}: ${sent.text}`)
  // Attached as File, so core promoted it to Image WITHOUT recoding: the PNG
  // (with its transparent rounded-corner/shadow margin) survives. A JPEG recode
  // would drop alpha and blacken those edges — assert we stayed image/png.
  if (sent.fileMime !== 'image/png')
    throw new Error(`sent card must stay a PNG (no JPEG recode → no black edges), got ${sent.fileMime}`)
  console.log('OK: sent — message is text + uncompressed PNG card (image/png)')
  await shot('04-sent-light')

  // -- second URL: compact page → compact layout; then remove clears the draft --
  await composer().fill(`compact one ${ogBase}/compact.html`)
  await page.getByTestId('link-preview-ghost').waitFor({ state: 'visible', timeout: 10_000 })
  await page.getByTestId('link-preview-add').click()
  await page.getByTestId('link-preview-ready').waitFor({ state: 'visible', timeout: 30_000 })
  await page.getByTestId('link-preview-toggle').and(page.locator('[aria-label="Expand to hero"]')).waitFor({ timeout: 5_000 })
  draft = await rpc('getDraft', accountId, chatId)
  if (!draft?.file) throw new Error('compact-page draft has no attachment')
  await page.getByTestId('link-preview-remove').click()
  await page.getByTestId('link-preview-ready').waitFor({ state: 'hidden', timeout: 5_000 })
  // upstream's removeFile persists via a 15s-debounced draft save, so the core
  // draft lags; the UI must drop the attachment immediately though (the plain
  // attachment section reappearing here would mean the file was left behind)
  if (await page.locator('.attachment-quote-section.is-attachment').isVisible())
    throw new Error('remove left the attachment in the composer')
  console.log('OK: compact layout + remove clears the attachment')

  // -- dismiss hides the ghost without generating --
  const dismissedUrl = `${ogBase}/hero.html?again=1`
  await composer().fill(`and this ${dismissedUrl}`)
  await page.getByTestId('link-preview-ghost').waitFor({ state: 'visible', timeout: 10_000 })
  await page.getByTestId('link-preview-dismiss').click()
  await page.getByTestId('link-preview-ghost').waitFor({ state: 'hidden', timeout: 5_000 })
  if (await page.locator('.attachment-quote-section.is-attachment').isVisible())
    throw new Error('dismiss must not attach anything')
  // while the same URL stays in the composer, the ghost stays dismissed
  await page.waitForTimeout(700) // past the detect debounce
  if (await page.getByTestId('link-preview-ghost').isVisible())
    throw new Error('ghost reappeared for a still-present dismissed URL')
  console.log('OK: dismiss hides the ghost (and stays hidden for that URL)')

  // -- clearing the composer (as sending does) forgets the dismissal, so the
  //    SAME link in a new message offers the ghost again (not a permanent mute)
  await composer().fill('')
  await page.waitForTimeout(700)
  await composer().fill(`new message ${dismissedUrl}`)
  await page.getByTestId('link-preview-ghost').waitFor({ state: 'visible', timeout: 10_000 })
  console.log('OK: dismissal is per-message — same URL re-offers after clearing')
  await page.getByTestId('link-preview-dismiss').click()
  await composer().fill('')

  // -- replacing the URL while a preview is attached re-offers a ghost for the
  //    new URL (regression: the old effect keyed only on the URL and left no
  //    ghost after the swap) --
  await composer().fill(`first ${ogBase}/hero.html`)
  await page.getByTestId('link-preview-add').click()
  await page.getByTestId('link-preview-ready').waitFor({ state: 'visible', timeout: 30_000 })
  await composer().fill(`changed to ${ogBase}/compact.html`)
  // the attached preview for the old URL is dropped, and a fresh idle ghost
  // appears for the new URL
  await page.getByTestId('link-preview-ready').waitFor({ state: 'hidden', timeout: 10_000 })
  await page.getByTestId('link-preview-ghost').waitFor({ state: 'visible', timeout: 10_000 })
  if (await page.locator('.attachment-quote-section.is-attachment').isVisible())
    throw new Error('the stale preview attachment was left behind after the URL changed')
  console.log('OK: replacing the URL re-offers a ghost, drops the stale preview')
  await page.getByTestId('link-preview-dismiss').click()
  await composer().fill('')

  // -- a CORS-blocked page previews fine too: everything goes through the
  //    bridge's unfurl endpoint (there is no direct-fetch tier anymore) --
  await composer().fill(`no cors here ${ogBase}/nocors-hero.html`)
  await page.getByTestId('link-preview-ghost').waitFor({ state: 'visible', timeout: 10_000 })
  await page.getByTestId('link-preview-add').click()
  const unfurlReady = page.getByTestId('link-preview-ready')
  await unfurlReady.waitFor({ state: 'visible', timeout: 60_000 })
  // the ready chip is now just the baked-card image (title/host are in the PNG)
  const unfurlThumb = await unfurlReady.locator('img').first().getAttribute('src')
  if (!unfurlThumb?.startsWith('data:image/png'))
    throw new Error('unfurl-path ready chip is missing its card preview')
  await shot('06b-unfurl-ready-chip')
  draft = await rpc('getDraft', accountId, chatId)
  if (!draft?.file || draft.viewType !== 'File')
    throw new Error('unfurl-fetched preview did not attach a card')
  await page.locator('button.send-button').click()
  await page.locator('.message.outgoing img').nth(1).waitFor({ state: 'visible', timeout: 30_000 })
  console.log('OK: CORS-blocked page previewed via the unfurl endpoint')
  await shot('06-sent-unfurl')

  // -- no unfurl endpoint reachable → a quiet "needs a bridge" hint, not
  //    silence. Reload pointed at a dead bridge port so the derived unfurl URL
  //    refuses. (The webimap account uses direct HTTP, so mail still works.)
  const deadPort = 8688 // nothing listens here → unfurl fetch refuses
  await page.goto(
    `http://localhost:${APP_PORT}/main.html?proxy=ws://localhost:${deadPort}`
  )
  await page.waitForFunction(() => window.__coreSystemInfo, null, { timeout: 120_000 })
  const acctItem = page.getByTestId(`account-item-${accountId}`)
  await acctItem.waitFor({ state: 'visible', timeout: 60_000 })
  await acctItem.click()
  const chat2 = page.locator('.chat-list .chat-list-item').filter({ hasText: 'preview-test' }).first()
  await chat2.waitFor({ state: 'visible', timeout: 30_000 })
  await chat2.click()
  await composer().waitFor({ state: 'visible', timeout: 30_000 })
  await composer().fill(`no bridge ${ogBase}/hero.html`)
  await page.getByTestId('link-preview-add').click()
  await page.getByTestId('link-preview-unavailable').waitFor({ state: 'visible', timeout: 30_000 })
  if (await page.locator('.attachment-quote-section.is-attachment').isVisible())
    throw new Error('unreachable unfurl must not attach anything')
  console.log('OK: unreachable unfurl shows the "needs a bridge" hint')

  // -- the baked card on dark + custom themes (sent message re-rendered) --
  for (const theme of ['dc:dark', 'dc:rocket']) {
    await page.evaluate((t) => {
      const KEY = 'slothfulchat.desktopSettings'
      const s = JSON.parse(localStorage.getItem(KEY) || '{}')
      s.activeTheme = t
      localStorage.setItem(KEY, JSON.stringify(s))
    }, theme)
    await page.reload()
    await page.waitForFunction(() => window.__coreSystemInfo, null, { timeout: 120_000 })
    const item = page.locator('.chat-list .chat-list-item').filter({ hasText: 'preview-test' }).first()
    await item.waitFor({ state: 'visible', timeout: 60_000 })
    await item.click()
    const img = page.locator('.message.outgoing img').first()
    await img.waitFor({ state: 'visible', timeout: 30_000 })
    await page.waitForTimeout(500)
    const slug = theme.replace(':', '-')
    await img.screenshot({ path: `${OUT}card-${slug}.png` })
    await shot(`05-sent-${slug}`)
  }

  console.log('OK: link-preview e2e passed')
} catch (err) {
  failed = true
  console.error('FAIL:', err.message)
  await page.screenshot({ path: `${OUT}error.png` }).catch(() => {})
} finally {
  clearTimeout(watchdog)
  await browser.close()
  cleanup()
}
process.exit(failed ? 1 : 0)
