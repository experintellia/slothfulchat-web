// Screenshot harness for the voice-message player work (issue #120) — runs
// FULLY OFFLINE like scripts/test-export-chat-html.mjs: an in-process mock
// madmail server provides two webimap accounts, a 1:1 chat is seeded with
// voice messages in both directions via the rpc escape hatch, the
// experimental custom player is switched on, and screenshots land in
// .cache/voice-shots/.
//
// Requires packages/core-wasm built and packages/web-app assembled+built.
// Run:  node scripts/shot-voice-player.mjs
// (CHROMIUM_BIN=/path/to/chrome overrides the playwright-managed browser.)
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'
import { chromium } from 'playwright'

const script = (p) => fileURLToPath(new URL(p, import.meta.url))
const SHOTS = script('../.cache/voice-shots/')
await mkdir(SHOTS, { recursive: true })
const APP_PORT = 8674

// ~7s "spoken-word-ish" mp3 (tone bursts with pauses), encoded with the same
// lamejs the app's recorder uses — no fixture file needed. `seed` varies the
// melody so the two messages aren't byte-identical (core dedupes blobs).
async function voiceMp3Base64(seed = 0) {
  // require.resolve lands on the iife build (empty exports under node); the
  // ESM build sits next to it
  const lame = await import(
    createRequire(script('../build/desktop/packages/frontend/package.json'))
      .resolve('@breezystack/lamejs')
      .replace(/lamejs\.iife\.js$/, 'lamejs.js')
  )
  const Mp3Encoder = lame.Mp3Encoder ?? lame.default?.Mp3Encoder
  const sr = 44100
  const n = sr * 7
  const samples = new Int16Array(n)
  for (let i = 0; i < n; i++) {
    const t = i / sr
    const env =
      Math.max(0, Math.sin(2 * Math.PI * (2.3 + seed) * t)) *
      (t % 1.7 < 1.2 ? 1 : 0)
    const f = 180 + 40 * seed + 60 * Math.sin(2 * Math.PI * 0.9 * t)
    samples[i] = 12000 * env * Math.sin(2 * Math.PI * f * t)
  }
  const enc = new Mp3Encoder(1, sr, 64)
  const chunks = []
  for (let i = 0; i < n; i += 1152) {
    const b = enc.encodeBuffer(samples.subarray(i, i + 1152))
    if (b.length) chunks.push(Buffer.from(b))
  }
  const fin = enc.flush()
  if (fin.length) chunks.push(Buffer.from(fin))
  return Buffer.concat(chunks).toString('base64')
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
const launchOpts = process.env.CHROMIUM_BIN
  ? { executablePath: process.env.CHROMIUM_BIN }
  : {}
launchOpts.args = ['--autoplay-policy=no-user-gesture-required']
const browser = await chromium.launch(launchOpts)
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
page.on('console', (m) => {
  if (/panicked at/.test(m.text())) console.error('[page PANIC]', m.text())
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
  await page.waitForFunction(() => window.__coreSystemInfo, null, {
    timeout: 120_000,
  })
  console.log('OK: wasm core booted')

  // --- seed two webimap accounts + a voice conversation, all via rpc ---
  const setup = async (name) => {
    const id = await rpc('addAccount')
    await rpc('addTransportFromQr', id, QR)
    await rpc('setConfig', id, 'displayname', name)
    await rpc('startIo', id)
    return id
  }
  const aliceId = await setup('Alice Weber')
  const bobId = await setup('Bob Martinez')
  console.log(`OK: accounts alice=${aliceId} bob=${bobId}`)

  const bobVcard = await rpc('makeVcard', bobId, [1])
  const [bobContact] = await rpc('importVcardContents', aliceId, bobVcard)
  const aliceVcard = await rpc('makeVcard', aliceId, [1])
  await rpc('importVcardContents', bobId, aliceVcard)
  const dm = await rpc('createChatByContactId', aliceId, bobContact)

  // poll for a message matching `pred` to land on account `accId`
  const waitIncoming = async (accId, pred, label) => {
    const deadline = Date.now() + 120_000
    while (Date.now() < deadline) {
      const chatIds = await rpc('getChatlistEntries', accId, 0, null, null)
      for (const chatId of chatIds) {
        const ids = await rpc('getMessageIds', accId, chatId, false, false)
        for (const id of ids.slice(-8)) {
          const msg = await rpc('getMessage', accId, id).catch(() => null)
          if (msg && pred(msg)) return { chatId, msgId: id }
        }
      }
      await new Promise((r) => setTimeout(r, 600))
    }
    throw new Error(`timeout waiting for ${label} on account ${accId}`)
  }

  const sendVoice = async (accId, chatId, name, seed) => {
    const b64 = await voiceMp3Base64(seed)
    const path = await page.evaluate(
      ([n, b]) => window.exp.runtime.writeTempFileFromBase64(n, b),
      [name, b64]
    )
    await rpc('sendMsg', accId, chatId, {
      file: path,
      filename: name,
      viewtype: 'Voice',
    })
  }

  await rpc(
    'miscSendTextMessage',
    aliceId,
    dm,
    'Sending you the voice note about the release 👇'
  )
  await sendVoice(aliceId, dm, 'alice-note.mp3', 0)
  const { chatId: bobChatId } = await waitIncoming(
    bobId,
    (m) => m.viewType === 'Voice',
    'voice from alice'
  )
  console.log('OK: alice -> bob voice delivered')
  await rpc('acceptChat', bobId, bobChatId)
  await sendVoice(bobId, bobChatId, 'bob-reply.mp3', 1)
  await waitIncoming(
    aliceId,
    (m) => m.viewType === 'Voice' && !m.isInfo && m.fromId !== 1,
    'voice from bob'
  )
  console.log('OK: bob -> alice voice delivered')

  // --- turn on the experimental custom player, reload so it applies ---
  await page.evaluate(() => {
    const KEY = 'slothfulchat.desktopSettings'
    const s = JSON.parse(localStorage.getItem(KEY) || '{}')
    s.experimentalAudioPlayerControls = true
    localStorage.setItem(KEY, JSON.stringify(s))
  })
  await page.reload()
  await page
    .locator('#new-chat-button')
    .waitFor({ state: 'visible', timeout: 120_000 })

  // make sure alice's profile is selected
  const aliceItem = page.getByTestId(`account-item-${aliceId}`)
  if (!(await page.getByTestId(`selected-account:${aliceId}`).count())) {
    await aliceItem.hover()
    await aliceItem.click()
    await page
      .getByTestId(`selected-account:${aliceId}`)
      .waitFor({ state: 'attached', timeout: 30_000 })
  }
  await page.mouse.move(640, 450)

  const shot = async (name) => {
    await page.waitForTimeout(400)
    const path = `${SHOTS}/${name}.png`
    await page.screenshot({ path })
    console.log(`shot: ${path}`)
  }

  // open the DM with the voice messages
  await page
    .locator('.chat-list .chat-list-item')
    .filter({ hasText: 'Bob' })
    .first()
    .click()
  const incomingPlayer = page
    .locator('.message.incoming .message-attachment-audio')
    .first()
  await incomingPlayer.waitFor({ state: 'visible', timeout: 30_000 })
  await shot('01-custom-player-paused')

  // play the incoming voice message; progress + global bottom bar appear
  await incomingPlayer.getByRole('button', { name: 'Play', exact: true }).click()
  await page.waitForTimeout(2500)
  await shot('02-custom-player-playing')

  // speed pill: 1x -> 1.5x -> 2x
  const pill = incomingPlayer.getByRole('button', { name: /Playback speed/ })
  await pill.click()
  await pill.click()
  await page.waitForTimeout(300)
  await shot('03-custom-player-2x')

  await incomingPlayer.getByRole('button', { name: 'Pause', exact: true }).click()

  // the experimental setting switch
  try {
    await page.getByTestId('open-settings-button').click()
    await page.getByText('Advanced', { exact: true }).click()
    await page.waitForTimeout(500)
    await shot('04-settings-experimental')
  } catch (err) {
    console.warn('settings shot skipped:', err.message)
  }
  console.log('DONE')
} catch (err) {
  failed = true
  console.error('FAIL:', err.message)
  await page.screenshot({ path: `${SHOTS}/error.png` }).catch(() => {})
} finally {
  clearTimeout(watchdog)
  await browser.close().catch(() => {})
  cleanup()
}
process.exit(failed ? 1 : 0)
