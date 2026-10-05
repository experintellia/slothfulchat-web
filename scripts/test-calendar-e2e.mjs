// E2E check for the calendar (core/0036 + desktop/0090) — runs FULLY OFFLINE.
// One webimap account against an in-process mock madmail server (trimmed from
// scripts/test-context-menu-e2e.mjs), two groups with events in them:
//
//   1. an .ics file sent as a plain attachment becomes a Calendar message: an
//      event card in the chat, and in the chat's calendar (chat-header
//      button), recurring weekly
//   2. the Files tab does not list it
//   3. Ctrl/Cmd+Shift+Y opens the all-chats calendar; its sidebar lists both
//      chats, and unticking one hides that chat's events
//   4. "New event" → pick a chat → fill the form → the sent event shows up,
//      in the agenda view too, and core has it
//   5. attachment menu → Event → the draft shows an event card; its edit
//      button reopens the form pre-filled and replaces the draft's event
//      (the message text stays); sending puts the edited card in the chat
//
// Requires packages/core-wasm built and packages/web-app assembled+built.
// Run:  node scripts/test-calendar-e2e.mjs
// (CHROMIUM_BIN=/path/to/chrome overrides the playwright-managed browser.)
import { createServer } from 'node:http'
import { randomBytes } from 'node:crypto'
import { chromium } from 'playwright'
import { startServers } from './harness.mjs'

const APP_PORT = Number(process.env.APP_PORT ?? 8679)

// --- mock madmail server (no mail ever arrives; just enough to configure) ---
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
    users.set(email, password)
    return json(res, 200, { email, password, dclogin_url: '' })
  }
  if (url.pathname.startsWith('/webimap/')) {
    const pw = users.get(req.headers['x-email'])
    if (!pw || pw !== req.headers['x-password']) {
      return json(res, 401, { error: 'bad credentials' })
    }
    if (url.pathname === '/webimap/mailboxes') {
      return json(res, 200, [{ name: 'INBOX', messages: 0, unseen: 0 }])
    }
    if (url.pathname === '/webimap/messages') {
      const wait = Math.min(Number(url.searchParams.get('wait') ?? '0') || 0, 25)
      setTimeout(() => json(res, 200, []), wait * 1000)
      return
    }
  }
  json(res, 404, { error: 'not found' })
})
await new Promise((r) => mock.listen(0, '127.0.0.1', r))
const QR = `webimapaccount:127.0.0.1:${mock.address().port}`

