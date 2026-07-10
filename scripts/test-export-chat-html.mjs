// End-to-end test for the "Export Chat" (zip) feature — runs FULLY OFFLINE.
//
// An in-process mock madmail server (borrowed from scripts/test-webimap.mjs)
// provides two webimap accounts; a conversation is seeded via the rpc escape
// hatch (texts with emoji/newlines/link, an image attachment, a quote-reply,
// a reaction, an avatar). Then the actual UI flow is exercised: open the
// chat, three-dot menu -> "Export Chat", catch the zip download, unpack it
// (index.html viewer + messages.txt + messages.json + manifest.toml +
// media/), open the extracted index.html standalone (file://) and assert the
// rendered structure — message bubbles/day marker/quote/link present, media
// referenced from media/, app css embedded. Finally the viewer's
// "Save single-file HTML" button is clicked and the emitted static snapshot
// is checked (no scripts left, same messages). Screenshots of the live chat
// and the export land in .cache/export-chat-html/ for visual comparison.
//
// Requires packages/core-wasm built and packages/web-app assembled+built.
// Run:  node scripts/test-export-chat-html.mjs
// (CHROMIUM_BIN=/path/to/chrome overrides the playwright-managed browser.)
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { randomBytes } from 'node:crypto'
import { deflateSync } from 'node:zlib'
import { chromium } from 'playwright'

const script = (p) => fileURLToPath(new URL(p, import.meta.url))
const OUT = script('../.cache/export-chat-html/')
await mkdir(OUT, { recursive: true })
const APP_PORT = 8672

// --- tiny png (from theme-shots.mjs) so avatars/images are real; the seed
// varies the colors, otherwise the core dedupes identical blobs by hash ---
function tinyPngBase64(seed = 0) {
  const w = 48
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
  ihdr.writeUInt32BE(w, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  const raw = Buffer.alloc(w * (w * 3 + 1))
  for (let y = 0; y < w; y++)
    for (let x = 0; x < w; x++) {
      const i = y * (w * 3 + 1) + 1 + x * 3
      const on = (x < w / 2) !== (y < w / 2)
      raw[i] = on ? (0x1d + seed * 90) & 0xff : 0xff
      raw[i + 1] = on ? 0x74 : (0xd0 - seed * 70) & 0xff
      raw[i + 2] = on ? 0xf5 : 0x2a
    }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]).toString('base64')
}

// --- mock madmail server (simplified from scripts/test-webimap.mjs) ---
const users = new Map()
let userSeq = 0
const readBody = (req) =>
  new Promise((resolve) => {
    let b = ''
    req.on('data', (c) => (b += c))
    req.on('end', () => resolve(b))
  })
