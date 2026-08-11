// Screenshot + self-check harness for the audio/voice download-on-demand
// placeholder (issues #145, #160) — runs FULLY OFFLINE like
// scripts/shot-voice-player.mjs: an in-process mock madmail server provides two
// webimap accounts and a 1:1 chat is seeded with two voice notes, one small
// (delivered whole) and one large.
//
// A large attachment is sent as a pre-message plus a post-message; the mock
// server holds the post-message back (`holdPostMessages`), so the large note
// stays in the download-on-demand state the placeholder renders. On a real
// IMAP transport that state comes from `download_limit`, but the webimap
// transport always fetches whole bodies, so withholding the post-message is
// the only way to reach it offline.
//
// The chat then shows the placeholder and the real player side by side, in
// both settings states, shot into .cache/placeholder-shots/:
//
//   experimentalAudioPlayerControls OFF -> the native-<audio> pill
//   experimentalAudioPlayerControls ON  -> the custom player's two-row layout
//
// It also asserts each variant's markup, so it doubles as the runnable check
// for DownloadOnDemandPlaceholder's audio branch.
//
// Requires packages/core-wasm built and packages/web-app assembled+built.
// Run:  node scripts/shot-download-placeholder.mjs
// (CHROMIUM_BIN=/path/to/chrome overrides the playwright-managed browser.)
import { mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { startServers } from './harness.mjs'
import { startMockMadmail } from './mock-madmail.mjs'
import { voiceMp3Base64 } from './voice-mp3.mjs'

const script = p => fileURLToPath(new URL(p, import.meta.url))
const SHOTS = script('../.cache/placeholder-shots/')
await mkdir(SHOTS, { recursive: true })
const APP_PORT = 8676
// Core splits an attachment into pre-/post-message above ~140 KB; 40s at
// 64 kbps is ~320 KB, the 7s one stays well under.
const BIG_SECS = 40
const SMALL_SECS = 7

const mock = await startMockMadmail({ holdPostMessages: true })
console.log(`mock madmail on 127.0.0.1:${mock.port}`)
const QR = `webimapaccount:127.0.0.1:${mock.port}`

const { cleanup, watchdog } = await startServers({
  app: APP_PORT,
  settleMs: 700,
  watchdogMs: 360_000,
})

const browser = await chromium.launch(
  process.env.CHROMIUM_BIN ? { executablePath: process.env.CHROMIUM_BIN } : {}
)
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
page.on('console', m => {
  if (/panicked at/.test(m.text())) console.error('[page PANIC]', m.text())
})
page.on('pageerror', e => console.error('[pageerror]', e.message))
// The app replaces window.eval with a thrower; playwright's page.evaluate
// needs the real one, so pin it before any app script runs.
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

  const setup = async name => {
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

  const waitIncoming = async (accId, pred, label) => {
    const deadline = Date.now() + 180_000
    let seen = []
    while (Date.now() < deadline) {
      seen = []
      const chatIds = await rpc('getChatlistEntries', accId, 0, null, null)
      for (const chatId of chatIds) {
        const ids = await rpc('getMessageIds', accId, chatId, false, false)
        for (const id of ids.slice(-8)) {
          const msg = await rpc('getMessage', accId, id).catch(() => null)
          if (msg && pred(msg)) return { chatId, msg }
          if (msg) {
            seen.push({
              id,
              viewType: msg.viewType,
              post: msg.postMessageViewType,
              downloadState: msg.downloadState,
              bytes: msg.fileBytes,
            })
          }
        }
      }
      await new Promise(r => setTimeout(r, 600))
    }
    throw new Error(
      `timeout waiting for ${label} on account ${accId}; saw ${JSON.stringify(seen)}`
    )
  }

  const sendVoice = async (name, seed, secs) => {
    const b64 = await voiceMp3Base64(seed, secs)
    const path = await page.evaluate(
      ([n, b]) => window.exp.runtime.writeTempFileFromBase64(n, b),
      [name, b64]
    )
    await rpc('sendMsg', aliceId, dm, {
      file: path,
      filename: name,
      viewtype: 'Voice',
      // Senders that predate Chat-Duration leave this at 0 and both the
      // placeholder and the player show -:--; pass it for a realistic shot.
      duration: secs * 1000,
    })
  }

  await rpc('miscSendTextMessage', aliceId, dm, 'two takes, the long one 👇')
  await sendVoice('alice-short.mp3', 1, SMALL_SECS)
  const { chatId: bobChatId } = await waitIncoming(
    bobId,
    m => m.viewType === 'Voice' && m.downloadState === 'Done',
    'the small voice note'
  )
  await rpc('acceptChat', bobId, bobChatId)
  await sendVoice('alice-long.mp3', 0, BIG_SECS)
  const { msg } = await waitIncoming(
    bobId,
    m => m.downloadState !== 'Done' && m.postMessageViewType === 'Voice',
    'the voice pre-message'
  )
  console.log(
    `OK: pre-message on bob (downloadState=${msg.downloadState}, ${msg.fileBytes} bytes), ` +
      `${mock.counters.heldPostMsgs} post-message(s) held`
  )

  // --- select Bob's profile and open the chat ---
  const selectBob = async () => {
    if (!(await page.getByTestId(`selected-account:${bobId}`).count())) {
      const item = page.getByTestId(`account-item-${bobId}`)
      await item.waitFor({ state: 'visible', timeout: 60_000 })
      await item.hover()
      await item.click()
      await page
        .getByTestId(`selected-account:${bobId}`)
        .waitFor({ state: 'attached', timeout: 30_000 })
    }
    await page
      .locator('.chat-list .chat-list-item')
      .filter({ hasText: 'Alice' })
      .first()
      .click()
    await page.mouse.move(1000, 100)
  }
  // experimentalAudioPlayerControls is ON by default, so both states have to
  // be set explicitly. Writing localStorage takes a reload to reach the
  // settings store — which is wanted anyway on the first call: the accounts
  // were created through the rpc escape hatch, so the UI is still sitting on
  // the onboarding dialog (which would swallow the sidebar clicks).
  const setCustomControls = async on => {
    await page.evaluate(v => {
      const KEY = 'slothfulchat.desktopSettings'
      const s = JSON.parse(localStorage.getItem(KEY) || '{}')
      s.experimentalAudioPlayerControls = v
      localStorage.setItem(KEY, JSON.stringify(s))
    }, on)
    await page.reload()
    await page
      .locator('#new-chat-button')
      .waitFor({ state: 'visible', timeout: 120_000 })
    await selectBob()
  }
  await setCustomControls(false)

  const placeholder = page
    .locator('.message-attachment-audio.download-on-demand')
    .first()

  const shot = async name => {
    await placeholder.waitFor({ state: 'visible', timeout: 30_000 })
    await page.waitForTimeout(600)
    await page.screenshot({ path: `${SHOTS}/${name}-full.png` })
    // The two voice messages together: the downloaded one is what the
    // placeholder above it is imitating.
    await page
      .locator('#message-list')
      .screenshot({ path: `${SHOTS}/${name}.png` })
    console.log(`shot: ${SHOTS}/${name}.png`)
  }

  const check = async (label, expected) => {
    await placeholder.waitFor({ state: 'visible', timeout: 60_000 })
    const got = {
      pill: await placeholder.locator('.fake-audio-player').count(),
      custom: await placeholder.locator('.fake-custom-player').count(),
      waveform: await placeholder.locator('.fake-waveform').count(),
      download: await placeholder.locator('.circle-download-button').count(),
    }
    for (const [k, v] of Object.entries(expected)) {
      if (got[k] !== v) {
        throw new Error(
          `${label}: expected ${k}=${v}, got ${k}=${got[k]} (${JSON.stringify(got)})`
        )
      }
    }
    console.log(`OK: ${label} markup ${JSON.stringify(got)}`)
  }

  // --- setting off: the native-<audio> pill, unchanged ---
  await check('setting off', { pill: 1, custom: 0, waveform: 0, download: 1 })
  await shot('01-native-pill')

  // --- setting on: the custom player's two-row layout ---
  await setCustomControls(true)
  await check('setting on', { pill: 0, custom: 1, waveform: 1, download: 1 })
  await shot('02-custom-player')

  console.log('PASS: both placeholder variants render as expected')
} catch (err) {
  failed = true
  console.error('FAIL:', err)
  await page.screenshot({ path: `${SHOTS}/failure.png` }).catch(() => {})
} finally {
  clearTimeout(watchdog)
  await browser.close().catch(() => {})
  mock.close()
  cleanup()
}
process.exit(failed ? 1 : 0)
