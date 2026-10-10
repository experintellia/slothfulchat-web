// Screenshot + self-check harness for the clamped bio / group description
// (desktop/0091) — runs FULLY OFFLINE like scripts/shot-download-placeholder.mjs:
// an in-process mock madmail server provides two webimap accounts.
//
// "Hermes" is a bot whose bio lists all its commands; Alice imports its vCard,
// which carries the bio (NOTE). Alice also has a group whose long description
// is one paragraph without line breaks, so only measuring (not counting lines)
// can tell it overflows, and a group with a short description. The script
// opens the profile and both group dialogs and asserts that the long texts are
// clamped with a working Show more/Show less link, that a text replaced while
// expanded starts folded again, and that the short one gets no link.
// Shots (dialog crops, 2x) land in .cache/profile-description-shots/.
//
// Requires packages/core-wasm built and packages/web-app assembled+built.
// Run:  node scripts/shot-profile-description.mjs
// (CHROMIUM_BIN=/path/to/chrome overrides the playwright-managed browser.)
import { mkdir } from 'node:fs/promises'
import { chromium } from 'playwright'
import { freezeEval, logPanics, script, startServers } from './harness.mjs'
import { startMockMadmail } from './mock-madmail.mjs'

const SHOTS = script('../.cache/profile-description-shots/')
await mkdir(SHOTS, { recursive: true })
const APP_PORT = 8678
// .clamped in ProfileInfoHeader/styles.module.scss
const CLAMP_LINES = 8

const HERMES_BIO = `Hermes 🤖 your assistant on chatmail. Commands:
/help – show this list
/new – start a fresh conversation
/model – pick the model
/system – set a system prompt
/image – generate an image
/summarize – summarize the last messages
/translate – translate text
/remind – set a reminder
/weather – current weather for a city
/search – search the web
/stats – your usage
/settings – your preferences
/feedback – message the developer
/about – version and source code`

// One line of text that only wraps past CLAMP_LINES.
const TESTERS_DESCRIPTION =
  'Welcome to the SlothfulChat testers group 🦥 This is where we try the web ' +
  'build before a release goes out, and new builds land on the preview site ' +
  'first, so please give them a spin there. When you report a bug, say what ' +
  'you did step by step, what you expected and what happened instead, which ' +
  'browser and OS you used and whether it was installed as an app, and add a ' +
  'screenshot or screen recording if you can. Please keep the chat on topic: ' +
  'feature ideas are welcome, but move them to the issue tracker once they ' +
  'need a longer discussion.'

const mock = await startMockMadmail()
console.log(`mock madmail on 127.0.0.1:${mock.port}`)
const QR = `webimapaccount:127.0.0.1:${mock.port}`

const { cleanup, watchdog } = await startServers({
  app: APP_PORT,
  settleMs: 700,
  watchdogMs: 300_000,
})

