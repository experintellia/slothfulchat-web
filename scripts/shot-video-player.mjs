// Video player check + screenshots (Video.js bubble player, hotkeys, one
// medium at a time, mini player across a chat switch, fullscreen viewer).
// Runs FULLY OFFLINE like scripts/shot-voice-player.mjs: mock madmail account,
// a video + voice note seeded into Saved Messages via the rpc escape hatch.
// Asserts the behaviour; screenshots land in .cache/video-shots/.
//
// Requires packages/core-wasm built, packages/web-app assembled+built and
// ffmpeg on PATH (generates the VP9/Opus fixture).
// Run:  node scripts/shot-video-player.mjs
import { execFileSync } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { startServers } from './harness.mjs'
import { startMockMadmail } from './mock-madmail.mjs'
import { voiceMp3Base64 } from './voice-mp3.mjs'

const script = (p) => fileURLToPath(new URL(p, import.meta.url))
const SHOTS = script('../.cache/video-shots/')
await mkdir(SHOTS, { recursive: true })
const APP_PORT = 8675

// 20 s 640x360 test pattern with a tone; webm because playwright's Chromium
// has no H.264
const videoB64 = execFileSync(
  'ffmpeg',
  ['-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=24',
    '-f', 'lavfi', '-i', 'sine=frequency=330', '-t', '20',
    '-c:v', 'libvpx-vp9', '-b:v', '300k', '-deadline', 'realtime',
    '-c:a', 'libopus', '-f', 'webm', '-'],
  { maxBuffer: 64 << 20 }
).toString('base64')
// second, portrait clip: gives the fullscreen viewer a neighbour (prev/next)
const portraitB64 = execFileSync(
  'ffmpeg',
  ['-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=360x640:rate=24',
    '-t', '6', '-c:v', 'libvpx-vp9', '-b:v', '200k', '-deadline', 'realtime',
    '-an', '-f', 'webm', '-'],
  { maxBuffer: 64 << 20 }
).toString('base64')

const mock = await startMockMadmail()
const QR = `webimapaccount:127.0.0.1:${mock.port}`
const { cleanup, watchdog } = await startServers({
  app: APP_PORT,
  settleMs: 700,
  watchdogMs: 300_000,
})

const browser = await chromium.launch(
  process.env.CHROMIUM_BIN ? { executablePath: process.env.CHROMIUM_BIN } : {}
)
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
page.on('pageerror', (e) => console.error('[pageerror]', e.message))
await page.addInitScript(() => {
  Object.defineProperty(window, 'eval', { value: window.eval, writable: false })
  // keep the runtime: the frontend deletes window.r after importing it
  let r
  Object.defineProperty(window, 'r', {
    configurable: true,
    get: () => r,
    set(v) {
      r = v
      window.__rt = v
    },
  })
})
const rpc = (method, ...args) =>
  page.evaluate(([m, a]) => window.exp.rpc[m](...a), [method, args])
const assert = (cond, msg) => {
  if (!cond) throw new Error(msg)
  console.log('OK:', msg)
}
const shot = async (name) => {
  await page.waitForTimeout(300)
  await page.screenshot({ path: `${SHOTS}/${name}.png` })
  console.log(`shot: ${SHOTS}${name}.png`)
}
// state of the first chat <video> inside `scope`
const videoState = (scope) =>
  page.evaluate((sel) => {
    const v = document.querySelector(`${sel} video[data-chat-video]`)
    return v && { t: v.currentTime, d: v.duration, paused: v.paused, muted: v.muted }
  }, scope)