const json = (res, code, obj) => {
  res.statusCode = code
  res.setHeader('content-type', 'application/json')
  res.end(JSON.stringify(obj))
}
const meta = (uid, raw) => ({
  uid,
  seq_num: uid,
  flags: [],
  size: Buffer.byteLength(raw),
  date: new Date().toISOString(),
  envelope: {},
})
const respondMessages = (res, user, sinceUid) => {
  const out = []
  for (const [uid, raw] of user.msgs) if (uid > sinceUid) out.push(meta(uid, raw))
  json(res, 200, out)
}
const mock = createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Headers', 'X-Email, X-Password, Content-Type')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS')
  if (req.method === 'OPTIONS') {
    res.statusCode = 204
    res.end()
    return
  }
  const url = new URL(req.url, 'http://mock')
  const path = url.pathname
  if (req.method === 'POST' && path === '/new') {
    const email = `u${++userSeq}@webimap.example`
    const password = randomBytes(9).toString('hex')
    users.set(email, { password, nextUid: 1, msgs: new Map(), waiters: [] })
    json(res, 200, { email, password, dclogin_url: '' })
    return
  }
  if (path.startsWith('/webimap/')) {
    const email = req.headers['x-email']
    const password = req.headers['x-password']
    const user = email && users.get(email)
    if (!user || user.password !== password) {
      json(res, 401, { error: 'bad credentials' })
      return
    }
    if (req.method === 'GET' && path === '/webimap/mailboxes') {
      const n = user.msgs.size
      json(res, 200, [{ name: 'INBOX', messages: n, unseen: n }])
      return
    }
    if (req.method === 'GET' && path === '/webimap/messages') {
      const sinceUid = Number(url.searchParams.get('since_uid') ?? '0') || 0
      const wait = Math.min(Number(url.searchParams.get('wait') ?? '0') || 0, 120)
      const hasNew = [...user.msgs.keys()].some((uid) => uid > sinceUid)
      if (hasNew || wait <= 0) {
        respondMessages(res, user, sinceUid)
        return
      }
      const waiter = {
        timer: setTimeout(() => {
          user.waiters = user.waiters.filter((w) => w !== waiter)
          respondMessages(res, user, sinceUid)
        }, wait * 1000),
        respond: () => respondMessages(res, user, sinceUid),
      }
      user.waiters.push(waiter)
      return
    }
    const m = path.match(/^\/webimap\/message\/(\d+)$/)
    if (m) {
      const uid = Number(m[1])
      if (req.method === 'GET') {
        const raw = user.msgs.get(uid)
        if (raw === undefined) return json(res, 404, { error: 'no such message' })
        return json(res, 200, { ...meta(uid, raw), body: raw })
      }
      if (req.method === 'DELETE') {
        user.msgs.delete(uid)
        return json(res, 200, { status: 'ok' })
      }
    }
    if (req.method === 'POST' && path === '/webimap/send') {
      let payload = {}
      try {
        payload = JSON.parse(await readBody(req))
      } catch {}
      const recipients = []
        .concat(payload.to ?? [])
        .flatMap((r) => (typeof r === 'string' ? r.split(/[,\s]+/) : []))
        .map((r) => r.trim())
        .filter(Boolean)
      const body = payload.body ?? ''
      for (const rcpt of recipients) {
        const dest = users.get(rcpt)
        if (!dest) continue
        const uid = dest.nextUid++
        dest.msgs.set(uid, body)
        const waiters = dest.waiters
        dest.waiters = []
        for (const w of waiters) {
          clearTimeout(w.timer)
          w.respond()
        }
      }
      return json(res, 200, { status: 'sent' })
    }
  }
  json(res, 404, { error: 'not found' })
})
await new Promise((r) => mock.listen(0, '127.0.0.1', r))
const mockPort = mock.address().port
console.log(`mock madmail on 127.0.0.1:${mockPort}`)
const QR = `webimapaccount:127.0.0.1:${mockPort}`

// --- web-app server ---
const appServer = spawn('node', [script('../packages/web-app/serve.mjs')], {
  env: { ...process.env, PORT: String(APP_PORT) },
  stdio: 'inherit',
})
const cleanup = () => appServer.kill()
process.on('exit', cleanup)
const watchdog = setTimeout(() => {
  console.error('FAIL: watchdog (6 min)')
  cleanup()
  process.exit(1)
}, 360_000)
await new Promise((r) => setTimeout(r, 700))

// --- browser ---
// CHROMIUM_BIN overrides the browser binary (e.g. a preinstalled system
// chromium when the playwright-managed download is unavailable)
const launchOpts = process.env.CHROMIUM_BIN
  ? { executablePath: process.env.CHROMIUM_BIN }
  : {}
const browser = await chromium.launch(launchOpts)
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
const consoleTail = []
page.on('console', (m) => {
  const t = m.text()
  consoleTail.push(t.slice(0, 400))
  if (/panicked at/.test(t)) console.error('[page PANIC]', t)
})
page.on('pageerror', (e) => console.error('[pageerror]', e.message))
await page.addInitScript(() => {
  Object.defineProperty(window, 'eval', { value: window.eval, writable: false })
})
const rpc = (method, ...args) =>
  page.evaluate(([m, a]) => window.exp.rpc[m](...a), [method, args])