// The 10th of the current month, so it is always inside the month grid.
const now = new Date()
const ym = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}`
const ICS = [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'PRODID:-//test//test//EN',
  'BEGIN:VEVENT',
  'UID:kickoff@test',
  `DTSTART;TZID=Europe/Berlin:${ym}10T100000`,
  `DTEND;TZID=Europe/Berlin:${ym}10T110000`,
  'RRULE:FREQ=WEEKLY;COUNT=2',
  'SUMMARY:Kickoff',
  'LOCATION:Room 1',
  'END:VEVENT',
  'END:VCALENDAR',
  '',
].join('\r\n')

// --- web-app server ---
const { cleanup, watchdog } = await startServers({
  app: APP_PORT,
  settleMs: 700,
  watchdogMs: 300_000,
})

// --- browser ---
const launchOpts = process.env.CHROMIUM_BIN
  ? { executablePath: process.env.CHROMIUM_BIN }
  : {}
const browser = await chromium.launch(launchOpts)
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
page.on('pageerror', (e) => console.error('[pageerror]', e.message))
await page.addInitScript(() => {
  Object.defineProperty(window, 'eval', { value: window.eval, writable: false })
})
const rpc = (method, ...args) =>
  page.evaluate(([m, a]) => window.exp.rpc[m](...a), [method, args])
const check = (ok, what) => {
  if (!ok) throw new Error(`FAIL: ${what}`)
  console.log(`OK: ${what}`)
}
const dialog = page.getByTestId('media-view-dialog')
const chip = (title) => dialog.locator(`button[title="${title}"]`)

let failed = false
try {
  await page.goto(`http://localhost:${APP_PORT}/main.html`)
  await page.waitForFunction(() => window.__coreSystemInfo, null, { timeout: 120_000 })

  let aliceId = await rpc('addAccount')
  await rpc('addTransportFromQr', aliceId, QR)
  await rpc('setConfig', aliceId, 'displayname', 'Alice')
  for (const id of await rpc('getAllAccountIds')) {
    if (id !== aliceId) await rpc('removeAccount', id)
  }
  await rpc('selectAccount', aliceId)
  await page.reload()
  await page.waitForFunction(() => window.__coreSystemInfo, null, { timeout: 120_000 })

  // Seed AFTER the reload (see test-context-menu-e2e.mjs).
  ;[aliceId] = await rpc('getAllAccountIds')
  const teamId = await rpc('createGroupChat', aliceId, 'Team', false)
  const familyId = await rpc('createGroupChat', aliceId, 'Family', false)
  const icsPath = await page.evaluate(
    (b64) => window.exp.runtime.writeTempFileFromBase64('invite.ics', b64),
    Buffer.from(ICS).toString('base64')
  )
  await rpc('sendMsg', aliceId, teamId, {
    file: icsPath,
    filename: 'invite.ics',
    viewtype: 'File',
    text: 'see you there',
  })
  const day = (d) => Date.UTC(now.getFullYear(), now.getMonth(), d) / 1000
  const picnic = await rpc('makeCalendarIcs', {
    summary: 'Picnic',
    start: day(12),
    end: day(13),
    allDay: true,
  })
  const picnicPath = await page.evaluate(
    (text) => window.exp.runtime.writeTempFile('picnic.ics', text),
    picnic
  )
  await rpc('sendMsg', aliceId, familyId, {
    file: picnicPath,
    filename: 'picnic.ics',
    viewtype: 'Calendar',
  })

  // 1. event card in the chat, then the chat calendar from the chat header
  await page.locator('.chat-list-item', { hasText: 'Team' }).click()
  const bubble = page.locator('.message', { hasText: 'see you there' })
  await bubble.waitFor({ timeout: 30_000 })
  check(
    await bubble.getByRole('button', { name: /Kickoff/ }).isVisible(),
    'the .ics message shows as an event card'
  )
  check(!(await bubble.getByText('invite.ics').isVisible()), 'not as a file')
  await page.getByRole('button', { name: 'Calendar', exact: true }).click()
  await chip('Kickoff').first().waitFor({ state: 'visible', timeout: 30_000 })
  check((await chip('Kickoff').count()) >= 1, 'chat calendar shows the .ics event')
  check(!(await chip('Picnic').isVisible()), "chat calendar hides other chats' events")

  // 2. Files tab without the .ics
  await dialog.getByRole('tab', { name: 'Files' }).click()
  await dialog.locator('.no-media-message').first().waitFor({ timeout: 10_000 })
  check(
    !(await dialog.getByText('invite.ics').isVisible()),
    'Files tab no longer lists the .ics'
  )
  await page.keyboard.press('Escape')
  await dialog.waitFor({ state: 'hidden' })

  // 3. all-chats calendar via keyboard, sidebar toggles
  await page.locator('body').click({ position: { x: 5, y: 5 } })
  await page.keyboard.press('Control+Shift+Y')
  await chip('Picnic').first().waitFor({ state: 'visible', timeout: 30_000 })
  check(await chip('Kickoff').first().isVisible(), 'all-chats calendar shows both chats')
  const teamToggle = dialog.locator('label', { hasText: 'Team' }).locator('input')
  await teamToggle.uncheck()
  check(!(await chip('Kickoff').first().isVisible()), 'unticking a chat hides its events')
  await teamToggle.check()

  // 4. new event through the UI
  await dialog.getByRole('button', { name: 'New event' }).click()
  await page
    .locator('dialog .chat-list-item', { hasText: 'Family' })
    .click({ timeout: 10_000 })
  await page.getByLabel('Title').fill('Dinner')
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  await chip('Dinner').first().waitFor({ state: 'visible', timeout: 30_000 })
  check(true, 'event created in the UI shows in the month view')
  await dialog.getByRole('radio', { name: 'Agenda' }).click()
  check(
    await dialog.getByRole('button', { name: /Dinner/ }).first().isVisible(),
    'agenda view lists it'
  )
  const events = await rpc('getCalendarEvents', aliceId, familyId, day(1), day(28))
  check(
    events.some((e) => e.summary === 'Dinner'),
    'core indexed the event sent from the UI'
  )

  await page.keyboard.press('Escape')
  await dialog.waitFor({ state: 'hidden' })

  // 5. attachment menu → Event → draft preview → send
  await page.locator('.chat-list-item', { hasText: 'Family' }).click()
  await page.getByTestId('open-attachment-menu').click()
  await page.getByTestId('attach-event').click()
  await page.getByLabel('Title').fill('Lunch')
  await page.getByLabel('Repeat').selectOption('WEEKLY')
  await page.getByRole('button', { name: 'Attach', exact: true }).click()
  const draftCard = page.locator('.attachment-quote-section', { hasText: 'Lunch' })
  await draftCard.waitFor({ timeout: 30_000 })
  check(true, 'the draft shows the event as a card')
  const composer = page.locator('#composer-textarea-non-edit')
  await composer.fill('lunch?')

  await page.getByTestId('edit-draft-event').click()
  check(
    (await page.getByLabel('Title').inputValue()) === 'Lunch' &&
      (await page.getByLabel('Repeat').inputValue()) === 'WEEKLY',
    'edit opens the form pre-filled with the draft event'
  )
  await page.getByLabel('Title').fill('Team lunch')
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await page
    .locator('.attachment-quote-section', { hasText: 'Team lunch' })
    .waitFor({ timeout: 30_000 })
  check((await composer.inputValue()) === 'lunch?', 'editing keeps the message text')
  await page.locator('.send-button').click()
  const sent = page.locator('.message', { hasText: 'lunch?' })
  await sent.waitFor({ timeout: 30_000 })
  check(
    await sent.getByRole('button', { name: /Team lunch/ }).isVisible(),
    'the sent draft shows the edited event as a card'
  )
  const all = await rpc('getCalendarEvents', aliceId, null, day(1), day(28) + 86400 * 40)
  check(
    all.some((e) => e.summary === 'Team lunch' && e.recurring) &&
      !all.some((e) => e.summary === 'Lunch'),
    'core indexed only the edited event'
  )

  console.log('PASS: calendar — message type, draft, indexing, views, sidebar, new event')
} catch (e) {
  failed = true
  console.error(e)
  await page.screenshot({ path: 'calendar-e2e-failure.png' }).catch(() => {})
} finally {
  clearTimeout(watchdog)
  await browser.close().catch(() => {})
  mock.close()
  cleanup()
}
process.exit(failed ? 1 : 0)
