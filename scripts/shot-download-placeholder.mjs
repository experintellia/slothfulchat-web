// Screenshot + self-check harness for the audio/voice download-on-demand
// placeholder (issues #145, #160) — runs FULLY OFFLINE like
// scripts/shot-voice-player.mjs: an in-process mock madmail server provides two
// webimap accounts, the receiving one gets a tiny `download_limit` so an
// incoming voice note arrives as a pre-message, and both placeholder variants
// are shot into .cache/placeholder-shots/:
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
// A 40s note at 64 kbps is ~320 KB; anything above this limit arrives as a
// pre-message instead of being auto-downloaded.
const DOWNLOAD_LIMIT = 40_000
const VOICE_SECS = 40

const mock = await startMockMadmail()
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
const rpc = (method, ...args) =>
  page.evaluate(([m, a]) => window.exp.rpc[m](...a), [method, args])

let failed = false
try {
  await page.goto(`http://localhost:${APP_PORT}/main.html`)
  await page.waitForFunction(() => window.__coreSystemInfo, null, {
    timeout: 120_000,
  })
  console.log('OK: wasm core booted')

  // --- two accounts; only Bob (the receiver) gets the download limit ---
  const setup = async (name, downloadLimit) => {
    const id = await rpc('addAccount')
    await rpc('addTransportFromQr', id, QR)
    await rpc('setConfig', id, 'displayname', name)
    if (downloadLimit != null) {
      await rpc('setConfig', id, 'download_limit', String(downloadLimit))
    }
    await rpc('startIo', id)
    return id
  }
  const aliceId = await setup('Alice Weber')
  const bobId = await setup('Bob Martinez', DOWNLOAD_LIMIT)
  console.log(`OK: accounts alice=${aliceId} bob=${bobId}`)

  const bobVcard = await rpc('makeVcard', bobId, [1])
  const [bobContact] = await rpc('importVcardContents', aliceId, bobVcard)
  const aliceVcard = await rpc('makeVcard', aliceId, [1])
  await rpc('importVcardContents', bobId, aliceVcard)
  const dm = await rpc('createChatByContactId', aliceId, bobContact)

  const waitIncoming = async (accId, pred, label) => {
    const deadline = Date.now() + 120_000
    while (Date.now() < deadline) {
      const chatIds = await rpc('getChatlistEntries', accId, 0, null, null)
      for (const chatId of chatIds) {
        const ids = await rpc('getMessageIds', accId, chatId, false, false)
        for (const id of ids.slice(-8)) {
          const msg = await rpc('getMessage', accId, id).catch(() => null)
          if (msg && pred(msg)) return { chatId, msg }
        }
      }
      await new Promise(r => setTimeout(r, 600))
    }
    throw new Error(`timeout waiting for ${label} on account ${accId}`)
  }

  await rpc('miscSendTextMessage', aliceId, dm, 'the recording from yesterday 👇')
  const b64 = await voiceMp3Base64(0, VOICE_SECS)
  const path = await page.evaluate(
    ([n, b]) => window.exp.runtime.writeTempFileFromBase64(n, b),
    ['alice-note.mp3', b64]
  )
  await rpc('sendMsg', aliceId, dm, {
    file: path,
    filename: 'alice-note.mp3',
    viewtype: 'Voice',
    // Senders that predate Chat-Duration leave this at 0 and the placeholder
    // shows -:--; pass it so the shots show the realistic case.
    duration: VOICE_SECS * 1000,
  })

  const { chatId: bobChatId, msg } = await waitIncoming(
    bobId,
    m => m.downloadState !== 'Done' && m.postMessageViewType === 'Voice',
    'voice pre-message from alice'
  )
  console.log(
    `OK: pre-message on bob (downloadState=${msg.downloadState}, ${msg.fileBytes} bytes)`
  )
  await rpc('acceptChat', bobId, bobChatId)

  // --- select Bob's profile and open the chat ---
  const selectBob = async () => {
    if (!(await page.getByTestId(`selected-account:${bobId}`).count())) {
      const item = page.getByTestId(`account-item-${bobId}`)
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
  await selectBob()

  const placeholder = page
    .locator('.message-attachment-audio.download-on-demand')
    .first()

  const shot = async (name) => {
    await placeholder.waitFor({ state: 'visible', timeout: 30_000 })
    await page.waitForTimeout(400)
    await page.screenshot({ path: `${SHOTS}/${name}-full.png` })
    await placeholder
      .locator('xpath=ancestor::*[contains(@class,"message")][1]')
      .screenshot({ path: `${SHOTS}/${name}.png` })
    console.log(`shot: ${SHOTS}/${name}.png`)
  }

  const check = async (label, expected) => {
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

  // --- BEFORE: setting off, the native-<audio> pill ---
  await check('setting off', { pill: 1, custom: 0, waveform: 0, download: 1 })
  await shot('01-before-native-pill')

  // --- AFTER: setting on, the custom player's two-row layout ---
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
  await selectBob()
  await check('setting on', { pill: 0, custom: 1, waveform: 1, download: 1 })
  await shot('02-after-custom-player')

  // The point of the change: the placeholder must resemble what the message
  // becomes, so download it and shoot the real player for comparison.
  await placeholder.locator('.circle-download-button').click()
  const realPlayer = page.locator('.message-attachment-audio').first()
  await realPlayer
    .locator('input[type=range]')
    .waitFor({ state: 'visible', timeout: 60_000 })
  await page.waitForTimeout(800)
  await realPlayer
    .locator('xpath=ancestor::*[contains(@class,"message")][1]')
    .screenshot({ path: `${SHOTS}/03-after-downloaded.png` })
  console.log(`shot: ${SHOTS}/03-after-downloaded.png`)

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