let failed = false
try {
  await page.goto(`http://localhost:${APP_PORT}/main.html`)
  await page.waitForFunction(() => window.__coreSystemInfo, null, { timeout: 120_000 })
  console.log('OK: wasm core booted')

  // --- seed two webimap accounts + a conversation, all via rpc ---
  const setup = async (name) => {
    const id = await rpc('addAccount')
    await rpc('addTransportFromQr', id, QR)
    await rpc('setConfig', id, 'displayname', name)
    await rpc('startIo', id)
    return id
  }
  const aliceId = await setup('Alice Weber')
  const bobId = await setup('Bob Martinez')
  const avatarPath = await page.evaluate(
    (b64) => window.exp.runtime.writeTempFileFromBase64('bob-avatar.png', b64),
    tinyPngBase64()
  )
  await rpc('setConfig', bobId, 'selfavatar', avatarPath)
  console.log(`OK: accounts alice=${aliceId} bob=${bobId}`)

  const bobVcard = await rpc('makeVcard', bobId, [1])
  const [bobContact] = await rpc('importVcardContents', aliceId, bobVcard)
  const aliceVcard = await rpc('makeVcard', aliceId, [1])
  await rpc('importVcardContents', bobId, aliceVcard)
  const dm = await rpc('createChatByContactId', aliceId, bobContact)

  // poll for a message containing `marker` to land on account `accId`
  const waitIncoming = async (accId, marker) => {
    const deadline = Date.now() + 120_000
    while (Date.now() < deadline) {
      const chatIds = await rpc('getChatlistEntries', accId, 0, null, null)
      for (const chatId of chatIds) {
        const ids = await rpc('getMessageIds', accId, chatId, false, false)
        for (const id of ids.slice(-8)) {
          const msg = await rpc('getMessage', accId, id).catch(() => null)
          if (msg?.text?.includes(marker)) return { chatId, msgId: id }
        }
      }
      await new Promise((r) => setTimeout(r, 600))
    }
    throw new Error(`timeout waiting for "${marker}" on account ${accId}`)
  }

  // alice -> bob: a few texts (multiline, emoji, link)
  await rpc('miscSendTextMessage', aliceId, dm, 'Hey Bob! Did you see the new design draft? 🎨')
  const { chatId: bobChatId } = await waitIncoming(bobId, 'design draft')
  console.log('OK: alice -> bob delivered')

  // bob replies (incoming for alice; his chat is a contact request until accepted)
  await rpc('acceptChat', bobId, bobChatId)
  await rpc('miscSendTextMessage', bobId, bobChatId, 'Yes — looks great! 👍\nTwo notes:\n- spacing\n- contrast\nSee https://example.com/spec')
  const { msgId: aliceIncomingId } = await waitIncoming(aliceId, 'looks great')
  console.log('OK: bob -> alice delivered')

  // alice sends an image attachment
  const imgPath = await page.evaluate(
    (b64) => window.exp.runtime.writeTempFileFromBase64('mockup.png', b64),
    tinyPngBase64(1)
  )
  await rpc('sendMsg', aliceId, dm, {
    text: 'mockup attached',
    file: imgPath,
    filename: 'mockup.png',
    viewtype: 'Image',
  })
  await waitIncoming(bobId, 'mockup attached')
  console.log('OK: image message delivered')

  // alice replies with a quote of bob's message
  await rpc('sendMsg', aliceId, dm, {
    text: 'Agreed on the contrast point!',
    quotedMessageId: aliceIncomingId,
    viewtype: 'Text',
  })

  // alice reacts to bob's message
  await rpc('sendReaction', aliceId, aliceIncomingId, ['👍'])
  await new Promise((r) => setTimeout(r, 1500))

  // --- drive the UI: select alice, open the chat, export ---
  // drop the unconfigured account the app auto-created at first boot, so the
  // reloaded app lands on a real account instead of the welcome screen
  for (const id of await rpc('getAllAccountIds')) {
    if (id !== aliceId && id !== bobId) await rpc('removeAccount', id)
  }
  await page.reload()
  await page.waitForFunction(() => window.__coreSystemInfo, null, { timeout: 120_000 })
  const accItem = page.getByTestId(`account-item-${aliceId}`)
  await accItem.waitFor({ state: 'visible', timeout: 60_000 })
  await accItem.hover()
  await accItem.click()
  await page.getByTestId(`selected-account:${aliceId}`).waitFor({ state: 'attached', timeout: 30_000 })
  await page.mouse.move(600, 400)

  const chatItem = page.locator('.chat-list .chat-list-item').filter({ hasText: 'Bob' }).first()
  await chatItem.waitFor({ state: 'visible', timeout: 30_000 })
  await chatItem.click()
  await page.locator('.message.outgoing').first().waitFor({ state: 'visible', timeout: 30_000 })
  await page.screenshot({ path: OUT + 'app-chat.png', fullPage: false })
  console.log('OK: chat open in UI, screenshot taken')

  // three-dot menu -> Export Chat
  await page.locator('#three-dot-menu-button').click()
  const item = page.getByText('Export Chat', { exact: true })
  await item.waitFor({ state: 'visible', timeout: 10_000 })
  const downloadP = page.waitForEvent('download', { timeout: 60_000 })
  await item.click()
  const download = await downloadP
  const exportPath = OUT + download.suggestedFilename()
  await download.saveAs(exportPath)
  console.log(`OK: downloaded ${download.suggestedFilename()}`)

  // --- unpack the zip and inspect its contents ---
  if (!exportPath.endsWith('.zip')) throw new Error(`expected a .zip download, got ${exportPath}`)
  const { createRequire } = await import('node:module')
  const fflate = createRequire(script('../packages/web-app/package.json'))('fflate')
  const zip = fflate.unzipSync(new Uint8Array(await readFile(exportPath)))
  const entryNames = Object.keys(zip)
  console.log('zip entries:', entryNames.join(', '))
  for (const required of ['index.html', 'messages.txt', 'messages.json', 'manifest.toml']) {
    if (!entryNames.includes(required)) throw new Error(`zip is missing ${required}`)
  }
  const mediaEntries = entryNames.filter((n) => n.startsWith('media/'))
  if (mediaEntries.length < 2) throw new Error(`expected >=2 media files, got ${mediaEntries.join(', ')}`)

  const txt = Buffer.from(zip['messages.txt']).toString('utf8')
  if (!txt.includes('design draft') || !txt.includes('Bob Martinez'))
    throw new Error('messages.txt is missing expected content')
  const jsonData = JSON.parse(Buffer.from(zip['messages.json']).toString('utf8'))
  const jsonMsgCount = Object.keys(jsonData.messages).length
  if (jsonMsgCount < 5) throw new Error(`messages.json has only ${jsonMsgCount} messages`)
  if (!Buffer.from(zip['manifest.toml']).toString('utf8').includes('name = '))
    throw new Error('manifest.toml has no name')
  console.log(`OK: zip contents — txt/json/manifest/${mediaEntries.length} media files`)

  const extracted = OUT + 'extracted/'
  await mkdir(extracted + 'media', { recursive: true })
  for (const [name, bytes] of Object.entries(zip)) {
    if (name.endsWith('/')) continue
    await writeFile(extracted + name, Buffer.from(bytes))
  }

  // --- open the extracted viewer standalone (file://) and inspect the DOM ---
  const exportPage = await browser.newPage({ viewport: { width: 1280, height: 900 } })
  await exportPage.goto(pathToFileURL(extracted + 'index.html').href)
  await exportPage.locator('.message').first().waitFor({ state: 'visible', timeout: 15_000 })
  const stats = await exportPage.evaluate(() => ({
    messages: document.querySelectorAll('.message').length,
    incoming: document.querySelectorAll('.message.incoming').length,
    outgoing: document.querySelectorAll('.message.outgoing').length,
    daymarkers: document.querySelectorAll('.daymarker').length,
    mediaImgs: [...document.querySelectorAll('img')].filter((i) => i.getAttribute('src')?.startsWith('media/')).length,
    brokenImgs: [...document.querySelectorAll('img')].filter((i) => !i.complete || i.naturalWidth === 0).length,
    quotes: document.querySelectorAll('.quote').length,
    links: document.querySelectorAll('.text a').length,
    title: document.title,
    hasAppCss: !!document.head.textContent.includes('--messageIncomingBg'),
    bodyBg: getComputedStyle(document.querySelector('.message-list-and-composer')).backgroundColor,
    incomingBubbleBg: getComputedStyle(document.querySelector('.message.incoming .msg-container')).backgroundColor,
  }))
  console.log('viewer stats:', JSON.stringify(stats, null, 2))
  await exportPage.screenshot({ path: OUT + 'export-page.png', fullPage: false })

  const problems = []
  if (stats.messages < 4) problems.push(`expected >=4 messages, got ${stats.messages}`)
  if (stats.incoming < 1) problems.push('no incoming message')
  if (stats.outgoing < 3) problems.push('missing outgoing messages')
  if (stats.mediaImgs < 2) problems.push(`expected >=2 media/ images, got ${stats.mediaImgs}`)
  if (stats.brokenImgs > 0) problems.push(`${stats.brokenImgs} broken images`)
  if (stats.quotes < 1) problems.push('quote missing')
  if (stats.links < 1) problems.push('link not rendered as <a>')
  if (!stats.hasAppCss) problems.push('app css missing')
  if (stats.daymarkers < 1) problems.push('day marker missing')
  if (problems.length) throw new Error('export verification problems:\n  ' + problems.join('\n  '))

  // --- "Save single-file HTML" button emits a script-free static snapshot ---
  const staticDownloadP = exportPage.waitForEvent('download', { timeout: 30_000 })
  await exportPage.locator('#save-static-button').click()
  const staticDownload = await staticDownloadP
  const staticPath = extracted + staticDownload.suggestedFilename()
  await staticDownload.saveAs(staticPath)
  const staticPage = await browser.newPage({ viewport: { width: 1280, height: 900 } })
  await staticPage.goto(pathToFileURL(staticPath).href)
  const staticStats = await staticPage.evaluate(() => ({
    messages: document.querySelectorAll('.message').length,
    scripts: document.querySelectorAll('script').length,
    saveButtons: document.querySelectorAll('#save-static-button').length,
    brokenImgs: [...document.querySelectorAll('img')].filter((i) => !i.complete || i.naturalWidth === 0).length,
  }))
  console.log('static snapshot stats:', JSON.stringify(staticStats))
  if (staticStats.messages !== stats.messages) throw new Error('static snapshot lost messages')
  if (staticStats.scripts !== 0 || staticStats.saveButtons !== 0)
    throw new Error('static snapshot still contains scripts or the save button')
  if (staticStats.brokenImgs > 0) throw new Error(`${staticStats.brokenImgs} broken images in static snapshot`)
  await staticPage.screenshot({ path: OUT + 'static-snapshot.png', fullPage: false })
  console.log('OK: export verified — zip contents, viewer rendering, static snapshot all good')
} catch (err) {
  await page.screenshot({ path: OUT + 'fail.png' }).catch(() => {})
  console.error('FAIL:', err.message ?? JSON.stringify(err))
  if (err.stack) console.error(err.stack.split('\n').slice(0, 4).join('\n'))
  console.error('--- last page console ---')
  console.error(consoleTail.slice(-40).join('\n'))
  failed = true
} finally {
  clearTimeout(watchdog)
  await browser.close()
  mock.close()
  cleanup()
}
process.exit(failed ? 1 : 0)
