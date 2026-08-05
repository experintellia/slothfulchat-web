// Migration-error device message e2e: an account whose database migration
// failed must say so, in its own device chat, instead of opening as if nothing
// happened.
//
// Core does not fail such an open on purpose — it keeps the half-migrated
// account open so a backup can still be taken out of it, records the error and
// returns success (vendor/core/src/sql.rs). Only `get_migration_error` tells
// the UI, so nothing asking means a broken account looks healthy and misbehaves
// later somewhere unrelated.
//
// Covers:
//   - a recorded migration error posts a device message into THAT account
//   - the sweep covers every account, not just the first one
//   - the text carries core's error, asks for a backup, and points at this
//     project's tracker rather than upstream's support
//   - the label is stable across boots — that is what makes core drop the
//     repeat (devmsglabels, vendor/core/src/chat.rs) instead of posting the
//     same warning again on every startup
//   - nothing blocks the app (the recovery is exporting a backup, which a
//     blocking dialog would prevent)
//   - a healthy core posts nothing (or the checks above would pass vacuously)
//
// No proxy and no core boot: a stub worker answers the jsonrpc calls and
// records the device messages, exactly as test-fatal-dialog.mjs stubs the
// worker's fatal messages.
import { chromium } from 'playwright'
import { startServers, freezeEval } from './harness.mjs'

const APP_PORT = Number(process.env.APP_PORT ?? 8657)

const { cleanup } = await startServers({ app: APP_PORT })

const browser = await chromium.launch(
  process.env.CHROMIUM_BIN ? { executablePath: process.env.CHROMIUM_BIN } : {}
)
const url = `http://localhost:${APP_PORT}/main.html`

// core's own wording for a failed migration, shortened
const CORE_ERROR = 'Updating Delta Chat failed. sql: no such column: key_contacts'

/** A worker that speaks just enough jsonrpc to answer the startup sweep, and
 * remembers the device messages it was asked to add.
 * `brokenAccount` = which account id reports a migration error (0 = none). */
const stubWorker = brokenAccount => `
  self.__deviceMessages = []
  self.onmessage = e => {
    if (typeof e.data !== 'string') return           // fs side channel
    const m = JSON.parse(e.data)
    if (m.id == null) return                          // notification
    let result = null
    if (m.method === 'get_all_account_ids') result = [1, 2]
    else if (m.method === 'get_migration_error')
      result = m.params[0] === ${brokenAccount} ? ${JSON.stringify(CORE_ERROR)} : null
    else if (m.method === 'add_device_message') {
      self.__deviceMessages.push(m.params)
      result = 1                                      // the new message's id
    }
    self.postMessage(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }))
  }
`

async function run(brokenAccount) {
  const ctx = await browser.newContext({ serviceWorkers: 'block' })
  const page = await ctx.newPage()
  await freezeEval(page)
  await page.route('**/core/worker.js', route =>
    route.fulfill({ contentType: 'text/javascript', body: stubWorker(brokenAccount) })
  )
  await page.goto(url, { waitUntil: 'domcontentloaded' })
  return { ctx, page }
}

/** The migration-error `add_device_message` calls the stub worker has been sent
 * so far — read out of the worker itself, the only place that sees the rpc.
 *
 * Matched by core's error text, not by the label: the frontend adds its own
 * device messages (upstream's changelog one) through the same rpc, and the
 * label is one of the things under test, so it cannot also be the filter. */
async function migrationMessages(page, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const worker = page.workers().find(w => w.url().includes('core/worker.js'))
    const calls = worker
      ? await worker.evaluate(() => self.__deviceMessages ?? []).catch(() => [])
      : []
    const ours = calls.filter(([, , msg]) => (msg?.text ?? '').includes(CORE_ERROR))
    if (ours.length || Date.now() > deadline) return ours
    await page.waitForTimeout(200)
  }
}

// --- 1) the second account's migration error is caught too -----------------
// Deliberately account 2: a check that only ever looked at the first id would
// pass against a one-account fixture and ship a sweep that stops too early.
let label
{
  const { ctx, page } = await run(2)
  const calls = await migrationMessages(page)
  if (calls.length !== 1) {
    throw new Error(`expected exactly one migration message, got ${JSON.stringify(calls)}`)
  }
  const [accountId, msgLabel, msg] = calls[0]
  if (accountId !== 2) {
    throw new Error(`the device message went to account ${accountId}, not the broken one (2)`)
  }
  console.log('OK: a recorded migration error posts a device message, on any account')

  // --- 2) it says what to do, and where to take it ------------------------
  const text = msg?.text ?? ''
  for (const phrase of ['backup', 'github.com/experintellia/slothfulchat-web']) {
    if (!text.includes(phrase)) {
      throw new Error(`the device message does not mention ${phrase}: ${text}`)
    }
  }
  // this fork's migration runs through our patch stack and our OPFS SQLite —
  // sending users to upstream support wastes their time and ours
  if (/support\.delta\.chat/.test(text)) {
    throw new Error(`the device message points at upstream support: ${text}`)
  }
  // device messages are plain text (RELEASING.md); markdown would show up as
  // literal punctuation
  if (/\[.+\]\(.+\)|\*\*/.test(text)) {
    throw new Error(`the device message contains markdown, which is not rendered: ${text}`)
  }
  console.log('OK: it asks for a backup and points at this project, in plain text')

  // --- 3) core's error text travels with it -------------------------------
  if (!text.includes('no such column: key_contacts')) {
    throw new Error(`the device message does not carry core's error text: ${text}`)
  }
  console.log("OK: the message carries core's own error text")

  // --- 4) nothing blocks the app ------------------------------------------
  // The way out of a failed migration is exporting a backup — from the app a
  // blocking dialog would have shut.
  const blocking = await page.evaluate(() =>
    [...document.querySelectorAll('dialog')].filter(d => d.open).map(d => d.id)
  )
  if (blocking.length) {
    throw new Error(`a migration error opened a blocking dialog: ${JSON.stringify(blocking)}`)
  }
  console.log('OK: the app is left usable, so the backup can still be exported')

  label = msgLabel
  await ctx.close()
}

// --- 5) the label is the same on the next boot -----------------------------
// Core drops a device message whose label was added before (devmsglabels), so a
// stable label is the whole of "posted once, not on every startup". A label
// carrying the error text or a timestamp would repost forever.
{
  const { ctx, page } = await run(2)
  const [[, secondLabel] = []] = await migrationMessages(page)
  if (secondLabel !== label) {
    throw new Error(
      `the device-message label changes between boots (${label} → ${secondLabel}) — ` +
        "core's dedupe cannot drop the repeat"
    )
  }
  console.log(`OK: the same label every boot (${label}), so core posts it once`)
  await ctx.close()
}

// --- 6) a healthy core is left alone ---------------------------------------
// Without this, every check above would also pass if the message were sent
// unconditionally.
{
  const { ctx, page } = await run(0)
  await page.waitForTimeout(4000)
  const calls = await migrationMessages(page, 0)
  if (calls.length) {
    throw new Error(
      `a migration message was posted without a migration error: ${JSON.stringify(calls)}`
    )
  }
  console.log('OK: no migration error, no device message')
  await ctx.close()
}

await browser.close()
cleanup()
console.log('\nmigration-error device message: all checks passed')
