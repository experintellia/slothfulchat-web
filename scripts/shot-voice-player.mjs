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
import { mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { startServers } from './harness.mjs'
import { startMockMadmail } from './mock-madmail.mjs'
import { voiceMp3Base64 } from './voice-mp3.mjs'

const script = (p) => fileURLToPath(new URL(p, import.meta.url))
// MOBILE=1: phone-sized viewport + touch, shots land in voice-shots-mobile/
const MOBILE = !!process.env.MOBILE
const SHOTS = script(MOBILE ? '../.cache/voice-shots-mobile/' : '../.cache/voice-shots/')
await mkdir(SHOTS, { recursive: true })
const APP_PORT = 8674

// --- mock madmail server (shared: scripts/mock-madmail.mjs) ---
const mock = await startMockMadmail()
const mockPort = mock.port
console.log(`mock madmail on 127.0.0.1:${mockPort}`)
const QR = `webimapaccount:127.0.0.1:${mockPort}`

// --- web-app server ---
const { cleanup, watchdog } = await startServers({
  app: APP_PORT,
  settleMs: 700,
  watchdogMs: 360_000,
})

// --- browser ---
const launchOpts = process.env.CHROMIUM_BIN
  ? { executablePath: process.env.CHROMIUM_BIN }
  : {}
launchOpts.args = [
  '--autoplay-policy=no-user-gesture-required',
  // fake mic (a generated tone) so the recorder works headless, permission-free
  '--use-fake-device-for-media-stream',
  '--use-fake-ui-for-media-stream',
]
// SILENT_WAV=<path to silent wav>: feed silence instead of the tone, to
// capture the no-sound warning shot
if (process.env.SILENT_WAV) {
  launchOpts.args.push(`--use-file-for-fake-audio-capture=${process.env.SILENT_WAV}`)
}
const browser = await chromium.launch(launchOpts)
const page = await browser.newPage(
  MOBILE
    ? { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true }
    : { viewport: { width: 1280, height: 900 } }
)
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

  const sendVoice = async (accId, chatId, name, seed, secs) => {
    const b64 = await voiceMp3Base64(seed, secs)
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
  await sendVoice(bobId, bobChatId, 'bob-reply.mp3', 1, 30)
  const { msgId: bobVoiceId } = await waitIncoming(
    aliceId,
    (m) => m.viewType === 'Voice' && !m.isInfo && m.fromId !== 1,
    'voice from bob'
  )
  console.log('OK: bob -> alice voice delivered')
  // forward bob's note into the same chat: same content-deduped blob, so the
  // original and the forward must NOT advance together (per-message #msg src)
  await rpc('forwardMessages', aliceId, [bobVoiceId], dm)
  console.log('OK: forwarded the voice note into the same chat')

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

  if (process.env.WAVE_DEBUG) {
    await page.waitForTimeout(1500)
    const dbg = await page.evaluate(() => {
      const out = []
      for (const c of document.querySelectorAll('canvas')) {
        const r = c.getBoundingClientRect()
        let painted = -1
        try {
          const ctx = c.getContext('2d')
          const d = ctx.getImageData(0, 0, c.width || 1, c.height || 1).data
          painted = d.reduce((a, v, i) => (i % 4 === 3 ? a + v : a), 0)
        } catch (e) {
          painted = String(e)
        }
        out.push({
          cls: c.className,
          w: c.width,
          h: c.height,
          cssW: r.width,
          cssH: r.height,
          painted,
        })
      }
      const ranges = [...document.querySelectorAll('input[type=range]')].map(
        (i) => i.className
      )
      return { canvases: out, ranges }
    })
    console.log('WAVE_DEBUG', JSON.stringify(dbg, null, 1))
  }

  // play the incoming voice message; progress + global bottom bar appear
  await incomingPlayer.getByRole('button', { name: 'Play', exact: true }).click()
  await page.waitForTimeout(2500)
  await shot('02-custom-player-playing')
  {
    // exactly ONE player may advance — the forwarded copy of the same blob
    // stays at 0:00 (regression check for the shared-src double-advance)
    const times = await page
      .locator('.message .message-attachment-audio [class*=time]')
      .allTextContents()
    const advancing = times.filter((t) => !/^0:00\s/.test(t))
    if (advancing.length !== 1) {
      throw new Error(
        `expected exactly 1 advancing player, got ${JSON.stringify(times)}`
      )
    }
    console.log('OK: only the clicked player advances', JSON.stringify(times))
  }

  // #137 strip: on mobile the player pins under the navbar in BOTH views
  if (MOBILE) {
    try {
      const strip = page.getByTestId('voice-message-strip')
      await strip.waitFor({ state: 'visible', timeout: 10_000 })
      await shot('12-strip-chat-view')
      // the chat-view back button is icon-only (no accessible name); NB a
      // name-based lookup like { name: 'Back' } substring-matches the speed
      // pill's "Playback speed" label
      await page.locator('button:has(.backButtonIcon)').click()
      await strip.waitFor({ state: 'visible', timeout: 10_000 })
      await page.waitForTimeout(400)
      await shot('13-strip-list-view')
      await page
        .locator('.chat-list .chat-list-item')
        .filter({ hasText: 'Bob' })
        .first()
        .click()
      await incomingPlayer.waitFor({ state: 'visible', timeout: 15_000 })
    } catch (err) {
      console.warn('strip shots skipped:', err.message)
    }
  }

  // A3: playback survives a chat switch; the mini-player carries the controls
  try {
    await page
      .locator('.chat-list .chat-list-item')
      .filter({ hasText: 'Device Messages' })
      .first()
      .click()
    await page.waitForTimeout(800)
    await shot('06-miniplayer-cross-chat')
    await page
      .locator('.chat-list .chat-list-item')
      .filter({ hasText: 'Bob' })
      .first()
      .click()
    await incomingPlayer.waitFor({ state: 'visible', timeout: 15_000 })
    // upstream #6378: after switching away and back while playing, the bubble
    // must show the singleton's real position, not reset to 0:00
    await page.waitForTimeout(600)
    const t = await incomingPlayer.locator('[class*=time]').textContent()
    if (!t || /^0:0[01] \//.test(t)) {
      throw new Error(`bubble position desynced after chat switch: "${t}"`)
    }
    console.log('OK: bubble position kept after chat switch:', t)
  } catch (err) {
    console.warn('mini-player shot skipped:', err.message)
  }

  // speed pill: 1x -> 1.5x -> 2x
  const pill = incomingPlayer.getByRole('button', { name: /Playback speed/ })
  await pill.click()
  await pill.click()
  await page.waitForTimeout(300)
  await shot('03-custom-player-2x')

  // stop playback for clean dialog shots (it may have ended already)
  await incomingPlayer
    .getByRole('button', { name: 'Pause', exact: true })
    .click({ timeout: 5000 })
    .catch(() => {})

  // the experimental setting switch
  try {
    await page.getByTestId('open-settings-button').click()
    await page.getByText('Advanced', { exact: true }).click()
    await page.waitForTimeout(500)
    await shot('04-settings-experimental')
  } catch (err) {
    console.warn('settings shot skipped:', err.message)
  }

  // A2: Diagnostics panel with the Waveform timing section
  try {
    await page.getByText('View Log', { exact: true }).click()
    await page.waitForTimeout(400)
    await page.getByRole('button', { name: 'Diagnostics' }).click()
    await page.waitForTimeout(400)
    await shot('05-diagnostics-waveform')
  } catch (err) {
    console.warn('diagnostics shot skipped:', err.message)
  }
  for (let i = 0; i < 5; i++) {
    if (!(await page.locator('dialog[open]').count())) break
    await page.keyboard.press('Escape')
    await page.waitForTimeout(300)
  }

  // B: recording (tap starts via fake mic), pause, then the preview row
  try {
    await page.getByRole('button', { name: 'Voice Message' }).click()
    await page.waitForTimeout(2500)
    if (process.env.SILENT_WAV) {
      // silence detector fires after ~3s of quiet; the warning must show
      await page
        .getByTestId('recording-no-sound')
        .waitFor({ state: 'visible', timeout: 10_000 })
      await shot('11-no-sound-warning')
      await page.getByRole('button', { name: 'Cancel' }).click()
      throw { silentRunDone: true }
    }
    await shot('07-recording-live')
    // mic picker (renders only when >1 audioinput is enumerated)
    try {
      await page.getByTestId('mic-picker-trigger').click({ timeout: 3000 })
      await page.waitForTimeout(500)
      if (process.env.MIC_DEBUG) {
        const dbg = await page.evaluate(() => {
          const menu = document.querySelector('[data-testid=mic-picker-menu]')
          if (!menu) return 'NO MENU'
          const mr = menu.getBoundingClientRect()
          return {
            menu: { w: mr.width, cls: menu.className },
            rows: [...menu.querySelectorAll('button')].map((b) => {
              const r = b.getBoundingClientRect()
              const label = b.querySelector('[class*=micLabel]')
              const meter = b.querySelector('[class*=micRowMeter]')
              const lr = label?.getBoundingClientRect()
              return {
                rowW: r.width,
                text: label?.textContent,
                labelW: lr?.width,
                labelDisplay: label ? getComputedStyle(label).display : null,
                labelFlex: label ? getComputedStyle(label).flex : null,
                rowDisplay: getComputedStyle(b).display,
                meterW: meter?.getBoundingClientRect().width ?? null,
              }
            }),
          }
        })
        console.log('MIC_DEBUG', JSON.stringify(dbg, null, 1))
      }
      await shot('10-mic-picker')
      await page.keyboard.press('Escape')
    } catch {
      console.warn('mic picker not shown (single audioinput) — shot skipped')
    }
    await page.getByRole('button', { name: 'Pause recording' }).click()
    await page.waitForTimeout(400)
    await shot('08-recording-paused')
    await page.getByRole('button', { name: 'Resume recording' }).click()
    await page.waitForTimeout(1000)
    await page.getByRole('button', { name: 'Finish recording' }).click()
    await page.waitForTimeout(800)
    await shot('09-recording-preview')
    await page.getByRole('button', { name: 'Delete', exact: true }).click()
  } catch (err) {
    if (err?.silentRunDone) {
      console.log('DONE (silent run)')
    } else {
      console.warn('recording shots skipped:', err.message)
    }
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