let failed = false
try {
  await page.goto(`http://localhost:${APP_PORT}/main.html`)
  await page.waitForFunction(() => window.__coreSystemInfo, null, {
    timeout: 120_000,
  })
  const id = await rpc('addAccount')
  await rpc('addTransportFromQr', id, QR)
  await rpc('setConfig', id, 'displayname', 'Alice Weber')
  const self = await rpc('createChatByContactId', id, 1)
  // a second chat with a composer to switch to (Device Messages has none)
  const bob = await rpc('createContact', id, 'bob@example.org', 'Bob')
  const bobChat = await rpc('createChatByContactId', id, bob)
  await rpc('miscSetDraft', id, bobChat, 'hi Bob', null, null, null, 'Text')
  const writeTemp = (name, b64) =>
    page.evaluate(
      ([n, b]) => window.exp.runtime.writeTempFileFromBase64(n, b),
      [name, b64]
    )
  // earlier chatter, so the chat scrolls and the video can leave the view
  for (let i = 1; i <= 15; i++) {
    await rpc('miscSendTextMessage', id, self, `earlier message ${i}`)
  }
  await rpc('sendMsg', id, self, {
    file: await writeTemp('note.mp3', await voiceMp3Base64(0, 8)),
    filename: 'note.mp3',
    viewtype: 'Voice',
  })
  await rpc('miscSendTextMessage', id, self, 'Clip from the release party 🎉')
  const clipId = await rpc('sendMsg', id, self, {
    file: await writeTemp('clip.webm', videoB64),
    filename: 'clip.webm',
    viewtype: 'Video',
  })
  await rpc('sendMsg', id, self, {
    file: await writeTemp('portrait.webm', portraitB64),
    filename: 'portrait.webm',
    viewtype: 'Video',
  })

  await rpc('sendReaction', id, clipId, ['👍'])
  // a second profile, for "Show in Chat" across accounts (#276)
  const id2 = await rpc('addAccount')
  await rpc('addTransportFromQr', id2, QR)
  await rpc('setConfig', id2, 'displayname', 'Second Profile')

  // let the blob writes reach OPFS before the reload drops the in-memory fs
  // (otherwise the last-sent file is "memfs: no such file" after reload)
  await page.waitForTimeout(4000)
  await page.reload()
  const item = page.getByTestId(`account-item-${id}`)
  await item.waitFor({ timeout: 120_000 })
  if (!(await page.getByTestId(`selected-account:${id}`).count())) {
    // the boot-time empty account's onboarding dialog covers the sidebar
    await page.evaluate((i) => window.__selectAccount(i), id)
    await page
      .getByTestId(`selected-account:${id}`)
      .waitFor({ state: 'attached', timeout: 30_000 })
  }
  await page.locator('#new-chat-button').waitFor({ timeout: 60_000 })
  await page
    .locator('.chat-list .chat-list-item')
    .filter({ hasText: 'Saved' })
    .first()
    .click()
  const bubble = '.message .message-attachment-media.video'
  const player = page.locator(`${bubble} .media-skin`).first()
  await player.waitFor({ state: 'visible', timeout: 30_000 })
  await shot('01-bubble-paused')

  // play via the skin's button; controls auto-hide once the pointer leaves
  await player.hover()
  await player.getByRole('button', { name: 'Play' }).first().click()
  await page.waitForTimeout(1500)
  assert((await videoState(bubble))?.paused === false, 'bubble video plays')
  await page.mouse.move(5, 450)
  await page.waitForTimeout(2600)
  await shot('02-bubble-playing-controls-hidden')
  const controlsVisible = () =>
    player.evaluate((el) => el.hasAttribute('data-controls-visible'))
  assert(!(await controlsVisible()), 'controls hide while playing with the pointer away')
  // time/✓ sit on the video and fade with the controls; reactions stay
  const footerState = () =>
    page.evaluate(() => {
      const msg = document.querySelector('.message.video-only')
      const meta = msg.querySelector('footer .metadata')
      const skin = msg.querySelector('.media-skin').getBoundingClientRect()
      const bubbleBox = msg.querySelector('.msg-container').getBoundingClientRect()
      return {
        meta: getComputedStyle(meta).opacity,
        reaction: /👍/.test(msg.querySelector('footer').textContent),
        strip: bubbleBox.bottom - skin.bottom,
      }
    })
  const playingFooter = await footerState()
  assert(playingFooter.meta === '0', 'time/✓ fade while playing')
  assert(playingFooter.reaction, 'reactions stay on the playing video')
  assert(Math.abs(playingFooter.strip) <= 2, `no strip under the player (${playingFooter.strip}px)`)
  await player.hover()
  await page.waitForTimeout(300)
  assert(await controlsVisible(), 'controls come back on hover')
  assert((await footerState()).meta === '1', 'time/✓ come back with the controls')
  await shot('03-bubble-playing-hover')

  // hotkeys act while focus is inside the player
  await player.focus()
  const t0 = (await videoState(bubble)).t
  await page.keyboard.press('l')
  await page.waitForTimeout(300)
  assert((await videoState(bubble)).t >= t0 + 8, `"l" seeks +10 s (${t0.toFixed(1)}s → ${(await videoState(bubble)).t.toFixed(1)}s)`)
  await page.keyboard.press('m')
  await page.waitForTimeout(400)
  assert((await videoState(bubble)).muted, '"m" mutes')
  await page.keyboard.press('m')
  await page.keyboard.press('k')
  await page.waitForTimeout(200)
  assert((await videoState(bubble)).paused, '"k" pauses')
  await page.keyboard.press('0')
  await page.waitForTimeout(200)
  assert((await videoState(bubble)).t < 1, '"0" jumps to the start')
  // keys the player doesn't use still start a reply
  await page.keyboard.press('a')
  const typedTo = await page.evaluate(() => document.activeElement?.className)
  assert(/create-or-edit-message-input/.test(typedTo), 'typing "a" on the player goes to the composer')
  await page.keyboard.press('Backspace')
  await player.focus()

  // one medium at a time: the voice note pauses the video and vice versa
  await page.keyboard.press('k')
  await page.waitForTimeout(500)
  await page
    .locator('.message-attachment-audio')
    .first()
    .getByRole('button', { name: 'Play', exact: true })
    .click()
  await page.waitForTimeout(800)
  assert((await videoState(bubble)).paused, 'voice message pauses the video')
  await player.focus()
  await page.keyboard.press('k')
  await page.waitForTimeout(800)
  const voicePaused = await page.evaluate(() =>
    [...document.querySelectorAll('.message-attachment-audio button')].some(
      (b) => b.getAttribute('aria-label') === 'Play'
    )
  )
  assert(voicePaused, 'video pauses the voice message')

  // scrolled out of view while playing → mini player; back in view → inline
  const MINI = '[role=region][aria-label=Video]'
  const mini = page.getByRole('region', { name: 'Video' })
  const scrollList = (top) =>
    page.locator('#message-list').evaluate((el, t) => {
      el.scrollTop = t === 'end' ? el.scrollHeight : t
    }, top)
  await scrollList(0)
  await mini.waitFor({ state: 'visible', timeout: 10_000 })
  await page.waitForTimeout(1200)
  const out = await videoState(MINI)
  const inline = await videoState(bubble)
  assert(
    out && !out.paused && inline.paused && out.t >= inline.t,
    `scrolled out of view: mini player continues (${inline.t.toFixed(1)}s → ${out?.t.toFixed(1)}s)`
  )
  await shot('04a-scrolled-out')
  await scrollList('end')
  await page.waitForTimeout(800)
  const backIn = await videoState(bubble)
  assert(
    (await mini.count()) === 0 && !backIn.paused && backIn.t >= out.t,
    `scrolled back: the bubble takes it back and keeps playing (${backIn.t.toFixed(1)}s)`
  )
  // paused in the mini player stays paused when the bubble takes it back
  await scrollList(0)
  await mini.waitFor({ state: 'visible', timeout: 10_000 })
  await page.waitForTimeout(600)
  await page.evaluate((sel) => document.querySelector(`${sel} video`).pause(), MINI)
  const pausedAt = (await videoState(MINI)).t
  await scrollList('end')
  await page.waitForTimeout(800)
  const st = await videoState(bubble)
  assert(
    (await mini.count()) === 0 && st.paused && Math.abs(st.t - pausedAt) < 0.5,
    'taken back paused, at the same spot'
  )
  await player.focus()
  await page.keyboard.press('k')
  await page.waitForTimeout(500)

  // chat switch while playing → floating mini player continues
  const before = (await videoState(bubble)).t
  await page
    .locator('.chat-list .chat-list-item')
    .filter({ hasText: 'Bob' })
    .first()
    .click()
  await mini.waitFor({ state: 'visible', timeout: 10_000 })
  await page.waitForTimeout(1500)
  const miniState = await videoState(MINI)
  assert(
    miniState && !miniState.paused && miniState.t >= before,
    `mini player continues (${before.toFixed(1)}s → ${miniState?.t.toFixed(1)}s)`
  )
  await shot('04-mini-player')
  assert(
    await mini.evaluate((el) => !!el.querySelector('.media-skin button[aria-label="Show in Chat"]')),
    'mini-player buttons live inside the player UI (#277)'
  )
  await page.mouse.move(5, 450)
  await page.waitForTimeout(2600)
  const barOpacity = () =>
    mini.evaluate((el) => getComputedStyle(el.querySelector('button[aria-label="Close"]').parentElement).opacity)
  assert((await barOpacity()) === '0', 'mini-player bar fades with the controls')
  await shot('04b-mini-player-idle')
  await mini.hover()
  await page.waitForTimeout(400)
  assert((await barOpacity()) === '1', 'mini-player bar comes back on hover')
  const composerBox = await page.locator('.create-or-edit-message-input').boundingBox()
  const miniBox = await mini.boundingBox()
  assert(
    miniBox.y + miniBox.height <= composerBox.y,
    'default mini-player spot clears the composer'
  )

  // drag it by the header
  const box = await mini.boundingBox()
  // the middle of the top bar: our buttons are at the start, the skin's at the end
  await page.mouse.move(box.x + box.width / 2, box.y + 12)
  await page.mouse.down()
  await page.mouse.move(box.x - 300, box.y + 300, { steps: 8 })
  await page.mouse.up()
  const moved = await mini.boundingBox()
  assert(moved.x < box.x - 200 && moved.y > box.y + 200, 'mini player drags')
  await shot('05-mini-player-dragged')
  // a right-click on the header must not leave a drag hanging
  await page.mouse.click(moved.x + moved.width / 2, moved.y + 12, { button: 'right' })
  await page.keyboard.press('Escape')
  await page.mouse.move(moved.x - 100, moved.y - 100, { steps: 4 })
  const afterRight = await mini.boundingBox()
  assert(afterRight.x === moved.x && afterRight.y === moved.y, 'right-click does not drag')

  // "Show in Chat" jumps back; the visible bubble takes the video back
  const miniT = (await videoState(MINI)).t
  await mini.getByRole('button', { name: 'Show in Chat' }).click()
  await page.locator(bubble).first().waitFor({ timeout: 10_000 })
  await page.waitForTimeout(1000)
  assert((await mini.count()) === 0, '"Show in Chat" closes the mini player')
  const back = await videoState(bubble)
  assert(
    !back.paused && back.t >= miniT - 0.5,
    `bubble keeps playing from the mini player's spot (${back.t.toFixed(1)}s)`
  )

  // a second handoff of the same video resumes at the new spot
  const before2 = (await videoState(bubble)).t
  await page
    .locator('.chat-list .chat-list-item')
    .filter({ hasText: 'Bob' })
    .first()
    .click()
  await mini.waitFor({ state: 'visible', timeout: 10_000 })
  await page.waitForTimeout(1200)
  const again = await videoState(MINI)
  assert(
    again && !again.paused && again.t >= before2,
    `second handoff resumes (${before2.toFixed(1)}s → ${again?.t.toFixed(1)}s)`
  )
  await mini.getByRole('button', { name: 'Close' }).click()
  assert((await mini.count()) === 0, 'mini player closes')
  await page
    .locator('.chat-list .chat-list-item')
    .filter({ hasText: 'Saved' })
    .first()
    .click()
  await page.locator(bubble).first().waitFor({ timeout: 10_000 })

  // #276: "Show in Chat" also works after switching to another profile
  await player.hover()
  await player.getByRole('button', { name: 'Play' }).first().click()
  await page.waitForTimeout(1000)
  await page.evaluate((i) => window.__selectAccount(i), id2)
  await page.getByTestId(`selected-account:${id2}`).waitFor({ state: 'attached', timeout: 30_000 })
  await mini.waitFor({ state: 'visible', timeout: 10_000 })
  await mini.getByRole('button', { name: 'Show in Chat' }).click()
  await page.getByTestId(`selected-account:${id}`).waitFor({ state: 'attached', timeout: 30_000 })
  await page.locator(bubble).first().waitFor({ timeout: 20_000 })
  await page.waitForTimeout(1500)
  assert(
    (await mini.count()) === 0 && !(await videoState(bubble)).paused,
    '"Show in Chat" across profiles switches back and resumes in the bubble'
  )

  // fullscreen viewer via the gallery
  await page.evaluate(() => {
    for (const v of document.querySelectorAll('video')) v.pause()
  })
  await page.getByRole('button', { name: /gallery|media/i }).first().click()
  await page.getByRole('tab', { name: 'Gallery' }).click()
  await page.locator('dialog .media-attachment-media').first().click()
  const fs = '.attachment-view'
  await page.locator(`${fs} .media-skin`).waitFor({ timeout: 10_000 })
  await page.waitForTimeout(1500)
  assert((await videoState(fs))?.paused === false, 'fullscreen viewer autoplays')
  const tf = (await videoState(fs)).t
  await page.keyboard.press('ArrowRight')
  await page.waitForTimeout(300)
  const sf = await videoState(fs)
  // the gallery may open the 6 s portrait clip: +10 s then lands at the end
  assert(sf.t >= Math.min(tf + 8, sf.d - 0.5), 'ArrowRight seeks in the viewer (focused on open)')
  // the viewer's own buttons fade with the player controls (only while
  // playing: the seek above may have run a short clip to its end)
  await page.keyboard.press('0')
  if ((await videoState(fs)).paused) await page.keyboard.press('k')
  const viewerButtons = () =>
    page.evaluate(() =>
      [...document.querySelectorAll('.btn-wrapper, .media-previous-button, .media-next-button')].map(
        (b) => getComputedStyle(b).opacity
      )
    )
  await page.mouse.move(640, 450)
  await page.mouse.move(5, 450)
  await page.waitForTimeout(2600)
  await shot('06-fullscreen-controls-hidden')
  const hiddenOps = await viewerButtons()
  assert(
    hiddenOps.length >= 2 && hiddenOps.every((o) => o === '0'),
    `viewer buttons fade with the controls (${hiddenOps})`
  )
  await page.mouse.move(640, 450)
  await page.waitForTimeout(400)
  await shot('07-fullscreen-hover')
  const shownOps = await viewerButtons()
  assert(shownOps.every((o) => o === '1'), 'viewer buttons come back on hover')

  // labels follow the app language: runtime-loaded Video.js pack (de)
  await page.evaluate(() => window.__rt.onChooseLanguage('de'))
  await page
    .locator(`${fs} .media-skin`)
    .getByRole('button', { name: 'Stummschalten' })
    .waitFor({ state: 'attached', timeout: 10_000 })
  assert(true, 'player labels switch to German with the app language')
  await page.evaluate(() => window.__rt.onChooseLanguage('en'))
  console.log('DONE')
} catch (err) {
  failed = true
  console.error('FAIL:', err.message)
  await page.screenshot({ path: `${SHOTS}/error.png` }).catch(() => {})
} finally {
  clearTimeout(watchdog)
  await browser.close().catch(() => {})
  cleanup()
  mock.close?.()
}
process.exit(failed ? 1 : 0)