const browser = await chromium.launch(
  process.env.CHROMIUM_BIN ? { executablePath: process.env.CHROMIUM_BIN } : {}
)
const page = await browser.newPage({
  viewport: { width: 1280, height: 900 },
  deviceScaleFactor: 2,
})
logPanics(page)
page.on('pageerror', e => console.error('[pageerror]', e.message))
await freezeEval(page)
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
  const hermesId = await setup('Hermes')
  await rpc('setConfig', hermesId, 'selfstatus', HERMES_BIO)
  const aliceId = await setup('Alice Weber')
  console.log(`OK: accounts alice=${aliceId} hermes=${hermesId}`)

  const [hermesContact] = await rpc(
    'importVcardContents',
    aliceId,
    await rpc('makeVcard', hermesId, [1])
  )
  if ((await rpc('getContact', aliceId, hermesContact)).status !== HERMES_BIO) {
    throw new Error("Hermes's vCard did not carry its bio")
  }
  await rpc('createChatByContactId', aliceId, hermesContact)
  console.log("OK: Alice has Hermes's bio")

  const group = async (name, description) => {
    const id = await rpc('createGroupChat', aliceId, name, false)
    await rpc('addContactToChat', aliceId, id, hermesContact)
    await rpc('setChatDescription', aliceId, id, description)
    return id
  }
  const SHORT_DESCRIPTION = 'Monthly meetups, first Thursday at 7.'
  await group('Book Club', SHORT_DESCRIPTION)
  const testersId = await group('SlothfulChat Testers', TESTERS_DESCRIPTION)

  // The accounts were created through the rpc escape hatch, so the UI is
  // still sitting on the onboarding dialog until a reload.
  await page.reload()
  await page
    .locator('#new-chat-button')
    .waitFor({ state: 'visible', timeout: 120_000 })
  if (!(await page.getByTestId(`selected-account:${aliceId}`).count())) {
    await page.getByTestId(`account-item-${aliceId}`).click()
    await page
      .getByTestId(`selected-account:${aliceId}`)
      .waitFor({ state: 'attached', timeout: 30_000 })
  }

  const openDialog = async (chatName, testId) => {
    await page
      .locator('.chat-list .chat-list-item')
      .filter({ hasText: chatName })
      .first()
      .click()
    await page.getByTestId('chat-info-button').click()
    const dialog = page.getByTestId(testId)
    await dialog.getByTestId('profile-description').waitFor({ timeout: 30_000 })
    return dialog
  }
  const closeDialog = async dialog => {
    await page.keyboard.press('Escape')
    await dialog.waitFor({ state: 'detached', timeout: 10_000 })
  }

  const link = dialog => dialog.getByRole('button', { name: /^Show (more|less)$/ })
  const measure = async dialog => {
    const desc = dialog.getByTestId('profile-description')
    const m = await desc.evaluate(e => ({
      lineHeight: parseFloat(getComputedStyle(e).lineHeight),
      clientHeight: e.clientHeight,
      scrollHeight: e.scrollHeight,
    }))
    const hasLink = (await link(dialog).count()) > 0
    return {
      ...m,
      link: hasLink ? (await link(dialog).textContent()).trim() : null,
      expanded: hasLink ? await link(dialog).getAttribute('aria-expanded') : null,
    }
  }
  const shot = async (dialog, name) => {
    await page.mouse.move(5, 5)
    await dialog.screenshot({ path: `${SHOTS}/${name}.png` })
    console.log(`shot: ${SHOTS}/${name}.png`)
  }
  const expect = (cond, msg) => {
    if (!cond) throw new Error(msg)
    console.log(`OK: ${msg}`)
  }

  // Long text: clamped to CLAMP_LINES with a Show more link, which expands it
  // and turns into Show less, which folds it back.
  const checkLong = async (chatName, testId, name) => {
    const dialog = await openDialog(chatName, testId)
    // the link appears once the dialog has opened and been measured
    await link(dialog).waitFor({ timeout: 10_000 })
    const collapsed = await measure(dialog)
    expect(
      collapsed.link === 'Show more' && collapsed.expanded === 'false',
      `${name}: long text shows a "Show more" link`
    )
    expect(
      Math.round(collapsed.clientHeight / collapsed.lineHeight) === CLAMP_LINES &&
        collapsed.scrollHeight > collapsed.clientHeight,
      `${name}: clamped to ${CLAMP_LINES} lines (${collapsed.clientHeight}px of ${collapsed.scrollHeight}px)`
    )
    await shot(dialog, `${name}-collapsed`)

    await dialog.getByRole('button', { name: 'Show more' }).click()
    const expanded = await measure(dialog)
    expect(
      expanded.link === 'Show less' &&
        expanded.expanded === 'true' &&
        expanded.clientHeight === collapsed.scrollHeight,
      `${name}: "Show more" reveals the whole text and turns into "Show less"`
    )
    await shot(dialog, `${name}-expanded`)

    await dialog.getByRole('button', { name: 'Show less' }).click()
    const again = await measure(dialog)
    expect(
      again.link === 'Show more' && again.clientHeight === collapsed.clientHeight,
      `${name}: "Show less" folds it back`
    )
    await closeDialog(dialog)
  }

  await checkLong('Hermes', 'view-profile-dialog', '01-bio')
  await checkLong('SlothfulChat Testers', 'view-group-dialog', '02-group')

  // A text replaced while expanded (edited, or updated by an event) starts
  // folded again: no "Show less" left under the now-short text, and the long
  // text, once back, is folded with its "Show more" again.
  const replaced = await openDialog('SlothfulChat Testers', 'view-group-dialog')
  await link(replaced).click()
  await replaced.getByRole('button', { name: 'Show less' }).waitFor()
  await rpc('setChatDescription', aliceId, testersId, SHORT_DESCRIPTION)
  await replaced
    .getByTestId('profile-description')
    .filter({ hasText: SHORT_DESCRIPTION })
    .waitFor({ timeout: 10_000 })
  await link(replaced).waitFor({ state: 'detached', timeout: 5_000 })
  console.log('OK: replaced while expanded: the new short text has no link')
  await rpc('setChatDescription', aliceId, testersId, TESTERS_DESCRIPTION)
  await replaced
    .getByRole('button', { name: 'Show more' })
    .waitFor({ timeout: 10_000 })
  console.log('OK: switched back: the long text returns folded with "Show more"')
  await closeDialog(replaced)

  const short = await openDialog('Book Club', 'view-group-dialog')
  // give the observer the chance to (wrongly) add a link
  await page.waitForTimeout(400)
  const s = await measure(short)
  expect(
    s.link === null && s.scrollHeight === s.clientHeight,
    'short description: no link, nothing hidden'
  )
  await shot(short, '03-short')
  await closeDialog(short)

  console.log('PASS: long bios and descriptions are clamped, short ones are not')
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
