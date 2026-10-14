// Marketing screenshots — runs FULLY OFFLINE against the in-process mock
// madmail server. The viewer (Mia) lives in her own browser context so the
// account sidebar shows one profile; her friends run in a second context and
// only exist to send her messages.
//
// Shots go to .cache/marketing-shots/:
//   desktop-{light,dark}.png  1440x900 @2x  (2880x1800)
//   phone-{light,dark}.png    390x844  @3x  (1170x2532)
//
// Requires packages/core-wasm built and packages/web-app assembled+built.
// Run:  node scripts/shot-marketing.mjs
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { startServers } from './harness.mjs'
import { startMockMadmail } from './mock-madmail.mjs'

const SHOTS = fileURLToPath(new URL('../.cache/marketing-shots/', import.meta.url))
await mkdir(SHOTS, { recursive: true })
const APP_PORT = 8679
const PROXY_PORT = 8680
// a reachable bridge, or the app shows a "Bridge not reachable" toast
const APP = `http://localhost:${APP_PORT}/main.html?proxy=ws://localhost:${PROXY_PORT}`
const GROUP = 'Weekend Crew'

const mock = await startMockMadmail()
const QR = `webimapaccount:127.0.0.1:${mock.port}`
const { cleanup, watchdog } = await startServers({ app: APP_PORT, proxy: PROXY_PORT, settleMs: 700, watchdogMs: 600_000 })
const exe = process.env.CHROMIUM_BIN ? { executablePath: process.env.CHROMIUM_BIN } : {}
const browser = await chromium.launch(exe)
// Mia gets an on-disk profile: device scale and touch are fixed per context,
// so the phone shots relaunch the same profile (same OPFS data) as a phone
const MIA_PROFILE = await mkdtemp(`${tmpdir()}/marketing-mia-`)
const DESKTOP = { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 }
const PHONE = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true }

async function openApp(contextOpts, profile) {
  const context = profile
    ? await chromium.launchPersistentContext(profile, { ...exe, ...contextOpts })
    : await browser.newContext(contextOpts)
  const page = context.pages()[0] ?? (await context.newPage())
  page.on('pageerror', e => console.error('[pageerror]', e.message))
  // The app replaces window.eval with a thrower; page.evaluate needs the real one.
  await page.addInitScript(() => {
    Object.defineProperty(window, 'eval', { value: window.eval, writable: false })
  })
  await page.goto(APP)
  await page.waitForFunction(() => window.__coreSystemInfo, null, { timeout: 120_000 })
  const rpc = (method, ...args) => page.evaluate(([m, a]) => window.exp.rpc[m](...a), [method, args])
  return { context, page, rpc }
}
const until = async (fn, label) => {
  const deadline = Date.now() + 120_000
  while (Date.now() < deadline) {
    if (await fn()) return
    await new Promise(r => setTimeout(r, 300))
  }
  throw new Error(`timeout waiting for ${label}`)
}

// Canvas-drawn pictures (no binary assets in the repo): a gradient avatar with
// a glyph, and a mountain "holiday photo". Returns a temp path inside the core.
const draw = (page, name, kind, a, b, glyph = '') =>
  page.evaluate(
    async ([name, kind, a, b, glyph]) => {
      const [w, h] = kind === 'photo' ? [1200, 800] : [256, 256]
      const c = new OffscreenCanvas(w, h)
      const g = c.getContext('2d')
      const sky = g.createLinearGradient(0, 0, 0, h)
      sky.addColorStop(0, a)
      sky.addColorStop(1, b)
      g.fillStyle = sky
      g.fillRect(0, 0, w, h)
      if (kind === 'photo') {
        g.fillStyle = 'rgba(255,240,200,0.95)'
        g.beginPath()
        g.arc(w * 0.72, h * 0.3, 70, 0, Math.PI * 2)
        g.fill()
        const ridge = (color, base, peaks) => {
          g.fillStyle = color
          g.beginPath()
          g.moveTo(0, h)
          g.lineTo(0, base)
          for (const [x, y] of peaks) g.lineTo(x * w, y * h)
          g.lineTo(w, base)
          g.lineTo(w, h)
          g.fill()
        }
        ridge('#7c8db5', h * 0.6, [[0.15, 0.38], [0.3, 0.52], [0.48, 0.3], [0.66, 0.5], [0.85, 0.36]])
        ridge('#4f6a8f', h * 0.75, [[0.1, 0.58], [0.28, 0.48], [0.45, 0.66], [0.62, 0.5], [0.8, 0.62], [0.95, 0.52]])
        ridge('#2f4858', h * 0.9, [[0.2, 0.78], [0.4, 0.72], [0.6, 0.84], [0.78, 0.74]])
      } else {
        g.font = '150px sans-serif'
        g.textAlign = 'center'
        g.textBaseline = 'middle'
        g.fillText(glyph, w / 2, h / 2 + 10)
      }
      const blob = await c.convertToBlob({ type: kind === 'photo' ? 'image/jpeg' : 'image/png', quality: 0.9 })
      const bytes = new Uint8Array(await blob.arrayBuffer())
      let bin = ''
      for (const x of bytes) bin += String.fromCharCode(x)
      return window.exp.runtime.writeTempFileFromBase64(name, btoa(bin))
    },
    [name, kind, a, b, glyph]
  )

let failed = false
let mia
try {
  // -- friends: Jonas, Lena, Sam in their own context --
  const friends = await openApp({ viewport: { width: 1000, height: 700 } })
  const setup = async (app, name, avatar) => {
    const id = await app.rpc('addAccount')
    await app.rpc('addTransportFromQr', id, QR)
    await app.rpc('setConfig', id, 'displayname', name)
    if (avatar) await app.rpc('setConfig', id, 'selfavatar', await draw(app.page, `${id}.png`, 'avatar', ...avatar))
    await app.rpc('startIo', id)
    return id
  }
  const jonas = await setup(friends, 'Jonas Becker', ['#fbc2eb', '#a6c1ee', '🧗'])
  const lena = await setup(friends, 'Lena Hoffmann', ['#f6d365', '#fda085', '🌻'])
  const sam = await setup(friends, 'Sam Okafor')

  // -- viewer: Mia, alone in her context --
  mia = await openApp(DESKTOP, MIA_PROFILE)
  const me = await setup(mia, 'Mia Schneider', ['#a1c4fd', '#c2e9fb', '🦥'])

  // everyone knows everyone's key (chatmail is E2EE-only)
  const miaCard = await mia.rpc('makeVcard', me, [1])
  const contactOf = {} // friend as seen by Mia
  const miaAt = {} // Mia as seen by each friend
  for (const id of [jonas, lena, sam]) {
    ;[contactOf[id]] = await mia.rpc('importVcardContents', me, await friends.rpc('makeVcard', id, [1]))
    ;[miaAt[id]] = await friends.rpc('importVcardContents', id, miaCard)
  }

  // Mia's incoming copies arrive as contact requests; accept as they show up
  const accepted = new Set()
  const acceptAll = async () => {
    for (const chat of await mia.rpc('getChatlistEntries', me, 0, 'is:request', null)) {
      if (!accepted.has(chat)) await mia.rpc('acceptChat', me, chat)
      accepted.add(chat)
    }
  }
  let lastCount = 0
  // send one message and wait until Mia has it, so order is deterministic
  const fromFriend = async send => {
    await send()
    await until(async () => {
      await acceptAll()
      const n = (await mia.rpc('getFreshMsgs', me)).length
      if (n > lastCount) return (lastCount = n)
    }, 'delivery to Mia')
  }
  const say = (app, acc, chat, text) => app.rpc('miscSendTextMessage', acc, chat, text)
  const friendChat = {}
  const dmFrom = async (id, text) => {
    friendChat[id] ??= await friends.rpc('createChatByContactId', id, miaAt[id])
    await fromFriend(() => say(friends, id, friendChat[id], text))
  }

  // older DMs first so the group ends up on top of the chat list
  await dmFrom(sam, 'Found your scarf in my car 🧣 bring it Saturday?')
  await dmFrom(lena, 'Book club moved to Thursday, same place!')
  await dmFrom(jonas, 'Can you send me the slides from today?')
  const miaDm = id => mia.rpc('createChatByContactId', me, contactOf[id])
  await say(mia, me, await miaDm(jonas), 'Sure, sending them tonight 👍')

  // the group, created by Mia
  const group = await mia.rpc('createGroupChat', me, GROUP, false)
  await mia.rpc('setChatProfileImage', me, group, await draw(mia.page, 'group.png', 'avatar', '#43e97b', '#38f9d7', '🏔️'))
  for (const id of [jonas, lena, sam]) await mia.rpc('addContactToChat', me, group, contactOf[id])
  await say(mia, me, group, 'Hike on Saturday? Forecast says sunny ☀️')
  const groupAt = {}
  const inGroup = async (id, text, extra) => {
    if (!groupAt[id]) {
      await until(async () => {
        const [c] = await friends.rpc('getChatlistEntries', id, 0, GROUP, null)
        return c && (groupAt[id] = c)
      }, `${GROUP} at friend ${id}`)
      await friends.rpc('acceptChat', id, groupAt[id])
    }
    await fromFriend(() =>
      extra ? friends.rpc('sendMsg', id, groupAt[id], { text, ...extra }) : say(friends, id, groupAt[id], text)
    )
  }
  await inGroup(lena, "I'm in! Which trail are we doing?")
  await inGroup(jonas, 'The ridge loop again? This was the view last time:', {
    file: await draw(friends.page, 'ridge.jpg', 'photo', '#fbd3a5', '#f6a6b2'),
    filename: 'ridge.jpg',
    viewtype: 'Image',
  })
  await inGroup(sam, 'Wow 😍 count me in. I can drive, 3 seats free')
  await say(mia, me, group, 'Perfect! Meet at the station at 9, I’ll bring snacks 🥨')
  await inGroup(lena, 'See you there 🙌')

  // reactions on Jonas's photo, then everything read
  const ids = await mia.rpc('getMessageIds', me, group, false, false)
  const photo = (await Promise.all(ids.map(i => mia.rpc('getMessage', me, i)))).find(m => m.viewType === 'Image')
  await mia.rpc('sendReaction', me, photo.id, ['😍'])
  const photoAt = async id => {
    const fids = await friends.rpc('getMessageIds', id, groupAt[id], false, false)
    return (await Promise.all(fids.map(i => friends.rpc('getMessage', id, i)))).find(m => m.viewType === 'Image')
  }
  await friends.rpc('sendReaction', lena, (await photoAt(lena)).id, ['🔥'])
  await friends.rpc('sendReaction', sam, (await photoAt(sam)).id, ['😍'])
  await until(async () => Object.keys((await mia.rpc('getMessage', me, photo.id)).reactions?.reactionsByContact ?? {}).length === 3, 'reactions at Mia')

  // the app made an empty profile on first load; drop it so Mia is the only
  // one (no account sidebar), then reload so the UI picks her up
  for (const id of await mia.rpc('getAllAccountIds')) if (id !== me) await mia.rpc('removeAccount', id)
  // no welcome device chat on top of the list, and no stale "others will only
  // see this group after you sent a first message" (she has)
  // (the frontend adds its welcome on UI load; using its label first makes
  // that a no-op once the chat is gone)
  await mia.rpc('addDeviceMessage', me, 'slothful-welcome', { text: 'x' })
  for (const chat of await mia.rpc('getChatlistEntries', me, 0, null, null))
    if ((await mia.rpc('getBasicChatInfo', me, chat)).isDeviceChat) await mia.rpc('deleteChat', me, chat)
  for (const id of await mia.rpc('getMessageIds', me, group, true, false)) {
    const m = await mia.rpc('getMessage', me, id)
    if (m.isInfo && /first message/.test(m.text)) await mia.rpc('deleteMessages', me, [id])
  }
  let { page } = mia
  const show = async theme => {
    await page.evaluate(theme => {
      const KEY = 'slothfulchat.desktopSettings'
      const s = JSON.parse(localStorage.getItem(KEY) || '{}')
      s.activeTheme = theme
      localStorage.setItem(KEY, JSON.stringify(s))
    }, theme)
    await page.reload()
    await page.locator('#new-chat-button').waitFor({ state: 'visible', timeout: 120_000 })
    await page.locator('.chat-list-item', { hasText: GROUP }).first().click()
    const last = page.locator('.message', { hasText: 'See you there' })
    await last.waitFor({ timeout: 30_000 })
    await page.waitForTimeout(1500) // avatars, image, fonts
    // the list settles to the bottom once the image has its size
    await until(async () => {
      const jump = page.locator('.jump-down-button')
      if (await jump.isVisible()) await jump.click()
      const box = await last.boundingBox()
      return box && box.y + box.height <= page.viewportSize().height
    }, 'chat scrolled to the bottom')
    await page.mouse.move(5, 5)
    await page.waitForTimeout(500)
  }
  for (const theme of ['dc:light', 'dc:dark']) {
    const name = theme.slice(3)
    await page.setViewportSize({ width: 1440, height: 900 })
    await show(theme)
    await page.screenshot({ path: `${SHOTS}/desktop-${name}.png` })
    console.log(`shot: desktop-${name}`)
  }
  await mia.context.close()
  mia = await openApp(PHONE, MIA_PROFILE)
  page = mia.page
  for (const theme of ['dc:light', 'dc:dark']) {
    const name = theme.slice(3)
    await show(theme)
    await page.screenshot({ path: `${SHOTS}/phone-${name}.png` })
    console.log(`shot: phone-${name}`)
  }
} catch (err) {
  failed = true
  console.error('FAIL:', err)
  for (const p of [...browser.contexts(), mia?.context].filter(Boolean).flatMap(c => c.pages()))
    await p.screenshot({ path: `${SHOTS}/failure-${p.viewportSize()?.width}.png` }).catch(() => {})
} finally {
  clearTimeout(watchdog)
  await mia?.context.close().catch(() => {})
  await browser.close().catch(() => {})
  await rm(MIA_PROFILE, { recursive: true, force: true })
  mock.close()
  cleanup()
}
process.exit(failed ? 1 : 0)
